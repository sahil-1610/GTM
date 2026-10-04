# Prospect Engine — Quality Fixes PRD & Dev Plan

Sep 28, 2026 · @Sahil Tiwari

## Context & goal

Goal: make the Prospect Engine return qualified companies and real decision-makers, hitting at least 80% company precision and 90% contact precision on a labelled eval set, before any email verification or outreach work starts.

The pipeline stages already exist in `prospectEngine/`: query generation, SearXNG, URL filtering, Crawlee, Jina, company and contact extraction, dedup and PostgreSQL. What is blocking the BDA BOS use case is output quality: irrelevant websites get through, page labels and nav text are saved as people, and the same person appears several times.

This plan fixes quality inside the existing architecture. No stage is rebuilt. Email verification (Reacher) and personalised email generation come after the acceptance bar in this doc is met.

## Problem statement

Most of the noise comes from ten specific bugs, not from the design. Each row below maps to a task later in this doc.

| # | File | What happens today | Effect | Task |
| --- | --- | --- | --- | --- |
| 1 | `relevance/companyRelevance.js` | `fallbackRelevance()` returns `relevant: true`, and one failed batch `break`s the loop and approves every candidate | One flaky LLM call lets the whole result set through | A1 |
| 2 | `relevance/companyRelevance.js` | `EXCLUDED_DOMAINS.has(domain)` is an exact match with no Indian directories or media | `in.linkedin.com`, JustDial, IndiaMART, Tracxn, YourStory pass the filter | A2 |
| 3 | `relevance/companyRelevance.js` | Each URL is judged from title + snippet against the raw `userQuery`; the structured search plan is never used | Blogs, listicles and vendor pages get classified as companies | A3, A4 |
| 4 | `parse/deterministic/contact.js` | `CARD_SELECTOR` substring matches (`[class*='team']`, `[class*='lead']`) hit both the section wrapper and the cards inside it | Section headings like "Meet Our Team" become `full_name` | B1, B2 |
| 5 | `parse/deterministic/contact.js` | Title fallback takes the first `p/span/div` matching `ROLE_HINT` (which includes "product", "sales", "people") | Service paragraphs saved as job titles | B3 |
| 6 | `parse/deterministic/contact.js` | Loose `mailto:`/`tel:` anchors create a person; anchor text becomes the name | `info@` and "Contact Sales" become people | B4 |
| 7 | `parse/markdownContact.js`, `parse/contact.js` | `parseNameTitleLine` splits nav bars on `\|` and `,`; `PHONE_RE` matches `© 2012 - 2024` | "Home" saved as a person; years saved as phone numbers | B5, B6 |
| 8 | `parse/contact.js` | `computeContactConfidence` scores field presence, not validity | Junk with name + email + phone scores 0.8 and is promoted as `pending` | B7 |
| 9 | `parse/contact.js` `groupMatches` | Shared phone or role email is treated as identity | Different people merged into one record | C1 |
| 10 | `parse/contact.js` `dedupeContacts` | `groups.find` is not transitive; names only lowercased | Duplicates survive ("Dr. Rajesh K. Sharma" vs "Rajesh Sharma") | C2, C3 |

The existing tests all pass because every fixture is clean, single-card HTML. None of these bugs appear until the tests run on real pages, which is why Workstream 0 comes first.

## Scope and non-goals

In scope: relevance filtering, contact extraction, contact dedup, a company qualification gate, and an eval set to measure all of it.

Out of scope for this plan:

- Email verification (Reacher) and email pattern inference
- Personalised email generation and outreach
- The Next.js frontend
- Wiring GitHub or MCA enrichment into the pipeline
- Crawl scaling, proxies and queue hardening
- An LLM tier for contact extraction (deterministic fixes first; revisit only if contact recall is too low after Workstream B)

## Success metrics and acceptance bar

The plan is done when every metric below is met on the eval set from Workstream 0. Email verification work starts only after that.

