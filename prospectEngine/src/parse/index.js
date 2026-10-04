import {
  classify,
  isContactArchetype,
  isContactSourceArchetype,
  recordTypeFor,
} from "./archetype.js";

import {
  deterministicExtract,
} from "./deterministic/index.js";

import {
  deterministicContactExtract,
} from "./deterministic/contact.js";

import {
  markdownContactExtract,
} from "./markdownContact.js";

import {
  htmlToMarkdown,
  markdownExtract,
} from "./markdown.js";

import {
  createJinaClient,
} from "./jina.js";

import {
  config,
} from "../config.js";

import {
  llmExtract,
} from "./llm/extract.js";

import {
  promptKeyFor,
} from "./prompts.js";

import {
  dedupeContacts,
  contactPayload,
} from "./contact.js";

import {
  getRawPagesForDomain,
  insertRawRecord,
  markRawPageParsed,
} from "../storage/pgStore.js";

import {
  qualifyCompany,
} from "../qualification/qualify.js";

const TIER1_THRESHOLD = 0.8;
const TIER2_THRESHOLD = 0.75;
const PROMOTE_THRESHOLD = 0.6;

export function statusForConfidence(confidence) {
  return confidence != null &&
    confidence >= PROMOTE_THRESHOLD
    ? "pending"
    : "review";
}

export async function extractPage(page, { provider, jina } = {}) {
  const archetype = classify(page.html, page.url);
  const recordType = recordTypeFor(archetype);

  if (isContactArchetype(archetype)) {
    return {
      archetype,
      recordType,
      deferred: true,
      tier: null,
      confidence: null,
      payload: null,
      provider: null,
      cached: false,
      notAttempted: false,
    };
  }

  const result = {
    archetype,
    recordType,
    deferred: false,
    tier: "deterministic",
    confidence: 0,
    payload: null,
    provider: null,
    cached: false,
    notAttempted: false,
  };

  const deterministic = deterministicExtract(
    archetype,
    page.html,
    page.url
  );

  if (deterministic) {
    result.confidence = deterministic.confidence;
    result.payload = deterministic.payload;
  }

  if (result.confidence >= TIER1_THRESHOLD) {
    return result;
  }

  // Tier 2: prefer Jina clean Markdown (cached, gated); fall back to a
  // local HTML-to-Markdown conversion when Jina is unavailable.
  const jinaClient = jina ?? createJinaClient(config);

  const jinaMarkdown = await jinaClient.fetchMarkdown(page.url);

  const markdown = jinaMarkdown
    ? jinaMarkdown
    : htmlToMarkdown(page.html);

  const markdownResult = markdownExtract(
    archetype,
    markdown,
    page.url
  );

  if (
    markdownResult &&
    markdownResult.confidence > result.confidence
  ) {
    result.tier = "markdown";
    result.markdownSource = jinaMarkdown ? "jina" : "local";
    result.confidence = markdownResult.confidence;
    result.payload = markdownResult.payload;
  }

  if (result.confidence >= TIER2_THRESHOLD) {
    return result;
  }

  const llm = await llmExtract({
    archetype,
    promptKey: promptKeyFor(archetype),
    markdown,
    url: page.url,
    contentHash: page.content_hash,
    provider,
  });

  if (llm.attempted && llm.confidence != null) {
    result.tier = "llm";
    result.confidence = llm.confidence;
    result.payload = llm.payload;
    result.provider = llm.provider;
    result.cached = llm.cached;
  } else {
    result.notAttempted = true;
    result.provider = llm.provider;
  }

  return result;
}

export async function parseAndPersist(
  page,
  { provider, jina, version, searchPlan = null, icp = null, runId = null } = {}
) {
  const result = await extractPage(page, { provider, jina });

  let qualificationStatus = null;
  let qualificationReasons = null;

  if (result.payload && result.recordType === "company") {
    const qualification = qualifyCompany({
      profile: result.payload,
      searchPlan,
      icp,
      domain: page.domain,
    });

    qualificationStatus = qualification.status;
    qualificationReasons = qualification.reasons;
  }

  if (result.payload) {
    await insertRawRecord({
      source_type: page.source_type || "website",
      source_ref: page.url,
      record_type: result.recordType,
      payload: result.payload,
      confidence: result.confidence,
      page_id: page.id,
      status: statusForConfidence(result.confidence),
      qualification_status: qualificationStatus,
      qualification_reasons: qualificationReasons,
      run_id: runId,
      product_id: icp?.id || null,
      product_name: icp?.name || null,
    });
  }

  await markRawPageParsed(page.id, version);

  return {
    ...result,
    recordStatus: result.payload
      ? statusForConfidence(result.confidence)
      : null,
    qualificationStatus,
    persisted: Boolean(result.payload),
    pageId: page.id,
  };
}

