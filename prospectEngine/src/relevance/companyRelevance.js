import { z } from "zod";

import { config } from "../config.js";

import { normalizeUrl } from "../lib/url.js";

import {
  isBlockedDomain,
  isListicleTitle,
} from "./blocklist.js";

// The LLM returns facts about each root domain.
// It does NOT make the final qualification decision.
// Code in decideFromFacts() makes that decision deterministically.

const DecisionSchema = z.object({
  domain: z.string(),

  type: z.enum([
    "company",
    "company_profile",
    "person",
    "directory",
    "media",
    "article",
    "job_board",
    "review_site",
    "educational",
    "generic_info",
    "listicle",
    "vendor_partner",
    "unknown",
  ]),

  is_company_website: z.boolean().nullable(),

  matches_search_plan: z.boolean().nullable(),

  sells_what_target_needs: z.boolean().nullable(),

  is_large_enterprise: z.boolean().nullable(),

  reason_code: z.string(),

  evidence: z.string(),
});

const BatchSchema = z.object({
  decisions: z.array(DecisionSchema),
});

const RELEVANCE_JSON_SCHEMA = {
  type: "object",

  properties: {
    decisions: {
      type: "array",

      items: {
        type: "object",

        properties: {
          domain: {
            type: "string",
          },

          type: {
            type: "string",
            enum: [
              "company",
              "company_profile",
              "person",
              "directory",
              "media",
              "article",
              "job_board",
              "review_site",
              "educational",
              "generic_info",
              "listicle",
              "vendor_partner",
              "unknown",
            ],
          },

          is_company_website: {
            type: ["boolean", "null"],
          },

          matches_search_plan: {
            type: ["boolean", "null"],
          },

          sells_what_target_needs: {
            type: ["boolean", "null"],
          },

          is_large_enterprise: {
            type: ["boolean", "null"],
          },

          reason_code: {
            type: "string",
          },

          evidence: {
            type: "string",
          },
        },

        required: [
          "domain",
          "type",
          "is_company_website",
          "matches_search_plan",
          "sells_what_target_needs",
          "is_large_enterprise",
          "reason_code",
          "evidence",
        ],

        additionalProperties: false,
      },
    },
  },

  required: ["decisions"],

  additionalProperties: false,
};

//
// These are source/page types that must never become prospects.
//
// IMPORTANT:
// "company_profile" is intentionally NOT excluded.
// An official company profile/homepage can represent the actual company.
//
const EXCLUDED_TYPES = new Set([
  "directory",
  "media",
  "article",
  "job_board",
  "review_site",
  "educational",
  "generic_info",
  "listicle",
  "person",
]);

const EXCLUDED_EXTENSIONS =
  /\.(jpg|jpeg|png|gif|webp|svg|ico|avif|bmp|tif|tiff|css|js|map|json|xml|woff2?|ttf|eot|otf|mp3|mp4|webm|ogg|zip|rar|7z|gz|tar|bz2|pdf|docx?|xlsx?|pptx?|ppt|epub|csv|exe|dmg|apk)$/i;

const SEARCH_RESULT_PATTERNS = [
  /\/search\/?/i,
  /\/(search|results|find)\/?/i,
  /\/s\?/i,
];

function isSearchResultUrl(url) {
  return SEARCH_RESULT_PATTERNS.some((pattern) => pattern.test(url));
}

function modelNameFor(providerName) {
  return providerName === "gemini"
    ? config.llmGeminiModel
    : config.openaiModel;
}

export function normalizeCandidate(candidate) {
  const normalized = normalizeUrl(candidate?.url);

  if (!normalized) {
    return {
      ...candidate,
      valid: false,
      reason_code: "malformed_url",
    };
  }

  return {
    ...candidate,
    url: normalized.normalizedUrl,
    baseUrl: normalized.baseUrl,
    domain: normalized.domain,
    hostname: normalized.hostname,
    valid: true,
  };
}

