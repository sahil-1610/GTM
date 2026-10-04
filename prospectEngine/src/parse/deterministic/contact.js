import { load } from "cheerio";

import {
  ROLE_HINT,
  dedupeContacts,
  isRoleEmail,
  normalizeContact,
  normalizePhone,
  parseNameTitleLine,
} from "../contact.js";

import {
  isPlausibleName,
  stripActionPrefix,
} from "../../lib/names.js";

// Specific card containers, matched by full class *token* (not substring) so
// that "team-member" is recognised but "steam", "teamwork", "biohazard" and
// similar false positives are not. Generic "lead"/"bio"/"profile"/"service"
// selectors are intentionally absent.
const CARD_SELECTOR = [
  "[class~='team']",
  "[class~='team-member']",
  "[class~='member']",
  "[class~='person']",
  "[class~='people']",
  "[class~='staff']",
  "[class~='leadership']",
  "[class~='founder']",
  "[class~='founders']",
  "[class~='executive']",
  "[class~='director']",
  "[class~='employee']",
  "[itemtype*='Person']",
].join(",");

const NAME_SELECTOR = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "[class~='name']",
  "[itemprop='name']",
].join(",");

const TITLE_SELECTOR = [
  "[class~='title']",
  "[class~='role']",
  "[class~='position']",
  "[class~='job-title']",
  "[class~='jobtitle']",
  "[class~='designation']",
  "[itemprop='jobTitle']",
].join(",");

const PROFILE_URL_RE =
  /(linkedin\.com|twitter\.com|x\.com|github\.com|crunchbase\.com)/i;

const AUTHOR_SELECTORS = [
  ".byline",
  ".author",
  ".post-author",
  ".article-author",
  ".author-name",
  "[rel='author']",
  "meta[name='author']",
];

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function collectPersonJsonLd(data, out = []) {
  if (Array.isArray(data)) {
    for (const item of data) {
      collectPersonJsonLd(item, out);
    }

    return out;
  }

  if (!data || typeof data !== "object") {
    return out;
  }

  const type = data["@type"];

  if (
    type === "Person" ||
    (Array.isArray(type) && type.includes("Person"))
  ) {
    out.push(data);
  }

  for (const value of Object.values(data)) {
    if (value && typeof value === "object") {
      collectPersonJsonLd(value, out);
    }
  }

  return out;
}

function extractPersonFromElement($, element, url) {
  const $el = $(element);

  let name = clean($el.find(NAME_SELECTOR).first().text());

  if (!name) {
    const aria =
      $el.attr("aria-label") ||
      $el.find("[aria-label]").first().attr("aria-label");

    name = clean(aria);
  }

  name = stripActionPrefix(name);

  let title = clean($el.find(TITLE_SELECTOR).first().text());

  if (!title) {
    let fallback = "";

    $el.find("p, span, div").each((_, el) => {
      const text = clean($(el).text());

      if (
        text &&
        text.length <= 60 &&
        ROLE_HINT.test(text)
      ) {
        fallback = text;
        return false;
      }
    });

    title = fallback;
  }

  let email = "";
  let phone = "";

  const mailto = $el.find("a[href^='mailto:']").first();
  const tel = $el.find("a[href^='tel:']").first();

  if (mailto.length) {
    email = clean(mailto.attr("href").replace(/^mailto:/i, ""));
  }

  if (tel.length) {
    phone = clean(tel.attr("href").replace(/^tel:/i, ""));
  }

  const profile_urls = [];

  $el.find("a[href]").each((_, a) => {
    const href = $(a).attr("href");

    if (href && PROFILE_URL_RE.test(href)) {
      profile_urls.push(cleanProfileUrl(href) || href);
    }
  });

  // A person requires a plausible name; role mailboxes never create people.
  if (!isPlausibleName(name)) {
    return null;
  }

  if (email && isRoleEmail(email)) {
    email = "";
  }

  if (!name && !email && !phone) {
    return null;
  }

  return {
    full_name: name,
    title,
    email,
    phone,
    profile_urls,
    source_url: url,
  };
}

function extractAuthorByline($) {
  for (const selector of AUTHOR_SELECTORS) {
    const el = $(selector).first();

    if (!el.length) {
      continue;
    }

    let text = clean(el.attr("content") || el.text());

    text = text.replace(/^(by|written by|author)\s*[:|-]?\s*/i, "");
    text = text.split(/\s+\|\s+|\s+[–—-]\s+/)[0];
    text = text.split(/\d{4}/)[0].trim();

    const parsed = parseNameTitleLine(text);

    if (parsed) {
      return parsed;
    }

    if (
      text &&
      text.length <= 80 &&
      !text.includes("@") &&
      isPlausibleName(text)
    ) {
      return { name: text, title: "" };
    }
  }

  return null;
}

function siteLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").split(".")[0].toLowerCase();
  } catch {
    return "";
  }
}

