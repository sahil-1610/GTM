import { load } from "cheerio";

import { isContactArchetype } from "../archetype.js";

import {
  buildCompanyPayload,
  computeCompanyConfidence,
  domainFromUrl,
} from "../company.js";

import {
  extractCompanyContacts,
} from "./contact.js";

function clean(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstText($, selector) {
  return clean($(selector).first().text());
}

function companyNameFromTitle(title) {
  const parts = clean(title).split(
    /\s+\|\s+|\s+[–—-]\s+/
  );

  return parts.length > 1
    ? parts[parts.length - 1]
    : parts[0];
}

function resolveCompanyName($, url) {
  return (
    clean($('meta[property="og:site_name"]').attr("content")) ||
    clean($('meta[name="application-name"]').attr("content")) ||
    companyNameFromTitle($("title").first().text()) ||
    domainFromUrl(url)
  );
}

function resolveDescription($) {
  return (
    clean($('meta[name="description"]').attr("content")) ||
    clean($('meta[property="og:description"]').attr("content")) ||
    firstText($, "p")
  );
}

function extractCompanyFromDom($, url, html) {
  const companyName = resolveCompanyName($, url);
  const description = resolveDescription($);
  const bodyText = $("body").text();

  const companyContacts = extractCompanyContacts(
    html,
    url
  );

  const payload = buildCompanyPayload({
    companyName,
    description,
    text: bodyText,
    roleEmails: companyContacts.role_emails,
    companyPhones: companyContacts.company_phones,
    linkedinUrl: companyContacts.linkedin_url,
  });

  return {
    confidence: computeCompanyConfidence(payload),
    payload,
  };
}

export function deterministicExtract(archetype, html, url) {
  if (isContactArchetype(archetype)) {
    return null;
  }

  const $ = load(html || "");

  return extractCompanyFromDom($, url, html || "");
}