export function deterministicFilter(candidates) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();

  for (const raw of candidates || []) {
    const candidate = normalizeCandidate(raw);

    if (!candidate.valid) {
      rejected.push({
        candidate,
        reason_code: "malformed_url",
      });
      continue;
    }

    if (EXCLUDED_EXTENSIONS.test(candidate.url)) {
      rejected.push({
        candidate,
        reason_code: "non_html_asset",
      });
      continue;
    }

    if (isBlockedDomain(candidate.hostname || candidate.domain)) {
      rejected.push({
        candidate,
        reason_code: "excluded_domain",
      });
      continue;
    }

    if (isListicleTitle(candidate.title)) {
      rejected.push({
        candidate,
        reason_code: "listicle_title",
      });
      continue;
    }

    if (isSearchResultUrl(candidate.url)) {
      rejected.push({
        candidate,
        reason_code: "search_result_page",
      });
      continue;
    }

    if (seen.has(candidate.url)) {
      rejected.push({
        candidate,
        reason_code: "duplicate_url",
      });
      continue;
    }

    seen.add(candidate.url);
    accepted.push(candidate);
  }

  return {
    accepted,
    rejected,
  };
}

function buildPrompt(userQuery, searchPlan, domains) {
  const lines = domains.map(
    (candidate, index) =>
      `${index + 1}. Domain: ${candidate.domain}\n` +
      `   Title: ${candidate.title || ""}\n` +
      `   Snippet: ${candidate.snippet || ""}`,
  );

  const plan = [
    searchPlan?.target_description,
    searchPlan?.industry,
    searchPlan?.location,
    searchPlan?.company_type,
    searchPlan?.product_or_technology,
    searchPlan?.relationship,
  ]
    .filter(Boolean)
    .join("; ");

  return `You are a fact-extraction helper for product-agnostic prospect discovery.

Your job is NOT to invent prospects.

Your job is to classify each supplied domain using ONLY the supplied
domain, title, and search snippet.

ACTIVE PRODUCT ICP AND SEARCH PLAN

Use only the product profile and search plan below to decide whether the
company itself matches the requested prospect. Do not assume a country,
industry, company size, buyer role, or business type unless it appears in
the user query or search plan.

The user query and search plan are the source of truth for this run. Treat
preferred signals as supporting evidence when present; do not invent them.

NON-COMPANY SOURCES TO REJECT:
- directories
- aggregators
- marketplaces
- media
- news
- articles
- blogs
- listicles
- podcasts
- communities
- job boards
- review sites
- educational sites
- generic information pages
- third-party company profiles

CRITICAL WEBSITE RULE:

A domain's own official website is still a company website even when
the URL is:
- /about
- /about-us
- /team
- /services
- /solutions
- /company
- /contact
- /pricing
- /careers

Do NOT reject a company merely because the search result is an internal page
of the company's own domain.

"company_profile" means a domain/page that represents the company itself.

If the domain itself is the company's own official domain and the title/snippet
describes that company, classify it as:
type = "company_profile"
and
is_company_website = true

It can still be approved.

A third-party directory/company database/profile must have:
is_company_website = false

USER QUERY:
"${userQuery}"

SEARCH PLAN:
${plan || "(none)"}

FOR EACH DOMAIN RETURN:

1. type

Use exactly one:
- company
- company_profile
- person
- directory
- media
- article
- job_board
- review_site
- educational
- generic_info
- listicle
- vendor_partner
- unknown

Use "company" or "company_profile" when the domain itself represents
the actual operating company.

2. is_company_website

true:
- the domain is the company's own official website
- (IMPORTANT: Even if the snippet is extremely short, if the domain/URL clearly looks like a real business website rather than a directory or news site, mark this as true. Do not use null just because the snippet is brief.)

false:
- directory
- article
- news site
- media
- review site
- job board
- third-party company database/profile
- person profile
- other unrelated source

null:
- genuinely impossible to tell if it's a company website or a directory

3. matches_search_plan

Set true when the COMPANY ITSELF fits the core requested target:
- the requested geography, if one is specified
- the requested company type, industry, product, or relationship in the query/search plan

Do NOT require founder-led or employee-count evidence here.

Do NOT mark true merely because a page mentions another company.

Set false when the company clearly does not fit.

Set null only when the available title/snippet is genuinely insufficient.

4. sells_what_target_needs

true when the company's main business is selling or providing the product,
tool, platform or service that the requested prospects are supposed to use
or need. Such a company is a vendor or competitor, not a buyer.
Example: the query wants businesses that use LinkedIn to win clients, and
this company is a LinkedIn marketing / lead generation agency.

false when the company is a potential user or buyer, or when the query
itself asks for vendors/providers of that offering.

null only when the title/snippet is genuinely insufficient.

5. is_large_enterprise

true when the domain belongs to a well-known large company: a multinational,
a Big Four or global consulting firm, a global recruitment/staffing firm
(e.g. Randstad, Michael Page), a large IT services firm, a listed company
or a unicorn. A local office ("X India") of such a company is still large. Only for this field you may use general knowledge of
well-known brands. false for small or mid-size firms; null when unsure.

LISTING SNIPPETS:
A snippet like 'Listed on "Top 50 B2B companies in India"' only says the
domain was linked from that page. Do not treat the page title as evidence of
the company's location, industry or size; judge from the domain and link text,
and use null for matches_search_plan when they do not show it.

6. reason_code

Use a short snake_case reason such as:
- matches_business_type
- matches_location
- company_profile
- founder_led_signal
- small_company_signal
- directory_listing
- third_party_profile
- news_article
- listicle
- job_board
- vendor_not_buyer
- too_large
- wrong_industry
- wrong_geo
- unrelated
- insufficient_evidence

7. evidence

Give a short statement based ONLY on the supplied title/snippet.

Never invent (is_large_enterprise is the one exception, see above):
- company size
- founders
- products
- customers
- technology usage
- location

APPROVAL LOGIC:

A company/company_profile should be approved when:
- is_company_website = true
- matches_search_plan = true
- sells_what_target_needs = false

Do not reject company_profile simply because its type is company_profile.

Only classify the domains supplied below.

Never invent domains.

DOMAINS:

${lines.join("\n\n")}`;
}

