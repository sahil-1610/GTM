// Deterministic blocklist for relevance filtering.
//
// These are root domains that should never enter the prospect-company
// relevance queue because they are social/profile networks, search/content
// platforms, directories, data providers, media/news, job boards, review sites,
// marketplaces, communities, or generic information sources.
//
// Matching is by suffix so subdomains are blocked too:
//   linkedin.com
//   jobs.linkedin.com
//   blog.linkedin.com
//
// IMPORTANT:
// Do not add normal company domains here. This list is only for domains that
// should never be treated as the prospect company itself.

export const BLOCKED_DOMAINS = [
  // Social / profile networks
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "x.com",
  "twitter.com",
  "whatsapp.com",
  "wa.me",

  // Platforms, app stores and marketplaces
  "google.com",
  "apple.com",
  "amazon.com",
  "amazon.in",
  "flipkart.com",
  "wikipedia.org",
  "crunchbase.com",

  // Indian directories / company databases
  "justdial.com",
  "indiamart.com",
  "tradeindia.com",
  "sulekha.com",
  "tracxn.com",
  "zaubacorp.com",
  "tofler.in",

  // Agency / software directories and review platforms
  "clutch.co",
  "goodfirms.co",
  "g2.com",
  "capterra.com",
  "getapp.com",

  // Media / news / content publications
  "yourstory.com",
  "inc42.com",
  "indiatimes.com",
  "rediff.com",
  "entrepreneur.com",
  "theaisoftwarereport.com",

  // Job / recruiting platforms
  "wellfound.com",
  "glassdoor.com",
  "indeed.com",
  "naukri.com",
  "upwork.com",

  // Communities / user-generated content
  "reddit.com",
  "substack.com",
  "medium.com",
  "quora.com",

  // SaaS / startup community and discovery sources
  "saasboomi.org",
  "practicalfounders.com",
  "softwaresuggest.com",

  // Generic developer / document / information sources
  "geeksforgeeks.org",
  "scribd.com",
  "pdfcoffee.com",
  "theirstack.com",
  "sapstack.com",
  "erpresearch.com",
  "saurenergy.com",
  "insidesap.asia",
  "zoominfo.com",
  "builtwith.com",
  "6sense.com",
];

// Educational / government / institutional suffixes.
// These should not be treated as prospect-company domains.
const BLOCKED_SUFFIXES = [
  ".edu",
  ".gov",
  ".mil",
  ".ac.in",
  ".edu.in",
  ".gov.in",
  ".ac.uk",
  ".edu.au",
];

function normalizeHost(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

// True when the host is:
// 1. an explicitly blocked root domain or subdomain, OR
// 2. an educational/government/institutional domain suffix.
export function isBlockedDomain(domain) {
  const d = normalizeHost(domain);

  if (!d) {
    return false;
  }

  const blockedRoot = BLOCKED_DOMAINS.some(
    (blocked) =>
      d === blocked ||
      d.endsWith(`.${blocked}`),
  );

  if (blockedRoot) {
    return true;
  }

  return BLOCKED_SUFFIXES.some(
    (suffix) =>
      d.endsWith(suffix) ||
      d === suffix.slice(1),
  );
}

// Obvious listicle title patterns.
// These are rejected before any LLM call because they are usually
// "Top 10...", "Best companies...", rankings, comparison pages, etc.
const LISTICLE_TITLE_RE =
  /\b(?:top\s+\d+|best\s+\d+|list\s+of|lists?\s+of|rank(?:ing|ed)?|vs\.?|versus)\b/i;

const LISTICLE_TITLE_WORDS = [
  /\btop\s+\d+\b/i,
  /\bbest\s+\d+\b/i,
  /\b\d+\s+(?:best|top|leading|largest|biggest)\b/i,
  /\blists?\s+of\b/i,
  /\b\d+\s+companies\b/i,
  /\b\d+\s+(?:agencies|firms|vendors|providers|tools|platforms|software|solutions)\b/i,
  /\b(?:leading|largest|biggest)\s+(?:companies|agencies|firms|vendors|providers)\b/i,
];

// True when the title clearly looks like a listicle, ranking,
// comparison, or directory-style article.
export function isListicleTitle(title) {
  const text = String(title || "").trim();

  if (!text) {
    return false;
  }

  if (LISTICLE_TITLE_RE.test(text)) {
    return true;
  }

  return LISTICLE_TITLE_WORDS.some(
    (regex) => regex.test(text),
  );
}
