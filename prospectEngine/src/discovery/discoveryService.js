import {
  generateSearchPlan,
} from "./queryGenerator.js";

import searxngSource from "../sources/searxng/index.js";

import {
  upsertCrawlTargets,
} from "../storage/pgStore.js";

import {
  createFactsProvider,
} from "../parse/llm/provider.js";

import {
  config,
} from "../config.js";

import {
  rankCandidates,
} from "../relevance/companyRelevance.js";

import {
  collectOutboundCompanies,
} from "../sources/public/index.js";

// How many approved targets to aim for before stopping early.
const DEFAULT_TARGET_COUNT = 10;

const LISTING_TYPES = new Set(["directory", "listicle", "article", "media"]);
const MAX_LISTING_PAGES = 8;
const MAX_LINKS_PER_LISTING = 40;
const MAX_MINED_CANDIDATES = 150;

// Rejected directories and listicles are not prospects, but the company
// websites they link to can be (PRD A5).
function listingPages(rejected) {
  const pages = new Map();

  for (const entry of rejected) {
    const candidate = entry.relevance ? entry : entry.candidate;
    const isListing = entry.relevance
      ? LISTING_TYPES.has(entry.relevance.type)
      : entry.reason_code === "listicle_title";

    if (isListing && candidate?.url && !pages.has(candidate.url)) {
      pages.set(candidate.url, candidate);
    }
  }

  return [...pages.values()].slice(0, MAX_LISTING_PAGES);
}

async function mineListings({ rejected, knownDomains }) {
  const pages = listingPages(rejected);

  if (!pages.length) {
    return [];
  }

  console.log("");
  console.log(`Mining ${pages.length} directory/listicle pages for company links`);

  const { candidates } = await collectOutboundCompanies(
    pages.map((page, index) => ({ id: `listing-${index}`, url: page.url })),
    { followInternal: false, maxCandidatesPerSource: MAX_LINKS_PER_LISTING },
  );

  return candidates
    .filter((candidate) => !knownDomains.has(candidate.domain))
    .slice(0, MAX_MINED_CANDIDATES)
    .map((candidate) => ({
      ...candidate,
      snippet: `Listed on "${candidate.parentTitle || candidate.parentUrl}"`,
      priority: 50,
      source_type: "listing",
      depth: 0,
      state: "queued",
      discovered_by: "listing",
      matchedQueries: [],
      occurrences: 1,
    }));
}

//
// Run one search round: fetch candidates from SearXNG for the given queries,
// then classify them through the relevance gate.
//
async function runSearchRound({
  userQuery,
  searchPlan,
  queries,
  provider,
  roundLabel,
}) {
  console.log("");
  console.log(`${roundLabel} QUERIES (${queries.length}):`);
  queries.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));

  const rawTargets =
    await searxngSource.discover(
      searchPlan,
      {
        generatedQueries: queries,
      },
    );

  console.log("");
  console.log(`${roundLabel} raw candidates: ${rawTargets.length}`);

  if (!rawTargets.length) {
    return {
      rawTargets: [],
      ranked: {
        approved: [],
        rejected: [],
        review: [],
        relevanceStatus: "none",
        provider: "disabled",
        model: null,
        decisions: [],
      },
    };
  }

  const ranked =
    await rankCandidates({
      userQuery,
      searchPlan,
      candidates: rawTargets,
      provider,
    });

  const mined =
    await mineListings({
      rejected: ranked.rejected,
      knownDomains: new Set(rawTargets.map((target) => target.domain)),
    });

  if (!mined.length) {
    return { rawTargets, ranked };
  }

  console.log(`${roundLabel} mined candidates: ${mined.length}`);

  const minedRanked =
    await rankCandidates({
      userQuery,
      searchPlan,
      candidates: mined,
      provider,
    });

  return {
    rawTargets: [...rawTargets, ...mined],
    ranked: {
      ...ranked,
      approved: [...ranked.approved, ...minedRanked.approved],
      rejected: [...ranked.rejected, ...minedRanked.rejected],
      review: [...ranked.review, ...minedRanked.review],
      decisions: [...ranked.decisions, ...minedRanked.decisions],
    },
  };
}