function cleanProfileUrl(href) {
  const match = String(href || "").match(/linkedin\.com\/in\/([^/?#]+)/i);
  return match ? `https://www.linkedin.com/in/${match[1].toLowerCase()}` : "";
}

// "/in/anurag-aggarwal-1a2b3c" -> "Anurag Aggarwal"; slugs without clear
// word breaks yield no name. A trailing brand word ("-webhopers") is dropped.
function nameFromLinkedInSlug(profileUrl, siteUrl) {
  const brand = siteLabel(siteUrl);
  const slug = decodeURIComponent(profileUrl.split("/in/")[1] || "");
  const words = slug
    .split("-")
    .filter((word) => /^[a-z]+$/i.test(word) && word.toLowerCase() !== brand);

  if (words.length < 2 || words.length > 4) {
    return "";
  }

  return words.map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

export function deterministicContactExtract(archetype, html, url) {
  const $ = load(html || "");
  const candidates = [];

  $("script[type='application/ld+json']").each((_, script) => {
    let data;

    try {
      data = JSON.parse($(script).html());
    } catch {
      return;
    }

    for (const person of collectPersonJsonLd(data)) {
      if (!isPlausibleName(person.name)) {
        continue;
      }

      candidates.push({
        full_name: person.name,
        title: person.jobTitle,
        email: isRoleEmail(person.email) ? "" : person.email,
        phone: person.telephone,
        profile_urls: person.url ? [person.url] : [],
        source_url: url,
      });
    }
  });

  // Process only leaf-most contact cards: a container that wraps other cards
  // is not itself a person, so we skip it and keep the inner cards only.
  const cardElements = [];

  $(CARD_SELECTOR).each((_, element) => {
    cardElements.push(element);
  });

  const leafCards = cardElements.filter(
    (element) => $(element).find(CARD_SELECTOR).length === 0,
  );

  const seen = new Set();

  for (const element of leafCards) {
    const person = extractPersonFromElement($, element, url);

    if (person) {
      candidates.push(person);
      seen.add(element);
    }
  }

  $("a[href^='mailto:'], a[href^='tel:']").each((_, anchor) => {
    if ($(anchor).parents(CARD_SELECTOR).length > 0) {
      return;
    }

    const container = $(anchor).closest("li, p, div, td, tr").first();
    const person = extractPersonFromElement(
      $,
      container.length ? container : anchor,
      url,
    );

    if (!person) {
      return;
    }

    const href = $(anchor).attr("href") || "";

    if (href.startsWith("mailto:")) {
      const email = href.slice(7);

      person.email = isRoleEmail(email) ? "" : email;
    }

    if (href.startsWith("tel:")) {
      person.phone = person.phone || href.slice(4);
    }

    if (!person.full_name) {
      const anchorText = clean($(anchor).text());

      if (
        anchorText &&
        !anchorText.includes("@") &&
        !/^\+?[0-9()\s.-]+$/.test(anchorText) &&
        isPlausibleName(anchorText)
      ) {
        person.full_name = anchorText;
      }
    }

    if (isPlausibleName(person.full_name)) {
      candidates.push(person);
    }
  });

  // Personal LinkedIn links outside cards, e.g. a founder's link in the footer.
  $("a[href*='linkedin.com/in/']").each((_, anchor) => {
    if ($(anchor).parents(CARD_SELECTOR).length > 0) {
      return;
    }

    const profileUrl = cleanProfileUrl($(anchor).attr("href"));
    const anchorText = clean($(anchor).text());
    const name = isPlausibleName(anchorText)
      ? anchorText
      : nameFromLinkedInSlug(profileUrl, url);

    if (profileUrl && isPlausibleName(name)) {
      candidates.push({
        full_name: name,
        title: "",
        email: "",
        phone: "",
        profile_urls: [profileUrl],
        source_url: url,
      });
    }
  });

  const author = extractAuthorByline($);

  if (author) {
    candidates.push({
      full_name: author.name,
      title: author.title || "",
      email: "",
      phone: "",
      profile_urls: [],
      source_url: url,
    });
  }

  return dedupeContacts(
    candidates
      .map((c) => normalizeContact(c))
      .filter((c) => isPlausibleName(c.full_name)),
  );
}

// Company-level contact info (role mailboxes + company phones) that must not
// be turned into person records.
export function extractCompanyContacts(html, url) {
  const $ = load(html || "");
  const roleEmails = new Set();
  const phones = new Set();

  $("a[href^='mailto:']").each((_, a) => {
    const email = clean($(a).attr("href").replace(/^mailto:/i, ""));

    if (isRoleEmail(email)) {
      roleEmails.add(email.toLowerCase());
    }
  });

  $("a[href^='tel:']").each((_, a) => {
    const phone = normalizePhone($(a).attr("href").replace(/^tel:/i, ""));

    if (phone) {
      phones.add(phone);
    }
  });

  const linkedin = String($("a[href*='linkedin.com/company/']").first().attr("href") || "")
    .match(/linkedin\.com\/company\/([^/?#]+)/i);

  return {
    role_emails: [...roleEmails],
    company_phones: [...phones],
    linkedin_url: linkedin ? `https://www.linkedin.com/company/${linkedin[1].toLowerCase()}` : "",
  };
}
