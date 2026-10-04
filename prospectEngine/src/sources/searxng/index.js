import { config } from "../../config.js";
import { searchChannel } from "../../channels/search.js";

import { buildDorkQueries } from "./dorks.js";

import { normalizeUrl } from "../../lib/url.js";
import { dedupeByDomain } from "../../lib/dedupe.js";
import { isBlockedDomain } from "../../relevance/blocklist.js";

import {
  getSearchCache,
  setSearchCache,
} from "../../storage/localStore.js";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function cacheKey(query, page) {
  return `${query}::${page}::${config.searxngEngines.join(",")}`;
}

function isCacheFresh(entry) {
  // Allow a hard bypass so a fresh run always fetches live results.
  if (config.searxngBypassCache) {
    return false;
  }

  if (!entry) {
    return false;
  }

  const cachedTime = new Date(entry.cachedAt).getTime();

  if (!Number.isFinite(cachedTime)) {
    return false;
  }

  const age = Date.now() - cachedTime;

  const maxAge =
    config.searxngCacheTtlDays *
    24 *
    60 *
    60 *
    1000;

  return age < maxAge;
}

function makeTarget({
  result,
  query,
  position,
}) {
  const normalized = normalizeUrl(result.url);

  if (!normalized) {
    return null;
  }

  if (isBlockedDomain(normalized.domain)) {
    return null;
  }

  return {
    domain: normalized.domain,
    url: normalized.normalizedUrl,
    baseUrl: normalized.baseUrl,

    priority: Math.max(1, position),

    source_type: "searxng",

    depth: 0,

    state: "queued",

    attempts: 0,

    next_attempt_at: null,

    discovered_by: "searxng",

    title: result.title || "",
    snippet: result.content || "",
    search_engine: result.engine || null,

    matchedQueries: [query],

    occurrences: 1,
  };
}

export default {
  type: "searxng",

  capabilities: {
    companies: true,
    contacts: false,
    emails: false,
  },

  async discover(
    icp,
    {
      limit = config.discoveryLimit,
      generatedQueries = [],
    } = {}
  ) {
    const queries = [
      ...generatedQueries,
      ...buildDorkQueries(icp),
    ]
      .map((query) => query.trim())
      .filter(Boolean);

    const uniqueQueries = [
      ...new Set(queries),
    ].slice(0, config.maxSearchQueries);

    const candidates = [];

    const cache = await getSearchCache();

    for (
      let queryIndex = 0;
      queryIndex < uniqueQueries.length;
      queryIndex++
    ) {
      const query = uniqueQueries[queryIndex];

      console.log("");
      console.log(
        `[Discovery ${queryIndex + 1}/${uniqueQueries.length}]`
      );

      for (let page = 1; page <= config.searchPagesPerQuery; page++) {
        const key = cacheKey(query, page);
        let results;

        if (isCacheFresh(cache[key])) {
          console.log(`Cache hit: "${query}" page ${page}`);
          results = cache[key].results;
        } else {
          console.log(`SearXNG: "${query}" page ${page}`);
          try {
            results = await searchChannel.run({
              query,
              page,
              language: "en",
              limit: config.searchResultsPerQuery,
            });
            // Empty results usually mean suspended engines; caching them would
            // hide the query from later runs.
            if (results.length) {
              await setSearchCache(key, {
                cachedAt: new Date().toISOString(),
                results,
              });
            }
          } catch (error) {
            console.error(`Search failed: ${query}`);
            console.error(error.message);
            results = [];
          }
        }

        for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
          const target = makeTarget({
            result: results[resultIndex],
            query,
            position: resultIndex + 1,
          });
          if (target) candidates.push(target);
        }
      }

      if (queryIndex < uniqueQueries.length - 1) {
        console.log(
          `Waiting ${
            config.searxngQueryDelayMs / 1000
          }s before next search query...`
        );

        await sleep(
          config.searxngQueryDelayMs
        );
      }
    }

    const uniqueCandidates =
      dedupeByDomain(candidates);

    return uniqueCandidates.slice(
      0,
      limit
    );
  },
};

const LINKEDIN_SUFFIX_RE = /\s*[|·]\s*LinkedIn.*$/i;
const COMPANY_SUFFIX_RE = /\b(pvt|private|ltd|limited|llp|llc|inc|co)\b\.?/gi;

function companyKey(name) {
  return String(name || "").replace(COMPANY_SUFFIX_RE, "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

// Reads people from public search-result titles such as
// "Rahul Jain - Founder - Acme Consulting | LinkedIn". LinkedIn itself is
// never fetched; only the search engine's title and snippet are used.
export async function findLinkedInPeople({ companyName, location = "" }) {
  const company = companyKey(companyName);
  if (company.length < 3) return [];

  const query = `site:linkedin.com/in "${companyName}" (founder OR CEO OR owner OR director OR partner) ${location}`.trim();
  let results;
  try {
    results = await searchChannel.run({ query, limit: config.searchResultsPerQuery });
  } catch (error) {
    console.error(`LinkedIn search failed for ${companyName}: ${error.message}`);
    return [];
  }

  const people = [];
  for (const result of results) {
    const profile = String(result.url || "").match(/linkedin\.com\/in\/([^/?#]+)/i);
    if (!profile) continue;
    const [name, ...rest] = String(result.title || "")
      .replace(LINKEDIN_SUFFIX_RE, "")
      .split(/\s+[-–—]\s+/);
    const title = rest[0];
    if (!name || !title) continue;

    // The company must appear in the headline, not just in the person's name
    // or the snippet, otherwise namesakes and passing mentions slip in.
    const headline = rest.join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ");
    if (!headline.includes(company)) continue;

    people.push({
      line: `${name.trim()} | ${title.trim()}`,
      profileUrl: `https://www.linkedin.com/in/${profile[1].toLowerCase()}`,
      snippet: result.content || "",
    });
  }
  return people;
}
