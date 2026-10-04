import {
  config,
} from "./config.js";

import {
  createFactsProvider,
  createProvider,
} from "./parse/llm/provider.js";

import {
  createJinaClient,
} from "./parse/jina.js";

import {
  parseCompanyContacts,
} from "./parse/index.js";

import {
  classify,
} from "./parse/archetype.js";

import {
  getRawPagesForParse,
  insertRawRecord,
  markRawPageParsed,
} from "./storage/pgStore.js";

import {
  deterministicExtract,
} from "./parse/deterministic/index.js";

import {
  extractCompanyContacts,
} from "./parse/deterministic/contact.js";

import {
  computeCompanyConfidence,
  emptyCompanyPayload,
} from "./parse/company.js";

import {
  extractCompanyProfile,
  pickProfilePages,
} from "./extraction/companyExtractor.js";

import {
  qualifyProfile,
  targetTypesFor,
} from "./qualification/qualify.js";

import {
  statusForConfidence,
} from "./parse/index.js";

import {
  contactPayload,
  dedupeContacts,
  keepDecisionMakers,
  normalizeContact,
  parseNameTitleLine,
} from "./parse/contact.js";

import {
  findLinkedInPeople,
} from "./sources/searxng/index.js";

// Search lookups per run for companies whose own site listed nobody.
const MAX_LINKEDIN_LOOKUPS = 15;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistLinkedInPeople({ domain, companyName, location, runId, icp }) {
  const people = await findLinkedInPeople({ companyName, location });
  const contacts = keepDecisionMakers(dedupeContacts(
    people
      .map((person) => ({ person, parsed: parseNameTitleLine(person.line) }))
      .filter(({ parsed }) => parsed)
      .map(({ person, parsed }) =>
        normalizeContact({
          full_name: parsed.name,
          title: parsed.title,
          profile_urls: [person.profileUrl],
          source_url: person.profileUrl,
          evidence: [person.snippet].filter(Boolean),
        }),
      ),
  ));

  for (const contact of contacts) {
    await insertRawRecord({
      source_type: "linkedin_search",
      source_ref: `https://${domain}/`,
      record_type: "contact",
      payload: contactPayload(contact),
      confidence: contact.confidence,
      status: statusForConfidence(contact.confidence),
      run_id: runId,
      product_id: icp?.id || null,
      product_name: icp?.name || null,
    });
  }

  return contacts.length;
}

function companyContactsFor(pages) {
  const roleEmails = new Set();
  const phones = new Set();
  let linkedinUrl = "";

  for (const page of pages) {
    const found = extractCompanyContacts(page.html, page.url);
    found.role_emails.forEach((email) => roleEmails.add(email));
    found.company_phones.forEach((phone) => phones.add(phone));
    linkedinUrl ||= found.linkedin_url;
  }

  return {
    role_emails: [...roleEmails],
    company_phones: [...phones],
    linkedin_url: linkedinUrl,
  };
}

// One company record per domain: facts from the homepage (plus about and
// services pages) come from the LLM, and qualifyProfile decides in code.
async function profileDomain({ domain, pages, factsProvider, targetTypes, searchPlan, icp, runId }) {
  const profilePages = pickProfilePages(pages);
  const home = profilePages[0];
  const extracted = await extractCompanyProfile({
    domain,
    pages: profilePages,
    provider: factsProvider,
    targetTypes,
  });

  let payload;
  let qualification;
  let people = [];

  if (extracted.ok) {
    const { profile } = extracted;
    payload = {
      ...emptyCompanyPayload(),
      company_name: profile.company_name,
      country: profile.country,
      headquarters: profile.city,
      industries: [profile.business_type].filter(Boolean),
      products_services: profile.offerings,
      company_description: profile.what_they_sell,
      business_type: profile.business_type,
      sells_to: profile.sells_to,
      company_size: profile.company_size,
      is_operating_company: profile.is_operating_company,
      matching_target_types: profile.matching_target_types,
      evidence: profile.evidence,
    };
    qualification = qualifyProfile({ profile, icp, searchPlan });
    people = profile.people
      .map((person) =>
        normalizeContact({
          full_name: person.name,
          title: person.title,
          source_url: home.url,
          page_id: home.id,
          evidence: [person.quote],
        }),
      )
      .filter((contact) => contact.full_name);
  } else {
    payload = deterministicExtract(classify(home.html, home.url), home.html, home.url)?.payload ||
      emptyCompanyPayload();
    qualification = { status: "review", reasons: [`profile extraction failed: ${extracted.error}`], evidence: [] };
  }

  payload = { ...payload, ...companyContactsFor(pages) };
  const confidence = computeCompanyConfidence(payload);

  await insertRawRecord({
    source_type: home.source_type || "website",
    source_ref: home.url,
    record_type: "company",
    payload,
    confidence,
    page_id: home.id,
    status: qualification.status === "qualified" ? "pending" : "review",
    qualification_status: qualification.status,
    qualification_reasons: [...qualification.reasons, ...qualification.evidence],
    run_id: runId,
    product_id: icp?.id || null,
    product_name: icp?.name || null,
  });

  return { companyName: payload.company_name, status: qualification.status, people };
}