export async function classifyCandidates(
  provider,
  { userQuery, searchPlan },
  domains,
) {
  const prompt = buildPrompt(
    userQuery,
    searchPlan,
    domains,
  );

  const result = await provider.complete({
    prompt,
    jsonSchema: RELEVANCE_JSON_SCHEMA,
  });

  if (!result.attempted || !result.ok || !result.data) {
    return {
      ok: false,
      error:
        result.error ||
        "relevance provider unavailable",
      usage: result.usage || null,
      decisions: [],
    };
  }

  try {
    const parsed = BatchSchema.parse(result.data);
    
    // DEBUG: Log the LLM's classification
    console.log("LLM DECISIONS:", JSON.stringify(parsed.decisions, null, 2));

    const candidateDomains = new Set(
      domains.map((candidate) =>
        String(candidate.domain || "").toLowerCase(),
      ),
    );

    const returnedDomains = new Set(
      parsed.decisions.map((decision) =>
        String(decision.domain || "").toLowerCase(),
      ),
    );

    const missing = [...candidateDomains].filter(
      (domain) => !returnedDomains.has(domain),
    );

    if (missing.length > 0) {
      return {
        ok: false,
        error: `relevance output missing ${missing.length} domain decision(s)`,
        usage: result.usage || null,
        decisions: [],
      };
    }

    return {
      ok: true,
      usage: result.usage || null,
      decisions: parsed.decisions,
    };
  } catch (error) {
    return {
      ok: false,
      error: `invalid relevance output: ${error.message}`,
      usage: result.usage || null,
      decisions: [],
    };
  }
}

