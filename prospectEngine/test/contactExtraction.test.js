import assert from "node:assert/strict";
import crypto from "node:crypto";

import { config } from "../src/config.js";

import {
  createProvider,
} from "../src/parse/llm/provider.js";

import {
  classify,
  isContactSourceArchetype,
} from "../src/parse/archetype.js";

import {
  deterministicContactExtract,
  extractCompanyContacts,
} from "../src/parse/deterministic/contact.js";

import {
  markdownContactExtract,
} from "../src/parse/markdownContact.js";

import {
  normalizeRole,
  normalizeEmail,
  normalizePhone,
  splitName,
  computeContactConfidence,
  normalizeContact,
  dedupeContacts,
  keepDecisionMakers,
} from "../src/parse/contact.js";
import { isPlausibleName } from "../src/lib/names.js";

import {
  extractContactsFromPage,
  parseCompanyContacts,
  statusForConfidence,
} from "../src/parse/index.js";

import {
  appendRawPage,
} from "../src/storage/pgStore.js";

import {
  query,
  closePool,
} from "../src/storage/pg.js";

import {
  normalizeUrl,
} from "../src/lib/url.js";

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const TEAM_HTML = `
<html><head><title>Our Team | Acme</title></head><body>
<h1>Our Team</h1>
<div class="team-member">
  <h3>Jane Doe</h3>
  <span class="role">Chief Executive Officer</span>
  <a href="mailto:jane@acme.com">jane@acme.com</a>
  <a href="tel:+15551234567">Call</a>
</div>
</body></html>`;

const LEADERSHIP_HTML = `
<html><head><title>Leadership | Acme</title></head><body>
<h1>Leadership</h1>
<div class="leadership">
  <h2>John Smith</h2>
  <p class="title">Chief Technology Officer</p>
  <a href="mailto:john@acme.com">john@acme.com</a>
</div>
</body></html>`;

const FOUNDER_HTML = `
<html><head><title>Our Founders | Acme</title></head><body>
<h1>Our Founders</h1>
<div class="founder">
  <h3>Alice Johnson</h3>
  <span class="role">Co-Founder</span>
  <a href="mailto:alice@acme.com">alice@acme.com</a>
</div>
</body></html>`;

const ABOUT_HTML = `
<html><head><title>About | Acme</title></head><body>
<h1>About Acme</h1>
<div class="team">
  <h3>Carol White</h3>
  <span class="role">Founder & CEO</span>
  <a href="mailto:carol@acme.com">carol@acme.com</a>
</div>
</body></html>`;

const CONTACT_HTML = `
<html><head><title>Contact Us | Acme</title></head><body>
<h1>Contact Us</h1>
<p>Reach our sales team:</p>
<div class="person">
  <h3>Bob Brown</h3>
  <span class="role">VP of Sales</span>
  <a href="mailto:bob@acme.com">bob@acme.com</a>
  <a href="tel:+15559876543">Call</a>
</div>
</body></html>`;

const BLOG_HTML = `
<html><head><title>Our Latest Insights</title><meta name="author" content="David Lee"></head><body>
<h1>Our Latest Insights</h1>
<div class="byline">By David Lee, Head of Marketing</div>
<p>Some article body text.</p>
</body></html>`;

const SPARSE_TEAM_HTML = `
<html><head><title>Our Team</title></head><body>
<h1>Our Team</h1>
<p>We have a dedicated group of people who work hard every day.</p>
</body></html>`;

const PROSE_AS_CONTACT_HTML = `
<html><head><title>About our team</title></head><body>
<div class="team-member">
  <h3>Our motto is to be a proactive</h3>
  <span class="role">Collaborative and purpose-driven recruitment partner for our clients and candidates</span>
  <a href="mailto:info@example.com">Contact</a>
</div>
<div class="team-member">
  <h3>While we grow in numbers</h3>
  <span class="role">Senior recruitment partner</span>
  <a href="tel:+919876543210">Call</a>
</div>
</body></html>`;