export async function discover(
  userQuery,
  icp = null,
  targetCount = DEFAULT_TARGET_COUNT,
) {
  console.log("");
  console.log(
    "========================================",
  );
  console.log(
    "DAY 1 — DISCOVERY",
  );
  console.log(
    "========================================",
  );

  console.log(
    `USER QUERY: ${userQuery}`,
  );

  const provider =
    createFactsProvider(config);

  const searchPlan =
    await generateSearchPlan(
      userQuery,
      icp,
      provider,
    );

  console.log("");
  console.log(
    "GENERATED SEARCH QUERIES:",
  );

  searchPlan.search_queries.forEach(
    (query, index) => {
      console.log(
        `${index + 1}. ${query}`,
      );
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // ROUND 1 — Primary queries
  // ────────────────────────────────────────────────────────────────────────
  const round1 =
    await runSearchRound({
      userQuery,
      searchPlan,
      queries: searchPlan.search_queries,
      provider,
      roundLabel: "ROUND 1",
    });

  const allRawTargets = [
    ...round1.rawTargets,
  ];

  let allApproved = [
    ...round1.ranked.approved,
  ];

  let allRejected = [
    ...round1.ranked.rejected,
  ];

  let allReview = [
    ...round1.ranked.review,
  ];

  const queriesUsed = [
    ...searchPlan.search_queries,
  ];

  // ────────────────────────────────────────────────────────────────────────
  // ROUND 2 — Supplementary queries (only if we still need more targets)
  // ────────────────────────────────────────────────────────────────────────
  if (allApproved.length < targetCount) {
    console.log("");
    console.log(
      `ROUND 1 approved ${allApproved.length}/${targetCount} targets. ` +
      `Running supplementary search round...`,
    );

    const supplementaryQueries =
      searchPlan.supplementary_queries;

    // De-duplicate against already-used queries.
    const usedSet = new Set(queriesUsed);
    const freshSupplementary =
      supplementaryQueries.filter((q) => !usedSet.has(q));

    if (freshSupplementary.length > 0) {
      const round2 =
        await runSearchRound({
          userQuery,
          searchPlan,
          queries: freshSupplementary,
          provider,
          roundLabel: "ROUND 2",
        });

      // Merge — avoid duplicate domains already approved in Round 1.
      const approvedDomains =
        new Set(allApproved.map((t) => t.domain));

      const newApproved =
        round2.ranked.approved.filter(
          (t) => !approvedDomains.has(t.domain),
        );

      allRawTargets.push(...round2.rawTargets);
      allApproved.push(...newApproved);
      allRejected.push(...round2.ranked.rejected);
      allReview.push(...round2.ranked.review);
      queriesUsed.push(...freshSupplementary);
    } else {
      console.log(
        "No additional supplementary queries available.",
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Warn clearly if we still have nothing to crawl.
  // ────────────────────────────────────────────────────────────────────────
  if (!allApproved.length) {
    console.log("");
    console.log(
      "⚠  DISCOVERY: Zero approved targets after all rounds.",
    );
    console.log(
      "   Possible causes:",
    );
    console.log(
      "   • SearXNG is returning noise — check SearXNG engines/config.",
    );
    console.log(
      "   • OpenAI relevance is unavailable — check OPENAI_API_KEY.",
    );
    console.log(
      "   • All candidates are genuinely irrelevant to the ICP.",
    );
    console.log(
      "   Stopping before crawl. Do NOT proceed to crawl with 0 targets.",
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // Print approved targets
  // ────────────────────────────────────────────────────────────────────────
  console.log("");
  console.log(
    "RELEVANT COMPANY TARGETS:",
  );

  if (!allApproved.length) {
    console.log(
      "No company targets approved by relevance.",
    );
  } else {
    allApproved.forEach(
      (target, index) => {
        console.log(
          `${index + 1}. ${target.domain} → ${
            target.title ||
            target.url
          }`,
        );
      },
    );
  }

  const persistedTargets =
    await upsertCrawlTargets(
      allApproved,
    );

  const searchEngines = allRawTargets.reduce((counts, target) => {
    const engine = target.search_engine || "unknown";
    counts[engine] = (counts[engine] || 0) + 1;
    return counts;
  }, {});

  // ────────────────────────────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────────────────────────────
  console.log("");
  console.log(
    "DISCOVERY RESULT",
  );

  console.log(
    `Queries used: ${queriesUsed.length}`,
  );

  console.log(
    `Targets discovered (raw): ${allRawTargets.length}`,
  );

  console.log(
    `Targets relevant (approved): ${allApproved.length}`,
  );

  console.log(
    `Targets rejected: ${allRejected.length}`,
  );

  console.log(
    `Targets review: ${allReview.length}`,
  );

  console.log(
    `Targets persisted: ${persistedTargets.length}`,
  );

  console.log("");
  console.log(
    "CRAWL TARGETS:",
  );

  allApproved.forEach(
    (target, index) => {
      console.log(
        `${index + 1}. ${target.url}`,
      );
    },
  );

  return {
    userQuery,

    searchPlan,

    targets: allApproved,

    relevance: {
      status:
        round1.ranked.relevanceStatus,

      provider:
        round1.ranked.provider,

      model:
        round1.ranked.model,

      rejected:
        allRejected.length,

      review:
        allReview.length,
    },

    statistics: {
      targetsDiscovered:
        allRawTargets.length,

      targetsRelevant:
        allApproved.length,

      targetsPersisted:
        persistedTargets.length,

      targetsRejected:
        allRejected.length,

      targetsReview:
        allReview.length,
      searchEngines,
    },
  };
}
