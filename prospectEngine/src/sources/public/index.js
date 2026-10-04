import net from "node:net";
import { CheerioCrawler, RequestQueue } from "crawlee";

import { config } from "../../config.js";
import { normalizeUrl } from "../../lib/url.js";
import { generateSearchPlan } from "../../discovery/queryGenerator.js";
import { upsertCrawlTargets, getEnabledProductSources, markProductSourceHarvested } from "../../storage/pgStore.js";
import { crawlTargets } from "../../crawl/crawlers.js";
import { runExtraction } from "../../pipeline.js";
import { isBlockedDomain } from "../../relevance/blocklist.js";

const INTERNAL_PATH_HINT = /\/(?:member|members|directory|companies|company|exhibitor|exhibitors|supplier|suppliers|vendor|vendors|listing|listings|profile|profiles|provider|providers)(?:\/|$)|\/page\/\d+|[?&](?:page|p)=\d+/i;
const SKIP_PATH = /\.(?:jpg|jpeg|png|gif|webp|svg|pdf|css|js|zip|woff2?)(?:$|\?)/i;
const MAX_INTERNAL_PAGES_PER_SOURCE = 12;
const MAX_CANDIDATES_PER_SOURCE = 500;

function hasPublicHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  const version = net.isIP(host);
  if (version === 4) {
    const octets = host.split(".").map(Number);
    return !(octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168));
  }
  if (version === 6) return !(host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"));
  return true;
}

function safeSourceUrl(raw) {
  const normalized = normalizeUrl(raw);
  if (!normalized) throw new Error("Source URL must use http or https.");
  const parsed = new URL(normalized.normalizedUrl);
  if (!hasPublicHost(parsed.hostname)) throw new Error("Source URL must use a public hostname.");
  return { ...normalized, hostname: parsed.hostname };
}

