// Shared person-name helpers. Extraction and cross-source dedupe both use
// these so they agree on what counts as a real person name and how names
// normalize, instead of each layer keeping its own slightly-different rules.

const NAV_LABELS = new Set([
  "home",
  "about",
  "about us",
  "contact",
  "contact us",
  "team",
  "our team",
  "meet the team",
  "leadership",
  "careers",
  "jobs",
  "services",
  "products",
  "solutions",
  "pricing",
  "login",
  "sign in",
  "sign up",
  "register",
  "menu",
  "search",
  "blog",
  "news",
  "privacy",
  "privacy policy",
  "terms",
  "terms of service",
  "faq",
  "faqs",
  "support",
  "help",
  "next",
  "previous",
  "back",
  "read more",
  "learn more",
  "view all",
  "get in touch",
  "subscribe",
  "follow us",
  "share",
  "email us",
  "call us",
  "phone",
  "address",
  "directions",
  "cookie policy",
  "sitemap",
  "accessibility",
]);

// Tokens that describe a job/function rather than a person's given name.
const ROLE_WORDS = new Set([
  "ceo",
  "cto",
  "cfo",
  "coo",
  "cmo",
  "cro",
  "cio",
  "cso",
  "founder",
  "cofounder",
  "co-founder",
  "director",
  "manager",
  "head",
  "lead",
  "chief",
  "executive",
  "officer",
  "president",
  "vp",
  "svp",
  "evp",
  "chair",
  "chairman",
  "chairperson",
  "partner",
  "principal",
  "engineer",
  "developer",
  "consultant",
  "specialist",
  "analyst",
  "coordinator",
  "administrator",
  "team",
  "department",
  "sales",
  "marketing",
  "support",
  "operations",
  "engineering",
  "finance",
  "human",
  "resources",
  "hr",
  "legal",
  "counsel",
  "communications",
  "revenue",
  "growth",
  "product",
  "design",
  "customer",
  "success",
]);

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "for",
  "by",
  "with",
  "in",
  "on",
  "to",
  "from",
  "our",
  "their",
  "his",
  "her",
  "we",
  "us",
  "is",
  "are",
  "am",
  "be",
  "been",
  "being",
  "was",
  "were",
  "while",
  "when",
  "where",
  "what",
  "which",
  "who",
  "that",
  "this",
  "these",
  "those",
  "it",
  "you",
  "your",
  "they",
  "them",
  "can",
  "will",
  "would",
  "could",
  "should",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "not",
  "as",
  "at",
  "our",
  "grow",
  "numbers",
  "motto",
  "proactive",
  "collaborative",
  "purpose",
  "driven",
  // Button and link verbs that prefix names in contact cards ("Call Jane Doe").
  "call",
  "email",
  "mail",
  "message",
  "connect",
  "follow",
  "visit",
  "view",
  "meet",
  "linkedin",
]);

// Lowercase particles are common inside names, while lowercase sentence
// fragments are not. Suffixes and initials are also valid name components.
const NAME_PARTICLES = new Set([
  "da", "de", "del", "della", "der", "di", "dos", "du", "la", "le",
  "san", "st", "van", "von",
]);
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

const ORG_WORDS = new Set([
  "limited", "ltd", "pvt", "private", "llp", "llc", "inc", "corp", "corporation",
  "company", "group", "foundation", "technologies", "solutions", "services", "agency",
]);

// Button labels such as "Call Jane Doe" or "Email Jane Doe" carry the name.
export function stripActionPrefix(raw) {
  return String(raw || "")
    .trim()
    .replace(/^(call|email|e-mail|mail|message|connect with|follow|meet|view|visit)\s+/i, "");
}

export function nameKey(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(mr|mrs|ms|dr|ca|er|prof)\s+/, "")
    .split(" ")
    .filter((token) => token.length > 1)
    .join(" ");
}

// Within one company, the same first and last name is the same person even
// when one source adds a middle name ("Hemant Kumar Sharma").
export function firstLastKey(name) {
  const parts = nameKey(name).split(" ").filter(Boolean);
  return parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1]}` : "";
}

function tokens(name) {
  return nameKey(name)
    .split(" ")
    .filter((token) => token.length >= 2);
}

// Job/function words never appear in a real name, so any one of them marks a
// heading or service label such as "Digital Marketing Mentor".
function hasRoleWord(name) {
  return tokens(name).some((word) => ROLE_WORDS.has(word));
}

// Whether a text fragment looks like a person's name (as opposed to a nav
// label, button, section heading, job title, email, URL or phone fragment).
export function isPlausibleName(raw) {
  const name = String(raw || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(mr|mrs|ms|dr|ca|er|prof)\.?\s+/i, "")
    .replace(/\b([A-Za-z])\./g, "$1");

  if (!name) {
    return false;
  }

  const lower = name.toLowerCase();

  if (NAV_LABELS.has(lower)) {
    return false;
  }

  if (name.length > 60) {
    return false;
  }

  // Emails, URLs, file paths and similar structural tokens are never names.
  if (/[@:/\\]/.test(name)) {
    return false;
  }

  // Names should be a short sequence of name-like words. Requiring multiple
  // capitalized tokens rejects sentence fragments such as "While we grow in
  // numbers" without rejecting all-caps data or lowercase name particles.
  if (/[.!?;:]/.test(name)) {
    return false;
  }

  const parts = name.replace(/,/g, " ").split(/\s+/).filter(Boolean);

  if (parts.length < 2 || parts.length > 5) {
    return false;
  }

  const normalizedParts = parts.map((part) =>
    part.replace(/^["'’([{]+|["'’)\]}]+$/g, "").replace(/[.,]$/g, "").toLowerCase()
  );

  if (normalizedParts.some((part) => STOP_WORDS.has(part))) {
    return false;
  }

  const nameWord = /^[A-Za-z][A-Za-z'’.-]*$/;

  if (parts.some((part) => !nameWord.test(part))) {
    return false;
  }

  const nameParts = parts.filter((part, index) => {
    const word = normalizedParts[index];
    return !NAME_PARTICLES.has(word) && !NAME_SUFFIXES.has(word);
  });

  if (nameParts.length < 2 || nameParts.some((part) => !/^[A-Z]/.test(part))) {
    return false;
  }

  if (normalizedParts.some((part) => ORG_WORDS.has(part))) {
    return false;
  }

  // Reject fragments that are mostly digits/dates (phone or year ranges).
  if (/\d/.test(name)) {
    return false;
  }

  if (hasRoleWord(name)) {
    return false;
  }

  // At least two tokens must look like real name words, not just particles.
  const meaningful = tokens(name).filter(
    (word) => !STOP_WORDS.has(word) && !NAME_PARTICLES.has(word) && !NAME_SUFFIXES.has(word)
  );

  return meaningful.length >= 2;
}
