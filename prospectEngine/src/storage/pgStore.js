import { query } from "./pg.js";

export async function appendRawPage(page) {
  const { rows } = await query(
    `INSERT INTO raw_pages
      (url, url_hash, domain, source_type, fetch_backend, status_code, html,
       content_hash, fetched_at, parse_version, parsed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, now()),$10,$11)
     RETURNING *`,
    [page.url, page.url_hash, page.domain, page.source_type, page.fetch_backend,
      // Postgres text cannot hold NUL bytes, which some sites send.
      page.status_code, String(page.html ?? "").replace(/\u0000/g, ""), page.content_hash, page.fetched_at,
      page.parse_version, page.parsed_at]
  );
  return rows[0];
}

export async function getRawPage(id) {
  const { rows } = await query("SELECT * FROM raw_pages WHERE id = $1", [id]);
  return rows[0] || null;
}

export async function getRawPagesForParse({ parseVersion = 1, limit = 5000 } = {}) {
  const { rows } = await query(
    `SELECT * FROM raw_pages
     WHERE parse_version IS NULL OR parse_version < $1
     ORDER BY fetched_at DESC, id DESC LIMIT $2`,
    [parseVersion, limit]
  );
  return rows;
}

export async function getRawPagesForDomain(domain, { limit = 200 } = {}) {
  const { rows } = await query(
    "SELECT * FROM raw_pages WHERE domain = $1 ORDER BY fetched_at DESC, id DESC LIMIT $2",
    [domain, limit]
  );
  return rows;
}

export async function markRawPageParsed(id, parseVersion) {
  const { rows } = await query(
    `UPDATE raw_pages SET parse_version = $2, parsed_at = now()
     WHERE id = $1 RETURNING *`,
    [id, parseVersion]
  );
  return rows[0] || null;
}

export async function insertRawRecord(record) {
  const { rows } = await query(
    `INSERT INTO raw_records
      (source_type, source_ref, record_type, payload, confidence, page_id,
       status, qualification_status, qualification_reasons, run_id, product_id, product_name)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
     RETURNING *`,
    [record.source_type, record.source_ref, record.record_type,
      JSON.stringify(record.payload ?? {}), record.confidence ?? null,
      record.page_id ?? null, record.status || "pending",
      record.qualification_status ?? null,
      record.qualification_reasons == null ? null : JSON.stringify(record.qualification_reasons),
      record.run_id ?? null, record.product_id ?? null, record.product_name ?? null]
  );
  return rows[0];
}

