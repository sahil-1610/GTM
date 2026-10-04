import { firstLastKey, isPlausibleName } from "../lib/names.js";

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const MAX_TITLE_LENGTH = 80;

// Role/group mailboxes that never represent an individual person. These must
// not create people and must not be used as a person's identity key.
const ROLE_EMAIL_LOCAL_RE =
  /^(info|information|sales|support|contact|contactus|contact-us|hr|humanresources|careers|career|jobs|recruitment|recruiting|hello|office|admin|administration|marketing|press|media|billing|accounts?|accounts?payable|enquir(y|ies)|inquir(y|ies)|reception|frontdesk|business|team|general|help|service|services|partners?|privacy|legal|security|webmaster|postmaster|no.?reply|donotreply|apply|applications|customercare|customerservice|feedback|complaints?|abuse|investors?|investorrelations|advertising|editorial|newsroom|corporate|headquarters|info@)/i;

function roleEmailLocalPart(email) {
  const value = String(email || "").trim().toLowerCase();

  if (!value || !value.includes("@")) {
    return null;
  }

  return value
    .split("@")[0]
    .replace(/[._+-]/g, "");
}

export function isRoleEmail(raw) {
  const local = roleEmailLocalPart(raw);

  if (!local) {
    return false;
  }

  return ROLE_EMAIL_LOCAL_RE.test(local);
}

// Signals that a text fragment reads like a job title. Used both to bucket
// roles and to decide whether a "name — title" split is actually a title.
export const ROLE_HINT =
  /\b(ceo|cto|cfo|coo|cmo|cro|cio|founder|co[- ]?founder|president|vice president|director|manager|lead|head|chief|engineer|developer|marketing|sales|operations|revenue|growth|product|design|analyst|specialist|consultant|partner|principal|chair|executive|officer|communications|finance|people|legal|counsel|human resources)\b/i;

// A free-text title needs a job noun; department words alone ("Enabling
// Growth", "Sales") are taglines or service names.
const JOB_TITLE_RE =
  /\b(ceo|cto|cfo|coo|cmo|cro|cio|vp|founder|co[- ]?founder|owner|president|director|manager|lead|head|chief|engineer|developer|analyst|specialist|consultant|partner|principal|chair(?:man|person)?|executive|officer|counsel|trainer|coach|advisor|adviser|associate|architect|designer|proprietor)\b/i;

// Decision-making roles. ROLE_RULES groups titles by function, so a
// "Front-end Developer" lands in technology_leader; this checks seniority.
const DECISION_MAKER_RE =
  /\b(founder|co[- ]?founder|founding|owner|proprietor|ceo|cto|cfo|coo|cmo|cro|cio|chief|president|vp|director|head|partner|principal|managing|chair(?:man|person)?|general manager|country manager|coach|consultant|mentor|advisor|adviser)\b/i;

// Keeps people who can buy: a title must name a decision-making role, and
// untitled people stay (their low confidence already sends them to review).
export function keepDecisionMakers(contacts) {
  return contacts.filter((contact) => !contact.title || DECISION_MAKER_RE.test(contact.title));
}

// Ordered most-specific-first so "co-founder" beats "founder" and a named
// C-level ("CEO") beats the generic "executive" bucket.
const ROLE_RULES = [
  ["cofounder", /\bco[- ]?founder\b/i],
  ["founder", /\bfounder\b|\bfounding\b/i],
  ["ceo", /\bceo\b|chief executive/i],
  ["technology_leader", /\bcto\b|chief technology|cio\b|chief information|engineering|engineer|software|technical|vp engineering|head of engineering/i],
  ["marketing_leader", /\bcmo\b|chief marketing|\bmarketing\b|brand|communications|public relations|growth marketing/i],
  ["revenue_leader", /\bcro\b|chief revenue|\brevenue\b|\bcommercial\b|chief growth|\bgrowth\b/i],
  ["sales_leader", /\bsales\b|business development|account executive|account manager|partnerships/i],
  ["operations_leader", /\bcoo\b|chief operating|\boperations\b|\bpeople\b|human resources|\bhr\b|\bfinance\b|cfo\b|chief financial|\blegal\b|\bcounsel\b|customer success|\bsupport\b|\boffice\b|\badministration\b/i],
  ["executive", /\bpresident\b|vice president|\bvp\b|chief|director|managing director|chair|board|\bpartner\b|\bprincipal\b|general manager|head of|\bexecutive\b|\bsvp\b|\bevp\b|\bsme\b|\bleader\b/i],
];

export function normalizeRole(title) {
  const text = String(title || "").trim();

  if (!text) {
    return null;
  }

  const lower = text.toLowerCase();

  for (const [category, pattern] of ROLE_RULES) {
    if (pattern.test(lower)) {
      return category;
    }
  }

  return "other";
}

export function normalizeEmail(raw) {
  const value = String(raw || "").trim().toLowerCase();

  return EMAIL_RE.test(value) ? value : null;
}

export function normalizePhone(raw) {
  const digits = String(raw || "").replace(/[^0-9+]/g, "");

  return digits.length >= 7 ? digits : null;
}

export function splitName(full) {
  const name = String(full || "").replace(/\s+/g, " ").trim();

  if (!name) {
    return { first_name: "", last_name: "" };
  }

  if (name.includes(",")) {
    const [last, first] = name.split(",").map((s) => s.trim());

    return {
      first_name: first || "",
      last_name: last || "",
    };
  }

  const parts = name.split(" ");

  if (parts.length === 1) {
    return { first_name: parts[0], last_name: "" };
  }

  return {
    first_name: parts.slice(0, -1).join(" "),
    last_name: parts[parts.length - 1],
  };
}