// Final decision is made by code.
// The LLM supplies facts only.

export function decideFromFacts(
  facts,
  { providerName, model, searchPlan = null } = {},
) {
  if (!facts) {
    return {
      status: "review",
      relevant: false,
      type: "unknown",
      reason_code: "no_decision",
      evidence: "",
      provider: providerName,
      model,
    };
  }

  // Explicitly not an official company website.
  if (facts.is_company_website === false) {
    return {
      status: "rejected",
      relevant: false,
      type: facts.type,
      reason_code:
        facts.reason_code ||
        "not_company_website",
      evidence: facts.evidence || "",
      provider: providerName,
      model,
    };
  }

  // Third-party/source types are rejected.
  if (EXCLUDED_TYPES.has(facts.type)) {
    return {
      status: "rejected",
      relevant: false,
      type: facts.type,
      reason_code:
        facts.reason_code || facts.type,
      evidence: facts.evidence || "",
      provider: providerName,
      model,
    };
  }

  if (
    searchPlan?.company_size === "small" &&
    facts.is_large_enterprise === true
  ) {
    return {
      status: "rejected",
      relevant: false,
      type: facts.type,
      reason_code: "too_large",
      evidence: facts.evidence || "",
      provider: providerName,
      model,
    };
  }

  if (facts.sells_what_target_needs === true) {
    return {
      status: "rejected",
      relevant: false,
      type: facts.type,
      reason_code: "vendor_not_buyer",
      evidence: facts.evidence || "",
      provider: providerName,
      model,
    };
  }

  // IMPORTANT:
  // Both "company" and "company_profile" may represent
  // the official company website.
  if (
    (facts.type === "company" ||
      facts.type === "company_profile") &&
    facts.is_company_website === true &&
    facts.matches_search_plan === true
  ) {
    return {
      status: "approved",
      relevant: true,
      type: facts.type,
      reason_code:
        facts.reason_code ||
        "matches_search_plan",
      evidence: facts.evidence || "",
      provider: providerName,
      model,
    };
  }

  // Keep plausible official company sites in the crawl queue when the search
  // snippet cannot confirm ICP fit. Company extraction applies the active ICP
  // to the site's own content before qualifying the record.
  if (
    (facts.type === "company" ||
      facts.type === "company_profile") &&
    facts.is_company_website === true &&
    facts.matches_search_plan === null
  ) {
    return {
      status: "approved",
      relevant: true,
      type: facts.type,
      reason_code:
        facts.reason_code ||
        "company_needs_profile_verification",
      evidence: facts.evidence || "",
      provider: providerName,
      model,
    };
  }

  // Clearly does not match the requested ICP.
  if (facts.matches_search_plan === false) {
    return {
      status: "rejected",
      relevant: false,
      type: facts.type,
      reason_code:
        facts.reason_code ||
        "not_matching_search_plan",
      evidence: facts.evidence || "",
      provider: providerName,
      model,
    };
  }

  // Insufficient evidence stays review.
  return {
    status: "review",
    relevant: false,
    type: facts.type,
    reason_code:
      facts.reason_code ||
      "insufficient_evidence",
    evidence: facts.evidence || "",
    provider: providerName,
    model,
  };
}

function reviewDecision(reasonCode) {
  return {
    status: "review",
    relevant: false,
    type: "unknown",
    reason_code: reasonCode,
    evidence: "",
  };
}

function groupByDomain(candidates) {
  const map = new Map();

  for (const candidate of candidates) {
    const domain = candidate.domain;

    if (!map.has(domain)) {
      map.set(domain, []);
    }

    map.get(domain).push(candidate);
  }

  return map;
}

function representativeFor(candidates) {
  const withText = candidates.find(
    (candidate) =>
      candidate.title || candidate.snippet,
  );

  const candidate =
    withText || candidates[0];

  return {
    domain: candidate.domain,
    title: candidate.title || "",
    snippet: candidate.snippet || "",
    url: candidate.url,
  };
}

