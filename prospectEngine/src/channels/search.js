import { config } from "../config.js";
import { createChannel } from "./_backend.js";

async function fetchWithTimeout(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": config.crawlerUserAgent,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

let engineCursor = 0;

// Each query goes to a rotating slice of the engine pool, so no single free
// engine sees every query and gets rate-limited.
function enginesForQuery() {
  const pool = config.searxngEngines;
  const count = Math.min(config.searxngEnginesPerQuery, pool.length);
  const picked = Array.from({ length: count }, (_, i) => pool[(engineCursor + i) % pool.length]);
  engineCursor = pool.length ? (engineCursor + count) % pool.length : 0;
  return picked;
}

async function searchSearxng({
  query,
  page = 1,
  language = "en",
  limit = config.searchResultsPerQuery,
}) {
  const engines = enginesForQuery();
  const endpoint = new URL(`${config.searxngUrl}/search`);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("language", language);
  endpoint.searchParams.set("categories", "general");
  if (engines.length) {
    endpoint.searchParams.set("engines", engines.join(","));
  }
  endpoint.searchParams.set("pageno", String(page));

  const response = await fetchWithTimeout(endpoint.toString());
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SearXNG returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const results = (Array.isArray(data.results) ? data.results : [])
    .map((result) => ({
      title: typeof result.title === "string" ? result.title : "",
      url: typeof result.url === "string" ? result.url : "",
      content: typeof result.content === "string" ? result.content : "",
      engine: typeof result.engine === "string" ? result.engine : null,
      category: typeof result.category === "string" ? result.category : null,
    }))
    .filter((result) => result.url.startsWith("http://") || result.url.startsWith("https://"))
    .slice(0, limit);

  return {
    results,
    requestedEngines: engines,
    enginesUsed: [...new Set(results.map((result) => result.engine).filter(Boolean))],
    unresponsiveEngines: Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : [],
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
  };
}

export async function diagnoseSearch(query) {
  const result = await searchSearxng({ query, limit: 10 });
  return {
    query,
    requestedEngines: result.requestedEngines,
    enginesUsed: result.enginesUsed,
    unresponsiveEngines: result.unresponsiveEngines,
    resultCount: result.results.length,
    results: result.results.map(({ title, url, engine, content }) => ({ title, url, engine, snippet: content })),
  };
}

const searxngBackend = {
  name: "searxng",

  async probe() {
    const response = await fetchWithTimeout(`${config.searxngUrl}/`, 10000);
    if (!response.ok) {
      throw new Error(`SearXNG probe failed: HTTP ${response.status}`);
    }
    return true;
  },

  async run(input) {
    const result = await searchSearxng(input);
    console.log(`SearXNG returned ${result.results.length} results from ${result.enginesUsed.join(", ") || "no responsive engines"}`);
    if (result.unresponsiveEngines.length) {
      console.warn(`Unresponsive search engines: ${JSON.stringify(result.unresponsiveEngines)}`);
    }
    return result.results;
  },
};

export const searchChannel = createChannel({
  type: "search",
  backends: [searxngBackend],
});