const CONTACT_TIER1_THRESHOLD = 0.8;

function attachPage(contact, page) {
  return {
    ...contact,
    source_url: contact.source_url || page.url,
    source_urls: [...new Set([
      ...(contact.source_urls || []),
      page.url,
    ].filter(Boolean))],
    page_ids: [...new Set([
      ...(contact.page_ids || []),
      page.id,
    ].filter(Boolean))],
  };
}

export async function extractContactsFromPage(page, { provider, jina } = {}) {
  const archetype = classify(page.html, page.url);

  if (!isContactSourceArchetype(archetype)) {
    return {
      archetype,
      contacts: [],
      tier: null,
      jinaUsed: false,
      markdownSource: null,
    };
  }

  const tier1Contacts = deterministicContactExtract(
    archetype,
    page.html,
    page.url
  ).map((contact) => attachPage(contact, page));

  const tier1Max = tier1Contacts.reduce(
    (max, contact) => Math.max(max, contact.confidence || 0),
    0
  );

  if (tier1Contacts.length && tier1Max >= CONTACT_TIER1_THRESHOLD) {
    return {
      archetype,
      contacts: tier1Contacts,
      tier: "deterministic",
      jinaUsed: false,
      markdownSource: null,
    };
  }

  // Tier 2: reached only when deterministic extraction is insufficient.
  const jinaClient = jina ?? createJinaClient(config);
  const jinaMarkdown = await jinaClient.fetchMarkdown(page.url);

  const markdown = jinaMarkdown || htmlToMarkdown(page.html);

  const tier2Contacts = markdownContactExtract(
    archetype,
    markdown,
    page.url
  ).map((contact) => attachPage(contact, page));

  return {
    archetype,
    contacts: dedupeContacts([...tier1Contacts, ...tier2Contacts]),
    tier: "markdown",
    jinaUsed: Boolean(jinaMarkdown),
    markdownSource: jinaMarkdown ? "jina" : "local",
  };
}

export async function parseCompanyContacts({
  domain,
  provider,
  jina,
  version,
  pages: providedPages = null,
  extraContacts = [],
  runId = null,
  icp = null,
  limit = 200,
} = {}) {
  const fetched =
    providedPages ??
    (await getRawPagesForDomain(domain, { limit }));

  const pages = providedPages
    ? fetched
    : fetched.filter(
        (page) =>
          page.parse_version == null ||
          page.parse_version < version
      );

  const pageById = new Map(pages.map((page) => [page.id, page]));

  const extracted = [];
  let jinaCalls = 0;

  for (const page of pages) {
    const result = await extractContactsFromPage(page, { provider, jina });

    if (result.jinaUsed) {
      jinaCalls += 1;
    }

    extracted.push(...result.contacts);
  }

  const merged = dedupeContacts([...extracted, ...extraContacts]);

  const persisted = [];

  for (const contact of merged) {
    const primary = pageById.get(contact.page_ids?.[0] ?? null);

    const record = await insertRawRecord({
      source_type: primary?.source_type || "website",
      source_ref: contact.source_urls?.[0] || contact.source_url || "",
      record_type: "contact",
      payload: contactPayload(contact),
      confidence: contact.confidence,
      page_id: contact.page_ids?.[0] ?? null,
      status: statusForConfidence(contact.confidence),
      run_id: runId,
      product_id: icp?.id || null,
      product_name: icp?.name || null,
    });

    persisted.push(record);
  }

  for (const page of pages) {
    await markRawPageParsed(page.id, version);
  }

  return {
    domain,
    pagesProcessed: pages.length,
    extracted: extracted.length,
    merged: merged.length,
    persisted: persisted.length,
    jinaCalls,
    llmCalls: 0,
    reviewCount: merged.filter(
      (contact) => (contact.confidence ?? 0) < 0.6
    ).length,
  };
}