export async function getRawRecords({ recordType, limit = 10000 } = {}) {
  const { rows } = await query(
    `SELECT * FROM raw_records
     WHERE ($1::text IS NULL OR record_type = $1)
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [recordType ?? null, limit]
  );
  return rows;
}

export async function searchCompanyIndex({ query: searchText, productId = null, limit = 50 } = {}) {
  const term = String(searchText || "").trim();
  if (!term) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const { rows } = await query(
    `WITH search AS (
       SELECT plainto_tsquery('simple', $1) AS tsq
     ), matches AS (
       SELECT r.id, r.source_type, r.source_ref, r.payload, r.confidence,
              r.status, r.qualification_status, r.qualification_reasons,
              r.created_at, r.run_id, r.product_id, r.product_name,
              regexp_replace(
                lower(split_part(regexp_replace(r.source_ref, '^https?://', '', 'i'), '/', 1)),
                '^www\\.', ''
              ) AS domain_key,
              ts_rank(
                setweight(to_tsvector('simple', coalesce(r.source_ref, '')), 'A') ||
                setweight(to_tsvector('simple', coalesce(r.payload::text, '')), 'B'),
                search.tsq
              ) AS relevance
       FROM raw_records r CROSS JOIN search
       WHERE r.record_type = 'company'
         AND (coalesce($2::text, '') = '' OR r.product_id = $2)
         AND (
           setweight(to_tsvector('simple', coalesce(r.source_ref, '')), 'A') ||
           setweight(to_tsvector('simple', coalesce(r.payload::text, '')), 'B')
         ) @@ search.tsq
     ), ranked AS (
       SELECT matches.*,
              row_number() OVER (
                PARTITION BY domain_key, coalesce(product_id, '')
                ORDER BY relevance DESC, created_at DESC, id DESC
              ) AS domain_rank
       FROM matches
     )
     SELECT id, source_type, source_ref, payload, confidence,
            status, qualification_status, qualification_reasons,
            created_at, run_id, product_id, product_name, relevance
     FROM ranked
     WHERE domain_rank = 1
     ORDER BY relevance DESC, created_at DESC
     LIMIT $3`,
    [term, productId || null, safeLimit]
  );
  return rows;
}

export async function listProductSources(productId) {
  const { rows } = await query(
    `SELECT id, product_id, product_name, source_url, enabled,
            last_crawled_at, last_discovered_count, last_error, created_at
     FROM product_sources WHERE product_id = $1 ORDER BY created_at DESC, id DESC`,
    [productId]
  );
  return rows;
}

export async function addProductSource({ productId, productName, sourceUrl }) {
  const { rows } = await query(
    `INSERT INTO product_sources (product_id, product_name, source_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (product_id, source_url) DO UPDATE SET
       product_name = EXCLUDED.product_name, enabled = true, last_error = NULL
     RETURNING id, product_id, product_name, source_url, enabled,
               last_crawled_at, last_discovered_count, last_error, created_at`,
    [productId, productName, sourceUrl]
  );
  return rows[0];
}

export async function deleteProductSource({ productId, sourceId }) {
  const { rows } = await query(
    `DELETE FROM product_sources WHERE product_id = $1 AND id = $2 RETURNING id`,
    [productId, sourceId]
  );
  return Boolean(rows[0]);
}

export async function getEnabledProductSources(productId) {
  const { rows } = await query(
    `SELECT id, product_id, product_name, source_url
     FROM product_sources WHERE product_id = $1 AND enabled = true ORDER BY id`,
    [productId]
  );
  return rows;
}

export async function markProductSourceHarvested({ sourceId, discoveredCount, error = null }) {
  await query(
    `UPDATE product_sources SET last_crawled_at = now(), last_discovered_count = $2, last_error = $3
     WHERE id = $1`,
    [sourceId, discoveredCount, error]
  );
}

export async function upsertCrawlTargets(targets = []) {
  const stored = [];
  for (const target of targets) {
    if (!target?.url) continue;
    const { rows } = await query(
      `INSERT INTO crawl_targets
        (domain, url, priority, source_type, depth, state, attempts,
         next_attempt_at, discovered_by, base_url, parent_url, title,
         anchor_text, archetype, priority_score, priority_reason,
         matched_queries, occurrences, product_id, product_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20)
       ON CONFLICT (url) DO UPDATE SET
         domain=EXCLUDED.domain, priority=LEAST(crawl_targets.priority, EXCLUDED.priority),
         source_type=EXCLUDED.source_type, depth=LEAST(crawl_targets.depth, EXCLUDED.depth),
         discovered_by=EXCLUDED.discovered_by,
         base_url=COALESCE(EXCLUDED.base_url,crawl_targets.base_url),
         parent_url=COALESCE(EXCLUDED.parent_url,crawl_targets.parent_url),
         title=COALESCE(NULLIF(EXCLUDED.title,''),crawl_targets.title),
         anchor_text=COALESCE(NULLIF(EXCLUDED.anchor_text,''),crawl_targets.anchor_text),
         archetype=COALESCE(NULLIF(EXCLUDED.archetype,''),crawl_targets.archetype),
         priority_score=GREATEST(crawl_targets.priority_score,EXCLUDED.priority_score),
         priority_reason=COALESCE(EXCLUDED.priority_reason,crawl_targets.priority_reason),
         matched_queries=(SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
           FROM jsonb_array_elements(crawl_targets.matched_queries || EXCLUDED.matched_queries)),
         occurrences=crawl_targets.occurrences+EXCLUDED.occurrences,
         product_id=COALESCE(EXCLUDED.product_id,crawl_targets.product_id),
         product_name=COALESCE(EXCLUDED.product_name,crawl_targets.product_name),
         updated_at=now()
       RETURNING *`,
      [target.domain, target.url, target.priority ?? 1, target.source_type || target.source_type || "website",
        target.depth ?? 0, target.state || "queued", target.attempts ?? 0,
        target.next_attempt_at ?? null, target.discovered_by || "unknown",
        target.baseUrl ?? target.base_url ?? null, target.parentUrl ?? target.parent_url ?? null,
        target.title ?? null, target.anchorText ?? target.anchor_text ?? "",
        target.archetype || "generic", target.priorityScore ?? target.priority_score ?? null,
        target.priorityReason ?? target.priority_reason ?? null,
        JSON.stringify(target.matchedQueries ?? target.matched_queries ?? []), target.occurrences ?? 1,
        target.productId ?? target.product_id ?? null, target.productName ?? target.product_name ?? null]
    );
    stored.push(mapCrawlTarget(rows[0]));
  }
  return stored;
}

function mapCrawlTarget(row) {
  if (!row) return null;
  return { ...row, baseUrl: row.base_url, parentUrl: row.parent_url,
    anchorText: row.anchor_text, priorityScore: row.priority_score,
    priorityReason: row.priority_reason };
}

export async function getCrawlTarget(url) {
  const { rows } = await query("SELECT * FROM crawl_targets WHERE url=$1", [url]);
  return mapCrawlTarget(rows[0]);
}

export async function getCrawlTargets({ limit = 10000 } = {}) {
  const { rows } = await query("SELECT * FROM crawl_targets ORDER BY priority, id LIMIT $1", [limit]);
  return rows.map(mapCrawlTarget);
}

export async function updateCrawlTarget(url, patch = {}) {
  const allowed = new Set([
    "state", "attempts", "next_attempt_at", "last_error", "last_loaded_url",
    "last_status_code", "last_raw_page_id", "completed_at", "failed_at",
  ]);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  if (!entries.length) return getCrawlTarget(url);
  const assignments = entries.map(([key], i) => `"${key}"=$${i + 2}`).join(", ");
  const values = entries.map(([, value]) => value);
  const { rows } = await query(
    `UPDATE crawl_targets SET ${assignments}, updated_at=now() WHERE url=$1 RETURNING *`,
    [url, ...values]
  );
  return mapCrawlTarget(rows[0]);
}

export async function isSuppressed({ domain }) {
  if (!domain) return false;
  const { rows } = await query(
    "SELECT EXISTS (SELECT 1 FROM crawl_suppressions WHERE domain=$1 AND active=true) AS suppressed",
    [domain.toLowerCase()]
  );
  return rows[0]?.suppressed === true;
}
