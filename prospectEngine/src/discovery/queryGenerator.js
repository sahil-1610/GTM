import { z } from "zod";

import { config } from "../config.js";

const SearchPlanSchema = z.object({
  target_description:
    z.string(),

  location:
    z.string(),

  industry:
    z.string(),

  company_type:
    z.string(),

  product_or_technology:
    z.string(),

  relationship:
    z.enum([
      "uses",
      "needs",
      "sells",
      "offers",
      "implements",
      "related_to",
      "unknown",
    ]),

  company_size:
    z.enum(["small", "mid", "large", "any"]).default("any"),

  search_queries:
    z
      .array(z.string())
      .min(3)
      .max(20),

  supplementary_queries:
    z.array(z.string()).default([]),
});

function cleanQueries(
  queries,
  max = config.maxSearchQueries,
) {
  return [
    ...new Set(
      queries
        .map((query) =>
          String(query).trim(),
        )
        .filter(Boolean),
    ),
  ].slice(
    0,
    max,
  );
}

// Common noise-domain exclusions appended to most queries.
const EXCLUDE_NOISE =
  `-site:linkedin.com -site:facebook.com -site:instagram.com` +
  ` -site:clutch.co -site:goodfirms.co -site:g2.com` +
  ` -site:justdial.com -site:indiamart.com -site:naukri.com` +
  ` -site:wellfound.com -site:glassdoor.com -site:indeed.com` +
  ` -site:yourstory.com -site:inc42.com -site:reddit.com` +
  ` -site:medium.com -site:quora.com`;

//
// Company-website-intent queries.
//
// Each query is designed to surface the official website of an Indian B2B
// company rather than LinkedIn profiles, news articles, or directories.
//
// Tactics used:
//   1. inurl:about / inurl:about-us  → company "About" pages
//   2. inurl:services / inurl:solutions → company service pages
//   3. "about us" in quotes           → text that appears on company sites
//   4. site:.in                       → Indian TLD companies
//   5. -site:*                        → exclude noise domains
//   6. intitle:                       → title-based signal for company pages
//
function asList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

function productTypes(icp) {
  return [...new Set([
    ...asList(icp?.company_types || icp?.companyTypes),
    ...asList(icp?.industries),
    ...asList(icp?.industry),
  ])];
}

function locationFor(icp) {
  return String(icp?.location || asList(icp?.geography)[0] || "").trim();
}

function companyWebsiteQueries(userQuery, icp) {
  const location = locationFor(icp);
  const where = location ? `"${location}"` : "";
  const types = productTypes(icp);
  const typeQueries = types.slice(0, 5).flatMap((type) => [
    `"${type}" ${where} company "about us" ${EXCLUDE_NOISE}`,
    `"${type}" ${where} official website ${EXCLUDE_NOISE}`,
  ]);

  return [
    `${userQuery} official website ${EXCLUDE_NOISE}`,
    `${userQuery} company "about us" ${EXCLUDE_NOISE}`,
    `${userQuery} customers company website ${EXCLUDE_NOISE}`,
    ...typeQueries,
    ...((icp?.name || icp?.product_name)
      ? [`"${icp.name || icp.product_name}" ${where} customers ${EXCLUDE_NOISE}`]
      : []),
  ];
}

function fallbackQueries(
  userQuery,
  icp = null,
) {
  const location = locationFor(icp);
  const types = productTypes(icp);
  const typeText = types.join(", ");
  const offering = String(icp?.product_description || icp?.offering || icp?.product || "").trim();
  const idealCustomer = String(icp?.ideal_customer || icp?.target_description || "").trim();
  const queries = companyWebsiteQueries(userQuery, icp);

  return {
    target_description: [idealCustomer, userQuery.trim(), offering && `Product: ${offering}`].filter(Boolean).join(". "),

    location,

    industry: typeText || "",

    company_type: typeText || "companies matching the requested customer profile",

    product_or_technology: String(icp?.name || icp?.product_name || offering || "").trim(),

    company_size: Number(icp?.company_size?.max) > 0 && Number(icp.company_size.max) <= 200 ? "small" : "any",

    relationship: ["uses", "needs", "sells", "offers", "implements", "related_to", "unknown"].includes(icp?.relationship)
      ? icp.relationship
      : "needs",

    search_queries:
      cleanQueries(queries),

    supplementary_queries:
      cleanQueries(queries.slice(1)),
  };
}

const PLAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    target_description: { type: "string" },
    location: { type: "string" },
    industry: { type: "string" },
    company_type: { type: "string" },
    product_or_technology: { type: "string" },
    relationship: {
      type: "string",
      enum: ["uses", "needs", "sells", "offers", "implements", "related_to", "unknown"],
    },
    company_size: { type: "string", enum: ["small", "mid", "large", "any"] },
    search_queries: { type: "array", items: { type: "string" } },
  },
  required: [
    "target_description", "location", "industry", "company_type",
    "product_or_technology", "relationship", "company_size", "search_queries",
  ],
  additionalProperties: false,
};

function planPrompt(userQuery, icp) {
  const product = icp
    ? `\nWe sell: ${icp.name || ""} ${icp.product_description || ""}\nTarget company types: ${productTypes(icp).join(", ")}\nIdeal customer: ${icp.ideal_customer || ""}\n`
    : "";

  return `You plan web searches that find the official websites of companies matching a B2B prospecting request.

Request: ${userQuery}
${product}
Return:
- target_description: one sentence describing the companies we want
- location, industry, company_type: short values, "" when not specified
- product_or_technology: the product or channel the request mentions, "" if none
- relationship: how the target companies relate to that product
- company_size: "small" when the request targets founders, owners, coaches,
  consultants, agencies or other small/founder-led firms; "large" for
  enterprises; "mid" when stated; otherwise "any"
- search_queries: 14 different web search queries

Query rules:
- 3 to 7 words each, written the way a person types into Google
- Describe the prospect companies themselves (their business type and location),
  never the product they should use. For "agencies that use LinkedIn", search
  for agencies, not for LinkedIn services, and do not mention LinkedIn.
- Include the location in every query when one is given
- Vary the business types and cities/regions across queries
- No site:, inurl: or intitle: operators, no URLs, no company names
- Quote only short exact phrases of 2 to 3 words`;
}

async function llmSearchPlan(userQuery, icp, provider) {
  if (!provider || provider.name === "disabled") {
    return null;
  }

  const result = await provider.complete({
    prompt: planPrompt(userQuery, icp),
    jsonSchema: PLAN_JSON_SCHEMA,
  });

  if (!result.ok || !result.data) {
    console.warn(`Search planning failed, using template queries: ${result.error || "no data"}`);
    return null;
  }

  return result.data;
}

export async function generateSearchPlan(
  userQuery,
  icp = null,
  provider = null,
) {
  if (
    !userQuery ||
    !userQuery.trim()
  ) {
    throw new Error(
      "USER_QUERY cannot be empty.",
    );
  }

  const plan =
    fallbackQueries(
      userQuery,
      icp,
    );

  const planned =
    await llmSearchPlan(
      userQuery,
      icp,
      provider,
    );

  if (!planned) {
    return SearchPlanSchema.parse(plan);
  }

  const product = String(planned.product_or_technology || "").trim().toLowerCase();
  const location = String(planned.location || "").trim();
  const buyerSearch = ["uses", "needs"].includes(planned.relationship);

  // Naming the product the prospects use surfaces vendors of it, not buyers.
  const queries = cleanQueries(
    planned.search_queries
      .filter((query) => !(buyerSearch && product && query.toLowerCase().includes(product)))
      .map((query) =>
        location && !query.toLowerCase().includes(location.toLowerCase())
          ? `${query} ${location}`
          : query,
      )
      .map((query) => `${query} ${EXCLUDE_NOISE}`),
    Infinity,
  );

  try {
    return SearchPlanSchema.parse({
      ...planned,
      search_queries: queries.slice(0, config.maxSearchQueries),
      supplementary_queries: queries.slice(config.maxSearchQueries),
    });
  } catch (error) {
    console.warn(`Search plan invalid, using template queries: ${error.message}`);
    return SearchPlanSchema.parse(plan);
  }
}