export function parseNameTitleLine(line) {
  const cleaned = String(line || "")
    .replace(/^[#>*\s•·-]+/, "")
    .trim();

  if (!cleaned) {
    return null;
  }

  const parts = cleaned.split(
    /\s+\|\s+|\s+[–—]\s+|\s*,\s*/
  );

  // More than two separators means a nav bar, address or comma-separated list.
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }

  const name = parts[0].trim();
  const title = parts.slice(1).join(" ").trim();

  // Questions and "Heading: subheading" lines are marketing copy, not titles.
  if (!name || !title || title.length > MAX_TITLE_LENGTH || /[?:!]/.test(title) || !JOB_TITLE_RE.test(title)) {
    return null;
  }

  if (!isPlausibleName(name)) {
    return null;
  }

  return { name, title };
}

export function computeContactConfidence(contact) {
  if (!contact) {
    return 0;
  }

  // Confidence measures validity, not field count: a person needs a plausible
  // name, and contact details only count when they are valid (a role mailbox
  // is not a person's email).
  let score = 0;

  if (contact.full_name && isPlausibleName(contact.full_name)) {
    score += 0.35;
  }

  if (contact.email && !isRoleEmail(contact.email)) {
    score += 0.25;
  }

  if (contact.phone) {
    score += 0.15;
  }

  if (contact.title) {
    score += 0.2;
  }

  return Math.round(Math.min(1, score) * 100) / 100;
}

export function normalizeContact({
  full_name = "",
  title = "",
  email = "",
  phone = "",
  profile_urls = [],
  source_url = "",
  page_id = null,
  evidence = [],
}) {
  const cleanName = isPlausibleName(full_name)
    ? String(full_name || "").trim()
    : "";
  const { first_name, last_name } = splitName(cleanName);

  const contact = {
    full_name: cleanName,
    first_name,
    last_name,
    title: String(title || "").trim(),
    role_category: normalizeRole(title),
    email: normalizeEmail(email),
    phone: normalizePhone(phone),
    profile_urls: [...new Set((profile_urls || []).filter(Boolean))],
    source_url: String(source_url || ""),
    source_urls: [...new Set([String(source_url || "")].filter(Boolean))],
    page_ids: page_id ? [page_id] : [],
    evidence: [...new Set((evidence || []).filter(Boolean))],
  };

  contact.confidence = computeContactConfidence(contact);

  return contact;
}

function profileKey(url) {
  return String(url || "").toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
}

// Keys that identify exactly one person. A phone counts only when no other
// candidate shares it, since switchboards and shared lines are not identity.
function identityKeys(contact, phoneCounts) {
  const keys = [];

  if (contact.email && !isRoleEmail(contact.email)) {
    keys.push(`email:${contact.email}`);
  }

  if (contact.phone && phoneCounts.get(contact.phone) === 1) {
    keys.push(`phone:${contact.phone}`);
  }

  const name = firstLastKey(contact.full_name);

  if (name) {
    keys.push(`name:${name}`);
  }

  for (const url of contact.profile_urls || []) {
    keys.push(`profile:${profileKey(url)}`);
  }

  return keys;
}

function pickBest(group) {
  return [...group].sort(
    (a, b) =>
      (b.confidence ?? 0) - (a.confidence ?? 0) ||
      Number(Boolean(b.full_name)) - Number(Boolean(a.full_name))
  )[0];
}

function mergeGroup(group) {
  const base = { ...pickBest(group) };

  const source_urls = [];
  const page_ids = [];
  const evidence = [];
  const profile_urls = [];

  for (const contact of group) {
    source_urls.push(...(contact.source_urls || []).filter(Boolean));
    page_ids.push(...(contact.page_ids || []));
    evidence.push(...(contact.evidence || []));
    profile_urls.push(...(contact.profile_urls || []));

    base.full_name ||= contact.full_name;
    base.first_name ||= contact.first_name;
    base.last_name ||= contact.last_name;
    base.title ||= contact.title;
    base.role_category ||= contact.role_category;
    base.email ||= contact.email;
    base.phone ||= contact.phone;
  }

  base.source_urls = [...new Set(source_urls)];
  base.page_ids = [...new Set(page_ids)];
  base.evidence = [...new Set(evidence)];
  base.profile_urls = [...new Set(profile_urls)];
  base.confidence = computeContactConfidence(base);

  return base;
}

// Deduplicates contacts within one company. Contacts sharing any identity key
// are merged transitively (union-find); fuzzy name matches are never merged.
export function dedupeContacts(contacts) {
  const phoneCounts = new Map();

  for (const contact of contacts) {
    if (contact.phone) {
      phoneCounts.set(contact.phone, (phoneCounts.get(contact.phone) || 0) + 1);
    }
  }

  const parent = contacts.map((_, index) => index);
  const find = (index) => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  const owner = new Map();

  contacts.forEach((contact, index) => {
    for (const key of identityKeys(contact, phoneCounts)) {
      if (owner.has(key)) {
        parent[find(index)] = find(owner.get(key));
      } else {
        owner.set(key, index);
      }
    }
  });

  const groups = new Map();

  contacts.forEach((contact, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) || []), contact]);
  });

  return [...groups.values()].map(mergeGroup);
}

export function contactPayload(contact) {
  return {
    full_name: contact.full_name,
    first_name: contact.first_name,
    last_name: contact.last_name,
    title: contact.title,
    role_category: contact.role_category,
    email: contact.email,
    phone: contact.phone,
    profile_urls: contact.profile_urls,
    source_url: contact.source_url || contact.source_urls?.[0] || "",
    source_urls: contact.source_urls || [],
    page_ids: contact.page_ids || [],
    evidence: contact.evidence || [],
  };
}
