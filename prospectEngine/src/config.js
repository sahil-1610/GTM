import "dotenv/config";

function required(name) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }

  return value;
}

function booleanEnv(name, fallback = false) {
  const value = process.env[name];

  if (value === undefined || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(
    value.trim().toLowerCase()
  );
}

export const config = {
  userQuery:
    process.env.USER_QUERY ||
    "Find India-based founders, consultants, coaches, and agency owners at B2B service businesses who use LinkedIn to build authority and attract clients",

  geminiApiKey: process.env.GEMINI_API_KEY || "",

  geminiModel:
    process.env.GEMINI_MODEL || "gemini-3.8-flash",

  searxngUrl:
    (process.env.SEARXNG_URL || "http://127.0.0.1:8888").replace(/\/+$/, ""),

  searxngEngines:
    (process.env.SEARXNG_ENGINES || "google cse,duckduckgo web,resulthunter,gmx,yandex,yep,bing")
      .split(",")
      .map((engine) => engine.trim())
      .filter(Boolean),

  searxngEnginesPerQuery:
    numberEnv("SEARXNG_ENGINES_PER_QUERY", 3),

  searchResultsPerQuery:
    numberEnv("SEARCH_RESULTS_PER_QUERY", 10),

  maxSearchQueries:
    numberEnv("MAX_SEARCH_QUERIES", 8),

  searchPagesPerQuery:
    numberEnv("SEARCH_PAGES_PER_QUERY", 1),

  searxngQueryDelayMs:
    numberEnv("SEARXNG_QUERY_DELAY_MS", 15000),

  searxngCacheTtlDays:
    numberEnv("SEARXNG_CACHE_TTL_DAYS", 30),

  // When true every SearXNG call goes live and bypasses the local cache.
  searxngBypassCache:
    booleanEnv("SEARXNG_BYPASS_CACHE", false),

  discoveryLimit:
    numberEnv("DISCOVERY_LIMIT", 200),

  crawlMaxCandidates:
    numberEnv("CRAWL_MAX_CANDIDATES", 10),

  crawlMaxPagesPerDomain:
    numberEnv("CRAWL_MAX_PAGES_PER_DOMAIN", 8),

  crawlMaxDepth:
    numberEnv("CRAWL_MAX_DEPTH", 1),

  crawlMaxConcurrency:
    numberEnv("CRAWL_MAX_CONCURRENCY", 10),

  crawlMaxRequestsPerMinute:
    numberEnv("CRAWL_MAX_REQUESTS_PER_MINUTE", 120),

  crawlMaxRetries:
    numberEnv("CRAWL_MAX_RETRIES", 2),

  crawlMaxAttempts:
    numberEnv("CRAWL_MAX_ATTEMPTS", 3),

  crawlSameDomainDelaySecs:
    numberEnv("CRAWL_SAME_DOMAIN_DELAY_SECS", 2),

  crawlDiscoveryMaxLinksPerPage:
    numberEnv("CRAWL_DISCOVERY_MAX_LINKS_PER_PAGE", 20),

  crawlSitemapEnabled:
    booleanEnv("CRAWL_SITEMAP_ENABLED", true),

  crawlSitemapMaxUrls:
    numberEnv("CRAWL_SITEMAP_MAX_URLS", 100),

  crawlSitemapTimeoutMs:
    numberEnv("CRAWL_SITEMAP_TIMEOUT_MS", 10000),

  discoveryHighPriorityScore:
    numberEnv("DISCOVERY_HIGH_PRIORITY_SCORE", 100),

  discoveryMediumPriorityScore:
    numberEnv("DISCOVERY_MEDIUM_PRIORITY_SCORE", 60),

  discoveryLowPriorityScore:
    numberEnv("DISCOVERY_LOW_PRIORITY_SCORE", 10),

  discoveryGenericScore:
    numberEnv("DISCOVERY_GENERIC_SCORE", 5),

  crawlRequestTimeoutSecs:
    numberEnv("CRAWL_REQUEST_TIMEOUT_SECS", 45),

  crawlRetryBackoffBaseMs:
    numberEnv("CRAWL_RETRY_BACKOFF_BASE_MS", 2000),

  crawlRetryBackoffMaxMs:
    numberEnv("CRAWL_RETRY_BACKOFF_MAX_MS", 30000),

  crawlerUserAgent:
    `BDA-Prospect-Engine/0.1 (+${
      process.env.CRAWLER_CONTACT_URL?.trim() ||
      "https://example.com/contact"
    })`,

  llmEnabled:
    booleanEnv("LLM_ENABLED", false),

  // Gemini is reserved for query generation only (see queryGenerator.js).
  // Relevance/qualification/LLM extraction run on OpenAI GPT-4o-mini.
  llmProvider:
    process.env.LLM_PROVIDER || "openai",

  llmGeminiModel:
    process.env.LLM_GEMINI_MODEL ||
    process.env.GEMINI_MODEL ||
    "gemini-3.8-flash",

  llmOpenaiModel:
    process.env.LLM_OPENAI_MODEL ||
    "gpt-4o-mini",

  llmOpenaiApiKey:
    process.env.LLM_OPENAI_API_KEY || "",

  jinaEnabled:
    booleanEnv("JINA_ENABLED", false),

  jinaBaseUrl:
    (
      process.env.JINA_BASE_URL ||
      "https://r.jina.ai"
    ).replace(/\/+$/, ""),

  jinaApiKey:
    process.env.JINA_API_KEY || "",

  jinaTimeoutMs:
    numberEnv("JINA_TIMEOUT_MS", 30000),

  githubApiBaseUrl:
    (
      process.env.GITHUB_API_BASE_URL ||
      "https://api.github.com"
    ).replace(/\/+$/, ""),

  githubToken:
    process.env.GITHUB_TOKEN || "",

  githubTimeoutMs:
    numberEnv("GITHUB_TIMEOUT_MS", 15000),

  mcaEnabled:
    booleanEnv("MCA_ENABLED", false),

  mcaBaseUrl:
    (
      process.env.MCA_BASE_URL ||
      "https://www.mca.gov.in"
    ).replace(/\/+$/, ""),

  mcaApiKey:
    process.env.MCA_API_KEY || "",

  mcaTimeoutMs:
    numberEnv("MCA_TIMEOUT_MS", 15000),

  currentParseVersion:
    numberEnv("CURRENT_PARSE_VERSION", 1),

  outputDir:
    process.env.OUTPUT_DIR || "output",

  storageDir:
    process.env.STORAGE_DIR || "storage",

  // Application / server
  nodeEnv:
    process.env.NODE_ENV || "development",

  port:
    numberEnv("PORT", 3000),

  logLevel:
    (process.env.LOG_LEVEL || "info").toLowerCase(),

  // OpenAI (canonical OPENAI_* names; fall back to legacy LLM_OPENAI_*).
  openaiEnabled:
    booleanEnv("OPENAI_ENABLED", false),

  openaiApiKey:
    process.env.OPENAI_API_KEY ||
    process.env.LLM_OPENAI_API_KEY ||
    "",

  openaiModel:
    process.env.OPENAI_MODEL ||
    process.env.LLM_OPENAI_MODEL ||
    "gpt-4o-mini",

  openaiTimeoutMs:
    numberEnv("OPENAI_TIMEOUT_MS", 60000),

  openaiMaxRetries:
    numberEnv("OPENAI_MAX_RETRIES", 2),

  openaiMaxCallsPerRun:
    numberEnv("OPENAI_MAX_CALLS_PER_RUN", 50),

  openaiRelevanceThreshold:
    numberEnv("OPENAI_RELEVANCE_THRESHOLD", 0.5),

  relevanceEnabled:
    booleanEnv("RELEVANCE_ENABLED", true),

  relevanceBatchSize:
    numberEnv("RELEVANCE_BATCH_SIZE", 25),

  // Redis / BullMQ
  redisUrl:
    process.env.REDIS_URL || "",

  redisHost:
    process.env.REDIS_HOST || "127.0.0.1",

  redisPort:
    numberEnv("REDIS_PORT", 6379),

  redisEnabled:
    booleanEnv("REDIS_ENABLED", false),

  // Crawler hardening
  crawlMaxResponseBytes:
    numberEnv("CRAWL_MAX_RESPONSE_BYTES", 2 * 1024 * 1024),
};

const VALID_LOG_LEVELS = new Set([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

const VALID_LLM_PROVIDERS = new Set([
  "gemini",
  "openai",
]);


export function validateConfig(cfg = config) {
  const problems = [];

  if (!VALID_LOG_LEVELS.has(cfg.logLevel)) {
    problems.push(
      `LOG_LEVEL must be one of ${[...VALID_LOG_LEVELS].join(", ")}`
    );
  }

  if (
    cfg.llmEnabled &&
    !VALID_LLM_PROVIDERS.has(cfg.llmProvider)
  ) {
    problems.push(
      `LLM_PROVIDER must be one of ${[...VALID_LLM_PROVIDERS].join(", ")}`
    );
  }

  // Provider-specific API key validation
  if (
    cfg.llmEnabled &&
    cfg.llmProvider === "openai" &&
    !cfg.openaiApiKey
  ) {
    problems.push(
      "LLM_PROVIDER=openai requires OPENAI_API_KEY (or LLM_OPENAI_API_KEY)"
    );
  }

  if (
    cfg.llmEnabled &&
    cfg.llmProvider === "gemini" &&
    !cfg.geminiApiKey
  ) {
    problems.push(
      "LLM_PROVIDER=gemini requires GEMINI_API_KEY"
    );
  }

  if (
    cfg.openaiRelevanceThreshold < 0 ||
    cfg.openaiRelevanceThreshold > 1
  ) {
    problems.push(
      "OPENAI_RELEVANCE_THRESHOLD must be between 0 and 1"
    );
  }

  for (const key of [
    "openaiTimeoutMs",
    "openaiMaxRetries",
    "openaiMaxCallsPerRun",
    "crawlMaxResponseBytes",
    "port",
  ]) {
    if (!Number.isFinite(cfg[key]) || cfg[key] < 0) {
      problems.push(
        `${key} must be a non-negative number`
      );
    }
  }

  return {
    valid: problems.length === 0,
    problems,
  };
}