| Metric | How it is measured | Target |
| --- | --- | --- |
| Company precision | Share of approved/qualified domains labelled "qualified" in `domains.csv` | 80% or more |
| Company recall | Share of labelled-qualified domains the engine approves | 60% or more (precision matters more for now) |
| Contact precision | Share of persisted contacts that are a real person with the correct title | 90% or more |
| Label-as-name errors | Headings, nav items or button text saved as `full_name` on fixtures | 0 |
| Role emails attached to a person | `info@`, `sales@`, `hr@` etc. on a person record | 0 |
| Duplicate rate | Same real person appearing more than once per domain | Under 2% |
| Wrong merges | Two different people merged into one record on fixtures | 0 |
| Fail-open leaks | Candidates auto-approved when the LLM provider fails | 0 |

## Workstream 0: eval set and real-page fixtures

Build this first, in the first two days: without it, every fix is a guess and regressions go unnoticed.

- [ ] **W0.1 Page fixtures.** Export 20 real pages from `raw_pages` of recent bad runs into `test/fixtures/pages/<name>.html`. Cover at least: a team section wrapping team-member cards, a footer with `info@` and a switchboard phone, a nav-heavy page, a contact page with a "Contact Sales" button, a blog post with a byline, an about page with founders in prose, a page with a `© 2012 - 2024` line, an Indian directory result (JustDial or IndiaMART), a page where two people share one phone, and a page with "Dr." / initials in names.
- [ ] **W0.2 Expected output.** For each page, write `test/fixtures/pages/<name>.expected.json`: the exact list of people (name, title, personal email if any) a human would extract. An empty list is a valid answer.
- [ ] **W0.3 Domain labels.** Create `test/fixtures/domains.csv` with 100 domains from recent SearXNG results: `domain,label,reason` where `label` is `qualified` or `not_qualified` and `reason` is one short word (`directory`, `media`, `wrong_industry`, `b2c`, `wrong_geo`, `ok`). Sahil or the dev labels these by hand.
- [ ] **W0.4 Eval script.** Add `test/eval.test.js` and `npm run test:eval`. It runs contact extraction on every page fixture and relevance + qualification on every labelled domain, then prints every metric from the acceptance table. It must run without network (use saved HTML and a fake or cached LLM provider).
- [ ] **W0.5 Baseline.** Run it on the current `main` and paste the numbers into this doc before changing any code.

Rule for all later tasks: every bug fix adds or updates a fixture that failed before the fix and passes after it.

Useful export query:

```sql
SELECT id, url, html FROM raw_pages WHERE domain = $1 ORDER BY id;
```

## Workstream A: relevance fixes

A1 and A2 are small and remove the biggest leaks; do them in week 1. A3 and A4 change how relevance is judged; do them in week 3 alongside Workstream D.

### A1. Fail closed when the LLM fails (P0)

File: `src/relevance/companyRelevance.js`.

- [ ] Change `fallbackRelevance()` to return `status: "review"` and `relevant: false`.
- [ ] Replace the `break` on a failed batch with: retry that batch once; if it fails again, mark only that batch's candidates as `review` and continue with the next batch.
- [ ] Return a new `review` array from `rankCandidates` alongside `approved` and `rejected`, and persist those candidates so nothing is silently lost.
- [ ] Update `test/relevance.test.js`: the "falls back when provider fails" test must now expect 0 approved and 2 in review.

```js
function fallbackRelevance(providerName, reasonCode) {
  return { status: "review", relevant: false, score: null, type: "unknown",
    reason_code: reasonCode, confidence: null, provider: providerName, model: null };
}
```

Acceptance: 0 fail-open leaks in eval; a provider that errors on batch 2 of 3 still returns batch 1 and 3 decisions.

### A2. Suffix-matched blocklist with Indian sites (P0)

- [ ] Move the list to a new file `src/relevance/blocklist.js` so it can grow without touching logic.
- [ ] Match by suffix, so subdomains are caught:

```js
export const BLOCKED = ["linkedin.com", "facebook.com", /* existing list */
  "justdial.com", "indiamart.com", "tradeindia.com", "sulekha.com", "tracxn.com",
  "zaubacorp.com", "tofler.in", "clutch.co", "goodfirms.co", "yourstory.com",
  "inc42.com", "indiatimes.com", "medium.com", "quora.com"];
export const isBlocked = (d) => BLOCKED.some((s) => d === s || d.endsWith(`.${s}`));
```

- [ ] Also reject by title pattern before the LLM: `/\b(top \d+|best \d+|list of|vs\.?|review)\b/i`, with `reason_code: "listicle"`.

Acceptance: `in.linkedin.com` and `m.facebook.com` are rejected in tests; every `directory` and `media` domain in `domains.csv` is rejected before any LLM call.

### A3. Judge domains, not URLs (P1)

- [ ] Before the LLM step, group accepted candidates by root domain. Send one entry per domain with up to 3 titles and snippets.
- [ ] Store one relevance decision per domain; every URL on that domain inherits it.

Acceptance: LLM calls per run drop roughly by the average URLs-per-domain; no domain gets two different decisions.

### A4. Use the search plan, and let code decide (P1)

- [ ] Change `rankCandidates({ userQuery, … })` to `rankCandidates({ searchPlan, … })` and put `industry`, `location`, `company_type`, `product_or_technology` and `relationship` into the prompt.
- [ ] Remove `score` from the LLM schema. The LLM returns facts only: `type`, `matches_industry` (bool), `matches_geo` (bool or `unknown`), `is_b2b` (bool or `unknown`), `reason_code`, `confidence`.
- [ ] Approval is decided in code: `type === "company"` and `matches_industry` and `matches_geo !== false` → approved; `confidence < 0.6` or any `unknown` → review; otherwise rejected, with the failing field stored as the reason.

Acceptance: the approval rule is a plain function with unit tests; company precision on `domains.csv` reaches 80% after A1–A4 plus Workstream D.

### A5. Mine listicles for seed domains (P2, optional)

Listicles and directories rejected in A2 often link out to real companies. Extract their outbound links, keep external root domains, and add them as new candidates with `source: "listicle"`.

## Workstream B: contact extraction fixes

The principle: a candidate must pass a validity gate before it is scored, and structure beats text. B1, B4, B5 and B7 are P0 for week 1; the rest follow in week 2.

### B1. Keep only leaf-most cards (P0)

File: `src/parse/deterministic/contact.js`.

- [ ] When iterating `$(CARD_SELECTOR)`, skip any element that contains another matching card:

```js
$(CARD_SELECTOR)
  .filter((_, el) => $(el).find(CARD_SELECTOR).length === 0)
  .each((_, element) => { /* existing extractPersonFromElement logic */ });
```

Acceptance: the nested team-section fixture yields only the people in the cards, never the section heading.

### B2. Tighten selectors (P1)

- [ ] Replace substring matches with class-token matches, so `lead` no longer hits `leading`, `lead-form` or `leaderboard`. Match class tokens against `/^(team|member|person|staff|founder|leader|executive|people)(-card|-item|-member)?$/i`.
- [ ] Remove `[class*='lead']`, `[class*='bio']` and `[class*='profile']` from `CARD_SELECTOR`.
- [ ] For `NAME_SELECTOR`, exclude `[class*='company-name']`, `[class*='username']` and `[class*='site-name']`.

### B3. Title fallback must be short (P1)

- [ ] The `ROLE_HINT` fallback only accepts an element whose own text is 60 characters or less and has no child block elements.

Acceptance: no fixture produces a title longer than 80 characters.

### B4. Role emails never create a person (P0)

- [ ] Add `isRoleEmail()` to `src/parse/contact.js`:

```js
const ROLE_LOCAL = /^(info|contact|sales|support|hello|hr|careers|jobs|admin|office|enquir(y|ies)|marketing|team|help|accounts|billing|no-?reply)$/i;
export const isRoleEmail = (e) => ROLE_LOCAL.test(String(e).split("@")[0]);
```

- [ ] In the loose `mailto:`/`tel:` block, only create a person if a plausible name (B5) is found in the same container. Never use anchor text as a name.
- [ ] Save role emails and company phones on the company record (new payload fields `company_emails` and `company_phones`) instead of as contacts.

Acceptance: 0 role emails on person records in eval.

### B5. Name validity gate (P0)

- [ ] Create `src/lib/names.js` with `isPlausibleName()` and use it in `normalizeContact`: a candidate with a failing name keeps no `full_name` and is dropped unless it has a personal email.

```js
const LABELS = /^(our team|meet the team|contact( us)?|read more|about( us)?|leadership|view profile|home|email|call)$/i;
export function isPlausibleName(s, companyName = "") {
  const t = String(s || "").replace(/^(mr|mrs|ms|dr|ca|er|prof)\.?\s+/i, "").trim();
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  if (/\d|@|http|&/.test(t) || LABELS.test(t) || ROLE_HINT.test(t)) return false;
  if (companyName && t.toLowerCase() === companyName.toLowerCase()) return false;
  return words.every((w) => /^[A-Z][a-zA-Z.'-]*$/.test(w));
}
```

Acceptance: 0 label-as-name errors on fixtures. Watch for one-word Indian names (for example "Ravi"); if they appear in `expected.json`, relax the two-word rule only when the candidate also has a title and a personal email.

### B6. Markdown parser fixes (P1)

File: `src/parse/markdownContact.js` and `parseNameTitleLine` in `src/parse/contact.js`.

- [ ] Skip any line with more than 2 separators (`|`, `–`, `—`, `,`); that is a nav bar or an address.
- [ ] Run the name side through `isPlausibleName`.
- [ ] Stop creating name-less candidates from lines that only have an email or phone.
- [ ] Tighten `PHONE_RE`: require a leading `+` or 10 or more digits, and reject matches that look like year ranges (`/^(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}$/`).

Acceptance: the nav-heavy and copyright fixtures produce no people and no phones.

### B7. Confidence measures validity, not completeness (P0)

- [ ] Rewrite `computeContactConfidence` in `src/parse/contact.js`:

```js
export function computeContactConfidence(c) {
  if (!isPlausibleName(c.full_name)) return 0.2;            // always review
  let s = 0.4;
  if (c.role_category && c.role_category !== "other") s += 0.3;
  if (c.email && !isRoleEmail(c.email)) s += 0.2;
  if (c.profile_urls?.length) s += 0.1;
  return Math.round(s * 100) / 100;
}
```

- [ ] Update the existing confidence tests to the new values (valid name + title + personal email = 0.9).
- [ ] Check `CONTACT_TIER1_THRESHOLD` (0.8) in `src/parse/index.js` still makes sense: a named person with a title but no email now scores 0.7 and will trigger Tier 2. That is intended.

### B8. Recover hidden emails (P2)

- [ ] Decode Cloudflare-protected emails (`data-cfemail` attribute, XOR with the first byte).
- [ ] Parse obfuscated forms like `name [at] domain [dot] com`.

These raise email recall without adding noise, so they come after the precision fixes.

## Workstream C: dedup fixes

Dedup must stop merging different people and must merge the same person reliably. All of C is week 2, after B, because B5 and B4 change what reaches dedup.

### C1. Only use keys that identify one person (P0)

File: `groupMatches` in `src/parse/contact.js`.

- [ ] Email is an identity key only if `!isRoleEmail(email)`.
- [ ] Phone is an identity key only if that phone appears on exactly one candidate in this domain's set. Count first, then match.
- [ ] Profile URL stays a key, but normalise it first (lowercase, strip query string and trailing slash).