function fakeJina({ markdown = null } = {}) {
  const calls = [];

  return {
    name: "jina",
    enabled: true,
    calls,
    async fetchMarkdown(url) {
      calls.push(url);
      return markdown;
    },
  };
}

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error.message}`);
  }
}

async function insertPage(url, html) {
  const normalized = normalizeUrl(url);

  const page = await appendRawPage({
    url: normalized.normalizedUrl,
    url_hash: sha256(normalized.normalizedUrl),
    domain: normalized.domain,
    source_type: "website",
    fetch_backend: "plain",
    status_code: 200,
    html,
    content_hash: sha256(html),
    fetched_at: new Date().toISOString(),
    parse_version: null,
    parsed_at: null,
  });

  // Reset parse_version so the page is treated as unparsed on every run,
  // keeping the persistence test idempotent across repeated executions.
  await query(
    `UPDATE raw_pages SET parse_version = NULL WHERE id = $1`,
    [page.id]
  );

  return page;
}

async function main() {
  const provider = createProvider(config);

  await test("LLM disabled / disabled provider", () => {
    assert.equal(config.llmEnabled, false);
    assert.equal(provider.name, "disabled");
  });

  await test("unusual semantic URLs classify to contact-source archetypes", () => {
    const x = "<html><title>x</title></html>";
    assert.equal(classify(x, "https://a.com/our-people"), "team_page");
    assert.equal(classify(x, "https://a.com/meet-the-team"), "team_page");
    assert.equal(classify(x, "https://a.com/leadership-team"), "team_page");
    assert.equal(classify(x, "https://a.com/management"), "team_page");
    assert.equal(classify(x, "https://a.com/founding-team"), "team_page");
    assert.equal(classify(x, "https://a.com/company/team"), "team_page");
    assert.equal(classify(x, "https://a.com/our-story"), "about_page");
    assert.equal(classify(x, "https://a.com/who-we-are"), "about_page");
    assert.equal(classify(x, "https://a.com/contact-us"), "contact_page");
    assert.ok(isContactSourceArchetype("team_page"));
    assert.ok(isContactSourceArchetype("contact_page"));
    assert.ok(isContactSourceArchetype("about_page"));
  });

  await test("team/people extraction (name, title, email, phone)", () => {
    const contacts = deterministicContactExtract("team_page", TEAM_HTML, "https://acme.com/team");
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].full_name, "Jane Doe");
    assert.equal(contacts[0].role_category, "ceo");
    assert.equal(contacts[0].email, "jane@acme.com");
    assert.equal(contacts[0].phone, "+15551234567");
  });

  await test("reject sentence fragments as people while accepting real names", () => {
    for (const fragment of [
      "Our motto is to be a proactive",
      "While we grow in numbers",
      "Collaborative and purpose-driven recruitment partner",
    ]) {
      assert.equal(isPlausibleName(fragment), false, fragment);
    }

    for (const name of ["Jane Doe", "Aarav Sharma", "Mary van Buren", "JANE DOE"]) {
      assert.equal(isPlausibleName(name), true, name);
    }

    const serviceMarkdown = [
      "Search Ads, Display Ads, YouTube Ads, remarketing, budget planning, optimisation and lead-generation-focused campaigns.",
      "Training modules covering SEO, SEM, SMM, Email Marketing, WhatsApp Marketing, Content Strategy and AI in Marketing",
      "Rhine Solar Limited | Digital Growth Journey",
      "Digital Marketing Mentor | Trainer & Consultant",
      "Managing Director | CEO",
      "Empowering Businesses | Enabling Growth",
      "LinkedIn Ads budget | Sales Navigator subscription, Premium subscription and third-party tools are separate from service fees.",
      "Hemant Kumar Sharma, Digital Marketing Consultant & Trainer",
    ].join("\n");
    assert.deepEqual(
      markdownContactExtract("about_page", serviceMarkdown, "https://example.in/about").map((c) => c.full_name),
      ["Hemant Kumar Sharma"],
    );

    const contacts = deterministicContactExtract(
      "team_page",
      PROSE_AS_CONTACT_HTML,
      "https://example.com/team",
    );
    assert.deepEqual(contacts, []);
  });

  await test("leadership extraction -> technology_leader", () => {
    const contacts = deterministicContactExtract("team_page", LEADERSHIP_HTML, "https://acme.com/leadership");
    assert.equal(contacts[0].full_name, "John Smith");
    assert.equal(contacts[0].role_category, "technology_leader");
  });

  await test("founder extraction -> cofounder", () => {
    const contacts = deterministicContactExtract("team_page", FOUNDER_HTML, "https://acme.com/founders");
    assert.equal(contacts[0].full_name, "Alice Johnson");
    assert.equal(contacts[0].role_category, "cofounder");
  });

  await test("about/company extraction -> founder", () => {
    const contacts = deterministicContactExtract("about_page", ABOUT_HTML, "https://acme.com/about");
    assert.equal(contacts[0].full_name, "Carol White");
    assert.equal(contacts[0].role_category, "founder");
  });

  await test("contact page extraction -> sales_leader", () => {
    const contacts = deterministicContactExtract("contact_page", CONTACT_HTML, "https://acme.com/contact-us");
    assert.equal(contacts[0].full_name, "Bob Brown");
    assert.equal(contacts[0].role_category, "sales_leader");
    assert.equal(contacts[0].phone, "+15559876543");
  });

  await test("blog author/byline extraction -> marketing_leader", () => {
    const contacts = deterministicContactExtract("blog_post", BLOG_HTML, "https://acme.com/blog/post");
    assert.equal(contacts[0].full_name, "David Lee");
    assert.equal(contacts[0].role_category, "marketing_leader");
  });

  await test("normalization (role, email, phone, name split)", () => {
    assert.equal(normalizeRole("Co-Founder"), "cofounder");
    assert.equal(normalizeRole("Founder & CEO"), "founder");
    assert.equal(normalizeRole("Chief Executive Officer"), "ceo");
    assert.equal(normalizeRole("VP of Sales"), "sales_leader");
    assert.equal(normalizeRole("Head of Marketing"), "marketing_leader");
    assert.equal(normalizeRole("Regional Director"), "executive");
    assert.equal(normalizeRole(""), null);

    assert.equal(normalizeEmail("Alice@Acme.com"), "alice@acme.com");
    assert.equal(normalizeEmail("not-an-email"), null);

    assert.equal(normalizePhone("+1 (555) 123-4567"), "+15551234567");
    assert.equal(normalizePhone("123"), null);

    assert.deepEqual(splitName("Jane Doe"), { first_name: "Jane", last_name: "Doe" });
    assert.deepEqual(splitName("Doe, Jane"), { first_name: "Jane", last_name: "Doe" });
  });

  await test("confidence and status handling", () => {
    const full = normalizeContact({ full_name: "Jane Doe", title: "CEO", email: "jane@acme.com" });
    assert.equal(full.confidence, 0.8);
    assert.equal(statusForConfidence(0.8), "pending");
    assert.equal(statusForConfidence(0.5), "review");

    const nameOnly = normalizeContact({ full_name: "Jane Doe" });
    assert.ok(nameOnly.confidence < 0.6);
    assert.equal(statusForConfidence(nameOnly.confidence), "review");

    const prose = normalizeContact({
      full_name: "While we grow in numbers",
      title: "Recruitment partner",
      phone: "+919876543210",
    });
    assert.equal(prose.full_name, "");
    assert.equal(prose.first_name, "");
    assert.equal(prose.confidence, 0.35);
  });

  await test("duplicate contact handling (merge by email preserves sources)", () => {
    const a = normalizeContact({ full_name: "Jane Doe", email: "jane@acme.com", title: "CEO", source_url: "https://a.com/team", page_id: 1 });
    const b = normalizeContact({ full_name: "Jane Doe", email: "jane@acme.com", title: "CEO", source_url: "https://a.com/about", page_id: 2 });

    const merged = dedupeContacts([a, b]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].email, "jane@acme.com");
    assert.deepEqual(merged[0].source_urls.sort(), ["https://a.com/about", "https://a.com/team"]);
    assert.deepEqual(merged[0].page_ids.sort(), [1, 2]);

    const variants = dedupeContacts([
      normalizeContact({ full_name: "Hemant Sharma" }),
      normalizeContact({ full_name: "Hemant K Sharma" }),
      normalizeContact({ full_name: "Dr. Hemant Kumar Sharma", title: "Digital Marketing Consultant" }),
      normalizeContact({ full_name: "Priya Sharma" }),
    ]);
    assert.deepEqual(variants.map((c) => c.full_name), ["Dr. Hemant Kumar Sharma", "Priya Sharma"]);

    const sharedLine = dedupeContacts([
      normalizeContact({ full_name: "Anil Mehta", title: "CEO", phone: "+912240001000", email: "info@acme.in" }),
      normalizeContact({ full_name: "Ritu Rao", title: "CFO", phone: "+912240001000", email: "info@acme.in" }),
    ]);
    assert.equal(sharedLine.length, 2);

    const chain = dedupeContacts([
      normalizeContact({ full_name: "Neha Kapoor Joshi", title: "Founder" }),
      normalizeContact({ full_name: "N Joshi", email: "neha@acme.in", title: "CEO" }),
      normalizeContact({ full_name: "Neha Joshi", email: "neha@acme.in" }),
    ]);
    assert.equal(chain.length, 1);

    const team = keepDecisionMakers([
      normalizeContact({ full_name: "Ashish Gupta", title: "Founder and CEO" }),
      normalizeContact({ full_name: "Rahul Jain", title: "Founder Director" }),
      normalizeContact({ full_name: "Saurabh Kaushik", title: "Business Coach and Life Strategist" }),
      normalizeContact({ full_name: "Sunita Biddu" }),
      normalizeContact({ full_name: "James Marque", title: "Font-end Developer" }),
      normalizeContact({ full_name: "Eli Lovelence", title: "Content Writter" }),
      normalizeContact({ full_name: "Bhavesh Agarwal", title: "Sales Project Manager" }),
    ]);
    assert.deepEqual(team.map((c) => c.full_name), ["Ashish Gupta", "Rahul Jain", "Saurabh Kaushik", "Sunita Biddu", "Bhavesh Agarwal"]);
    assert.equal(isPlausibleName("BW Reporters"), false);
  });

  await test("LinkedIn profile links become contacts; company page goes on the company", () => {
    const html = `<html><body>
      <div class="team-member"><h3>Priya Nair</h3><p>Founder &amp; CEO</p>
        <a href="https://in.linkedin.com/in/priya-nair-12ab?trk=x">LinkedIn</a></div>
      <div class="team-member"><a aria-label="Call Henrik Anderberg" href="tel:+46123456789"></a></div>
      <footer><a href="https://www.linkedin.com/in/sandeep-thakur-acmeco/">Follow</a>
        <a href="https://www.linkedin.com/company/acmeco/">Company</a></footer>
    </body></html>`;
    const contacts = deterministicContactExtract("team_page", html, "https://acmeco.in/team");
    const byName = Object.fromEntries(contacts.map((c) => [c.full_name, c]));
    assert.deepEqual(Object.keys(byName).sort(), ["Henrik Anderberg", "Priya Nair", "Sandeep Thakur"]);
    assert.equal(byName["Sandeep Thakur"].profile_urls[0], "https://www.linkedin.com/in/sandeep-thakur-acmeco");
    assert.equal(
      extractCompanyContacts(html, "https://acmeco.in/team").linkedin_url,
      "https://www.linkedin.com/company/acmeco",
    );
  });

  await test("Tier 1 before Jina: rich page short-circuits (no Jina call)", async () => {
    const jina = fakeJina({ markdown: "Jane Doe, CEO - jane@acme.com" });
    const result = await extractContactsFromPage(
      { id: 42, url: "https://acme.com/team", html: TEAM_HTML },
      { provider, jina }
    );
    assert.equal(result.tier, "deterministic");
    assert.equal(jina.calls.length, 0);
    assert.equal(result.contacts[0].source_url, "https://acme.com/team");
    assert.ok(result.contacts[0].page_ids.includes(42));
  });

  await test("Jina called only when Tier 1 is insufficient", async () => {
    const jina = fakeJina({ markdown: "Jane Doe, CEO - jane@acme.com" });
    const result = await extractContactsFromPage(
      { id: 43, url: "https://acme.com/team", html: SPARSE_TEAM_HTML },
      { provider, jina }
    );
    assert.equal(jina.calls.length, 1);
    assert.equal(result.tier, "markdown");
    assert.equal(result.jinaUsed, true);
    assert.equal(result.markdownSource, "jina");
  });

  await test("markdown contact extraction (Jina markdown input)", () => {
    const contacts = markdownContactExtract(
      "team_page",
      "Jane Doe, Chief Executive Officer - jane@acme.com",
      "https://acme.com/team"
    );
    assert.ok(contacts.some((c) => c.email === "jane@acme.com"));
  });

  await test("provenance/page_id/source_url + raw_records(contact) persistence", async () => {
    const domain = "acmecontact.com";
    const teamPage = await insertPage("https://acmecontact.com/team", `