export async function runExtraction({
  provider,
  factsProvider,
  jina,
  version =
    config.currentParseVersion,
  searchPlan = null,
  icp = null,
  runId = null,
  domains = null,
  limit = 5000,
} = {}) {
  const providerInstance =
    provider ??
    createProvider(config);

  const jinaInstance =
    jina ??
    createJinaClient(config);

  const rawPages =
    await getRawPagesForParse({
      parseVersion:
        version,
      limit,
    });

  //
  // Important:
  // When a discovery run supplies domains, only process pages from those
  // discovered domains. This prevents old database rows from contaminating
  // the current run.
  //
  const allowedDomains =
    domains instanceof Set
      ? domains
      : null;

  const pages =
    allowedDomains
      ? rawPages.filter(
          (page) =>
            allowedDomains.has(
              page.domain,
            ),
        )
      : rawPages;

  const pagesByDomain =
    new Map();

  for (const page of pages) {
    const domain =
      page.domain;

    if (
      !pagesByDomain.has(
        domain,
      )
    ) {
      pagesByDomain.set(
        domain,
        [],
      );
    }

    pagesByDomain
      .get(domain)
      .push(page);
  }

  const facts =
    factsProvider ??
    createFactsProvider(config);

  const targetTypes =
    targetTypesFor(icp, searchPlan);

  const qualifiedDomains =
    new Set();
  const companyNames =
    new Map();
  const contactCandidateDomains =
    new Set();
  const profilePeople =
    new Map();

  let companyRecords = 0;

  for (
    const [domain, domainPages] of
      pagesByDomain
  ) {
    const company =
      await profileDomain({
        domain,
        pages: domainPages,
        factsProvider: facts,
        targetTypes,
        searchPlan,
        icp,
        runId,
      });

    companyRecords += 1;

    if (company.companyName) {
      companyNames.set(domain, company.companyName);
    }

    profilePeople.set(domain, company.people);

    if (company.status === "qualified") {
      qualifiedDomains.add(domain);
    }

    if (company.status !== "not_qualified") {
      contactCandidateDomains.add(domain);
    }

    for (const page of domainPages) {
      await markRawPageParsed(page.id, version);
    }
  }

  const gateDeepCrawl =
    Boolean(searchPlan);

  let contactRecords = 0;
  let domainsProcessed = 0;
  let linkedinLookups = 0;

  for (
    const domain of
      pagesByDomain.keys()
  ) {
    if (gateDeepCrawl && !contactCandidateDomains.has(domain)) {
      continue;
    }

    const summary =
      await parseCompanyContacts({
        domain,

        provider:
          providerInstance,

        jina:
          jinaInstance,

        version,

        pages:
          pagesByDomain.get(
            domain,
          ),
        extraContacts:
          profilePeople.get(domain) || [],
        runId,
        icp,
      });

    contactRecords +=
      summary.persisted;

    if (
      !summary.persisted &&
      companyNames.has(domain) &&
      linkedinLookups < MAX_LINKEDIN_LOOKUPS
    ) {
      if (linkedinLookups > 0) {
        await sleep(config.searxngQueryDelayMs);
      }

      linkedinLookups += 1;
      contactRecords +=
        await persistLinkedInPeople({
          domain,
          companyName:
            companyNames.get(domain),
          location:
            searchPlan?.location || "",
          runId,
          icp,
        });
    }

    domainsProcessed += 1;
  }

  return {
    pagesProcessed:
      pages.length,

    companyRecords,

    domainsProcessed,

    contactRecords,

    linkedinLookups,

    qualifiedDomains: [
      ...qualifiedDomains,
    ],
  };
}