Acceptance: the shared-phone fixture keeps two separate people; 0 wrong merges on fixtures.

### C2. One shared name normaliser (P0)

- [ ] Move `nameKey` from `src/dedup/crossSource.js` into `src/lib/names.js` and use it in both files.
- [ ] `nameKey` must: lowercase, fold accents, strip honorifics (Mr, Mrs, Ms, Dr, CA, Er, Prof), strip single-letter initials and punctuation, and collapse spaces. "Dr. Rajesh K. Sharma" and "Rajesh Sharma" both become `rajesh sharma`.
- [ ] Replace the lowercase-only name comparison in `groupMatches` with `nameKey(a) === nameKey(b)`.

### C3. Transitive merging (P1)

- [ ] Replace the `groups.find` loop in `dedupeContacts` with union-find: compare every pair, union on any strong key match, then merge each final set with the existing `mergeGroup`.
- [ ] Per-domain candidate counts are small (usually under 100), so the pairwise comparison is fine.

Acceptance: a fixture where contact C shares an email with A and a name with B produces one person.

### C4. Never merge across companies (P0)

- [ ] Confirm every call to `dedupeContacts` is scoped to one root domain (it is today via `parseCompanyContacts`; add a test so it stays that way).
- [ ] In `crossSource.js`, exact-name matches across different company domains must only create a review candidate, never an auto-merge.

Acceptance: duplicate rate under 2% and 0 wrong merges in eval.

## Workstream D: company qualification gate (Gate B)

Today every approved URL is crawled in depth. After this workstream, a domain gets one homepage crawl, a profile, and a code-made decision; only qualified domains get the deep crawl that feeds contact extraction.

&#91;embedded content: qualification flow · 2 gates, 1 decision in code\]

The LLM only extracts facts with evidence; `qualify()` is plain code, so every rejection has a readable reason and can be unit-tested.

- [ ] **D1. ICP config.** Create `src/icp/bda-bos.js` exporting `sells`, `sellsTo`, `geo`, `sizeCues`, `disqualify` and `targetTitles`. Sahil provides the values (see Open questions). The search plan from `queryGenerator.js` stays for building queries; the ICP file is what qualification checks against.
- [ ] **D2. Two-phase crawl.** In `src/crawl/crawlers.js` and `crawl_targets`, add a `phase` of `homepage` or `deep`. Approved domains get a `homepage` target only. A `deep` target (about, team, leadership, contact, careers) is enqueued only when qualification returns `qualified`.
- [ ] **D3. Profile extraction.** Wire the existing `src/extraction/companyExtractor.js` (built but not in the pipeline) onto the homepage. Extend its schema with `what_they_sell`, `sells_to` (`b2b`, `b2c`, `both`, `unknown`), `country`, `industry`, `team_size_hint` and `evidence` (short quotes). Drop any evidence quote that does not appear in the page text.
- [ ] **D4. `qualify(profile, icp)`.** New file `src/qualification/qualify.js`. Returns `{ status: "qualified" | "not_qualified" | "review", reasons: [] }`. Any `unknown` field, or no evidence, gives `review`; a failed check gives `not_qualified` with the field name as the reason. Unit-test every branch.
- [ ] **D5. Persist the decision.** New migration adding `qualification_status` and `qualification_reasons jsonb` to the company record (or `crawl_targets` if that is where the domain lives). Include both in the `/extract` API response and in `test:eval` output.

Acceptance: company precision reaches 80% on `domains.csv`; deep-crawl page count per run drops compared with the Workstream 0 baseline; every `not_qualified` domain has at least one reason.

## Roadmap

Four weeks of work for one developer, then a hard gate: email work starts only when every metric in the acceptance table is met.

&#91;embedded content: roadmap · 4 weekly phases and the acceptance gate\]