<html><head><title>Team</title></head><body>
<div class="team-member"><h3>Alice Anderson</h3><span class="role">Chief Executive Officer</span><a href="mailto:alice@acmecontact.com">Email</a><a href="tel:+15551112222">Call</a></div>
<div class="team-member"><h3>Bob Baker</h3><span class="role">VP of Sales</span><a href="mailto:bob@acmecontact.com">Email</a></div>
</body></html>`);

    const aboutPage = await insertPage("https://acmecontact.com/about", `
<html><head><title>About</title></head><body>
<div class="team"><h3>Alice Anderson</h3><span class="role">CEO</span><a href="mailto:alice@acmecontact.com">Email</a></div>
<div class="team"><h3>Carol Clark</h3><span class="role">Chief Technology Officer</span><a href="mailto:carol@acmecontact.com">Email</a></div>
</body></html>`);

    const summary = await parseCompanyContacts({
      domain,
      provider,
      jina: fakeJina({ markdown: null }),
      version: config.currentParseVersion,
    });

    assert.equal(summary.llmCalls, 0);
    assert.ok(summary.persisted >= 3, `expected >=3 contacts, got ${summary.persisted}`);

    const rows = (await query(
      `SELECT * FROM raw_records WHERE page_id = ANY($1::bigint[]) AND record_type = 'contact'`,
      [[teamPage.id, aboutPage.id]]
    )).rows;

    const alice = rows.find((r) => r.payload?.email === "alice@acmecontact.com");
    assert.ok(alice, "expected merged Alice record");
    assert.equal(alice.record_type, "contact");
    assert.equal(alice.payload.source_urls.length, 2);
    assert.equal(alice.payload.page_ids.length, 2);
    assert.ok([teamPage.id, aboutPage.id].includes(alice.page_id));
    assert.ok(alice.source_ref);
    assert.ok(Number(alice.confidence) >= 0.8);
    assert.equal(alice.status, "pending");
  });

  console.log("");
  const failed = results.filter((r) => !r.ok);
  console.log(`Passed ${results.length - failed.length}/${results.length}`);

  if (failed.length) {
    console.error(`Failed ${failed.length}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("Test run failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