// Crawls listing pages (directories, member lists, listicles) and returns the
// external company websites they link to, one candidate per domain.
export async function collectOutboundCompanies(sources, { followInternal = true, maxCandidatesPerSource = MAX_CANDIDATES_PER_SOURCE } = {}) {
  const sourceInfo = new Map();
  const internalPages = new Map();
  const sourceDomains = new Map();
  const candidates = new Map();
  const errors = new Map();
  const requests = [];
  for (const source of sources) {
    const id = String(source.id);
    let normalized;
    try { normalized = safeSourceUrl(source.url); } catch (error) { errors.set(id, error.message); continue; }
    sourceInfo.set(id, { hostname: normalized.hostname });
    internalPages.set(id, 0);
    sourceDomains.set(id, new Set());
    requests.push({ url: normalized.normalizedUrl, userData: { sourceId: id, sourceDepth: 0 } });
  }
  if (!requests.length) return { candidates: [], countsBySource: new Map(), errors };

  const requestQueue = await RequestQueue.open(`outbound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const crawler = new CheerioCrawler({
    requestQueue,
    maxRequestsPerCrawl: Math.min(requests.length * (followInternal ? MAX_INTERNAL_PAGES_PER_SOURCE + 1 : 1), 500),
    maxConcurrency: Math.min(config.crawlMaxConcurrency, 4),
    maxRequestsPerMinute: Math.min(config.crawlMaxRequestsPerMinute, 30),
    maxRequestRetries: 1,
    requestHandlerTimeoutSecs: config.crawlRequestTimeoutSecs,
    respectRobotsTxtFile: true,
    retryOnBlocked: false,
    async requestHandler({ request, $, response, addRequests, log }) {
      const sourceId = String(request.userData.sourceId);
      const source = sourceInfo.get(sourceId);
      if (!source) return;
      const depth = Number(request.userData.sourceDepth || 0);
      const contentType = String(response?.headers?.["content-type"] || "").toLowerCase();
      if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml")) return;
      const pageTitle = $("title").first().text().replace(/\s+/g, " ").trim().slice(0, 200);

      const internal = [];
      $("a[href]").each((_, element) => {
        const anchor = $(element);
        if (anchor.closest("nav, header, footer").length) return;
        const href = anchor.attr("href");
        if (!href) return;
        let url;
        try { url = new URL(href, request.loadedUrl || request.url); } catch { return; }
        if (url.protocol !== "http:" && url.protocol !== "https:") return;
        if (SKIP_PATH.test(url.pathname) || /\/login|\/signup|\/privacy|\/terms/i.test(url.pathname)) return;

        const normalized = normalizeUrl(url.toString());
        if (!normalized || !hasPublicHost(url.hostname)) return;
        const title = anchor.text().replace(/\s+/g, " ").trim().slice(0, 300);

        if (url.hostname.toLowerCase() === source.hostname.toLowerCase()) {
          if (followInternal && depth === 0 && INTERNAL_PATH_HINT.test(`${url.pathname}${url.search}`) && internalPages.get(sourceId) < MAX_INTERNAL_PAGES_PER_SOURCE) {
            internalPages.set(sourceId, internalPages.get(sourceId) + 1);
            internal.push({ url: normalized.normalizedUrl, userData: { sourceId, sourceDepth: 1 } });
          }
          return;
        }

        if (isBlockedDomain(normalized.domain) || normalized.domain === source.hostname) return;
        const seenForSource = sourceDomains.get(sourceId);
        if (seenForSource.has(normalized.domain) || seenForSource.size >= maxCandidatesPerSource) return;
        seenForSource.add(normalized.domain);
        const existing = candidates.get(normalized.domain);
        if (!existing || (!existing.title && title)) {
          candidates.set(normalized.domain, {
            domain: normalized.domain,
            url: normalized.baseUrl,
            baseUrl: normalized.baseUrl,
            title,
            anchorText: title,
            sourceId,
            parentUrl: request.loadedUrl || request.url,
            parentTitle: pageTitle,
          });
        }
      });
      if (internal.length) await addRequests(internal);
      log.info(`Source ${sourceId}: collected links from ${request.url}`);
    },
    failedRequestHandler({ request }, error) {
      errors.set(String(request.userData.sourceId), error?.message || "Source fetch failed");
    },
  });

  try {
    await crawler.run(requests);
  } finally {
    await requestQueue.drop();
  }

  const countsBySource = new Map([...sourceDomains].map(([id, domains]) => [id, domains.size]));
  return { candidates: [...candidates.values()], countsBySource, errors };
}

export async function harvestProductSources(icp, job = null) {
  const productId = String(icp?.id || "").trim();
  const productName = String(icp?.name || "").trim();
  if (!productId || !productName) throw new Error("A product profile is required to harvest sources.");

  const sources = await getEnabledProductSources(productId);
  if (!sources.length) throw new Error(`Add at least one public source URL for ${productName} first.`);

  await job?.updateProgress({ stage: "sources", detail: `Crawling ${sources.length} public source${sources.length === 1 ? "" : "s"}` });
  const matchedQueries = [productName, ...(icp.industries || []), ...(icp.company_types || [])].filter(Boolean);
  const { candidates, countsBySource, errors: sourceErrors } = await collectOutboundCompanies(
    sources.map((source) => ({ id: source.id, url: source.source_url })),
  );
  const targetList = candidates
    .slice(0, Math.max(config.discoveryLimit, config.crawlMaxCandidates))
    .map((candidate) => ({ ...candidate, matchedQueries }));
  for (const source of sources) {
    const id = String(source.id);
    const count = countsBySource.get(id) || 0;
    await markProductSourceHarvested({ sourceId: source.id, discoveredCount: count, error: sourceErrors.get(id) || null });
  }

  const targets = await upsertCrawlTargets(targetList.map((candidate, index) => ({
    ...candidate,
    priority: index + 1,
    source_type: "public_source",
    depth: 0,
    state: "queued",
    discovered_by: `source:${candidate.sourceId}`,
    archetype: "generic",
    occurrences: 1,
    productId,
    productName,
  })));

  await job?.updateProgress({ stage: "crawl", detail: `Found ${targets.length} company domains; crawling up to ${config.crawlMaxCandidates}` });
  const crawl = await crawlTargets(targets);
  const processedTargets = targets.slice(0, config.crawlMaxCandidates);
  const domains = new Set(processedTargets.map((target) => target.domain).filter(Boolean));

  await job?.updateProgress({ stage: "extraction", detail: `Extracting and qualifying ${domains.size} company websites` });
  const searchPlan = await generateSearchPlan(icp.ideal_customer || `${productName} ${icp.product_description || ""}`, icp);
  const extraction = domains.size
    ? await runExtraction({ searchPlan, domains, icp, runId: job?.id || null })
    : { pagesProcessed: 0, companyRecords: 0, contactRecords: 0 };

  await job?.updateProgress({ stage: "complete", detail: "Public source harvest finished" });
  return {
    productId,
    productName,
    sourcesProcessed: sources.length,
    candidatesFound: targetList.length,
    domainsCrawled: domains.size,
    crawl,
    extraction,
    sourceErrors: Object.fromEntries(sourceErrors),
  };
}