Week 1 carries the fixes with the biggest effect, so run `test:eval` at the end of week 1 and again at the end of each week; post the numbers in this doc. If the gate is not met after week 4, fix the worst-scoring metric first and re-run, rather than starting email work.

## Definition of done and PR checklist

One PR per task ID (for example "B4: role emails never create a person"). Small PRs are easier to review and to revert. Every PR must tick all of these:

- [ ] PR title starts with the task ID from this doc.
- [ ] At least one fixture or unit test that failed before the change and passes after it.
- [ ] All existing tests pass (`test:parse`, `test:contact`, `test:dedup`, `test:relevance`, `test:discovery`). Tests changed only because behaviour was meant to change, with a line in the PR explaining why.
- [ ] `npm run test:eval` numbers pasted in the PR description, before and after.
- [ ] No new hardcoded lists in logic files: blocklists, labels and role-email patterns live in their own modules.
- [ ] No LLM output used as a score or a decision; the LLM returns facts, code decides.
- [ ] Rejected or review items keep a `reason_code`; nothing is dropped silently.
- [ ] JavaScript (ESM), matching the existing codebase; no TypeScript.
- [ ] When stuck for more than half a day on a task, write the question as a comment on that task in this doc.

## Open questions for Sahil

- [ ] **BDA BOS ICP.** What BDA BOS sells, target industries, geography, company size range, and the titles to reach. Needed for D1 by the start of week 3.
- [ ] **Who labels the eval set?** 100 domains and 20 pages take about half a day; the dev can draft labels, but someone who knows the BOS customer should check them.
- [ ] **LLM budget per run.** A3 cuts calls, D3 adds one per homepage. Is there a per-run cap on Gemini spend?
- [ ] **Review queue owner.** Items marked `review` need a person to clear them. Who, and how often?
- [ ] **One-word names.** Are single-name contacts (common on Indian sites) worth keeping if they have a title and personal email, or should they always go to review?

## Stage 1: in-house prospect flow (Oct 4, 2026)

Rule: AI APIs (OpenAI) are allowed; search, data sources and crawling are our own. No paid or third-party search, data or fetch services (Jina stays off).

- [x] **S1. Multi-engine search.** Enable more SearXNG engines and rotate them per query so no single engine gets rate-limited.
- [x] **S2. Directory mining.** Search results rejected as directories or listicles are crawled for the company websites they link to, and those go through relevance (PRD A5).
- [x] **S3. LinkedIn URLs, public only.** Store LinkedIn profile links found on company sites; for companies with no contacts, read name and headline from `site:linkedin.com/in` search snippets. No logged-in scraping.
- [ ] **S4. Own browser crawler.** Crawl limit raised to 40 companies × 8 pages (done). Playwright fallback deferred: only 1 of ~290 stored real pages was a JavaScript shell. Sites that block us (403) are skipped, not evaded.
- [x] **S5. Dedup fixes.** Shared phone or role email is not identity (C1); merging is transitive (C3).
- [ ] **S6. Eval set.** `test/fixtures/domains.csv` drafted with 126 labelled domains (`checked=no`), waiting for human review. Baseline discovery precision 0.50, recall 0.82. Real-page fixtures and wiring into `test:eval` still to do.
- [x] **S7. Company size.** Search plan carries `company_size`; relevance rejects well-known large enterprises when the target is small.
- [x] **S8. Post-crawl qualification (D3).** One company record per domain. The LLM extracts facts from the homepage plus up to two about/services pages (name, business type, B2B/B2C, country, size bucket, operating company, matching ICP types, supporting quotes); quotes not found on the page are dropped. `qualifyProfile` decides in code. On 20 stored domains: every large firm, the courier, the overseas SaaS and the marketplace were rejected; 7 small Indian consultancies qualified.
- [x] **S9. Contacts at qualified companies.** The homepage profile also returns founders and leaders named on the pages; each must come with a quote that contains the name and appears on the page. A solo personal-brand site gives its owner. These merge with site-parsed contacts in the same dedup.