export async function rankCandidates({
  userQuery,
  searchPlan = null,
  candidates,
  provider,
  threshold = config.openaiRelevanceThreshold,
} = {}) {
  const {
    accepted,
    rejected,
  } = deterministicFilter(candidates);

  const providerName =
    provider?.name || "disabled";

  const model =
    modelNameFor(providerName);

  const llmAvailable =
    provider &&
    provider.name !== "disabled" &&
    config.relevanceEnabled;

  if (!accepted.length) {
    return {
      approved: [],
      rejected,
      review: [],
      provider: providerName,
      model: llmAvailable ? model : null,
      relevanceStatus: "none",
      decisions: [],
    };
  }

  // One relevance decision per root domain.
  const domainGroups =
    groupByDomain(accepted);

  // Fail closed if relevance is unavailable.
  if (!llmAvailable) {
    const review = [];

    for (const domainCandidates of domainGroups.values()) {
      for (const candidate of domainCandidates) {
        review.push({
          ...candidate,

          relevance: {
            ...reviewDecision(
              "llm-unavailable",
            ),
            provider: providerName,
            model: null,
          },
        });
      }
    }

    return {
      approved: [],
      rejected,
      review,
      provider: providerName,
      model: null,
      relevanceStatus: "review",
      decisions: [],
    };
  }

  const decisions = [];
  const domainBatches = [];
  const domainList = [
    ...domainGroups.keys(),
  ];

  for (
    let i = 0;
    i < domainList.length;
    i += config.relevanceBatchSize
  ) {
    const batchDomains =
      domainList.slice(
        i,
        i + config.relevanceBatchSize,
      );

    const batchRepresentatives =
      batchDomains.map((domain) =>
        representativeFor(
          domainGroups.get(domain),
        ),
      );

    // Retry one failed batch once.
    let result =
      await classifyCandidates(
        provider,
        {
          userQuery,
          searchPlan,
        },
        batchRepresentatives,
      );

    if (!result.ok) {
      result =
        await classifyCandidates(
          provider,
          {
            userQuery,
            searchPlan,
          },
          batchRepresentatives,
        );
    }

    if (result.ok) {
      decisions.push(
        ...result.decisions,
      );
    } else {
      for (const representative of batchRepresentatives) {
        decisions.push({
          domain:
            representative.domain,
          type: "unknown",
          is_company_website: null,
          matches_search_plan: null,
          sells_what_target_needs: null,
          is_large_enterprise: null,
          reason_code:
            "llm-unavailable",
          evidence: "",
        });
      }
    }
  }

  const decisionByDomain =
    new Map(
      decisions.map((decision) => [
        String(
          decision.domain || "",
        ).toLowerCase(),
        decision,
      ]),
    );

  const approved = [];
  const llmRejected = [];
  const review = [];

  for (const domainCandidates of domainGroups.values()) {
    const firstCandidate =
      domainCandidates[0];

    const decision =
      decisionByDomain.get(
        String(
          firstCandidate.domain,
        ).toLowerCase(),
      );

    const relevance =
      decideFromFacts(decision, {
        providerName,
        model,
        searchPlan,
      });

    for (const candidate of domainCandidates) {
      const withRelevance = {
        ...candidate,

        relevance: {
          ...relevance,
          provider: providerName,
          model,
        },
      };

      if (
        relevance.status ===
        "approved"
      ) {
        approved.push(
          withRelevance,
        );
      } else if (
        relevance.status ===
        "rejected"
      ) {
        llmRejected.push(
          withRelevance,
        );
      } else {
        review.push(
          withRelevance,
        );
      }
    }
  }

  return {
    approved,
    rejected: [
      ...rejected,
      ...llmRejected,
    ],
    review,
    provider: providerName,
    model,
    relevanceStatus:
      "classified",
    decisions,
  };
}
