import assert from "node:assert/strict";

import { config } from "../src/config.js";

import {
  createProvider,
} from "../src/parse/llm/provider.js";

import {
  ARCHETYPES,
  classify,
  isContactArchetype,
  recordTypeFor,
} from "../src/parse/archetype.js";

import {
  deterministicExtract,
} from "../src/parse/deterministic/index.js";

import {
  createJinaClient,
} from "../src/parse/jina.js";

import {
  extractPage,
  parseAndPersist,
  statusForConfidence,
} from "../src/parse/index.js";

import {
  getRawPage,
  getRawPagesForParse,
} from "../src/storage/pgStore.js";

import {
  query,
  closePool,
} from "../src/storage/pg.js";

import {
  extractCompanyProfile,
  pickProfilePages,
} from "../src/extraction/companyExtractor.js";

import {
  qualifyProfile,
} from "../src/qualification/qualify.js";

const RICH_ABOUT = `
<html><head>
<title>About Us | Acme Solar</title>
<meta property="og:site_name" content="Acme Solar">
<meta name="description" content="Acme Solar is a leading provider of solar panel and renewable energy solutions in India. We implement SAP S/4HANA and ERP software for solar energy companies with cloud and AI capabilities.">
</head><body>
<h1>About Acme Solar</h1>
<p>Acme Solar provides solar panel and renewable energy solutions and SAP ERP software.</p>
</body></html>`;

const SPARSE_ABOUT = `
<html><head>
<title>Acme Innovations</title>
<meta name="description" content="Acme">
</head><body>
<h1>About Acme Innovations</h1>
<p>Acme Innovations has been delivering quality outcomes to customers across the globe for many years, focusing on innovation and excellence in every engagement we undertake for our valued partners.</p>
</body></html>`;

const RICH_MARKDOWN =
  "# Acme Innovations\nAcme Innovations is a leading provider of solar panel and renewable energy solutions with SAP ERP and cloud software across India.";

const WEAK_MARKDOWN =
  "# Acme Innovations\nAcme Innovations has been delivering quality outcomes to customers across the globe for many years, focusing on innovation and excellence in every engagement we undertake for our valued partners.";

function fakeJina({ markdown = null } = {}) {
  const calls = [];

  return {
    name: "jina",
    enabled: true,
    calls,
    async fetchMarkdown(url) {
      calls.push(url);
      return markdown;
    },
  };
}

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error.message}`);
  }
}

async function main() {
  const provider = createProvider(config);

  await test("config: LLM disabled, Jina gated", () => {
    assert.equal(config.llmEnabled, false);
    assert.equal(provider.name, "disabled");
    assert.equal(typeof config.jinaEnabled, "boolean");
  });

  await test("archetype classification precedes extraction (4 page types)", () => {
    assert.equal(classify(RICH_ABOUT, "https://acmesolar.com/about"), "about_page");
    assert.equal(classify("<html><title>x</title></html>", "https://acmesolar.com/"), "homepage");
    assert.equal(classify("<html><title>Pricing | Acme</title><body><h1>Pricing Plans</h1></body></html>", "https://acmesolar.com/pricing"), "pricing_page");
    assert.equal(classify("<html><title>Careers | Acme</title><body><h1>Join Our Team</h1></body></html>", "https://acmesolar.com/careers"), "careers_page");

    assert.equal(recordTypeFor("about_page"), "company");
    assert.equal(recordTypeFor("homepage"), "company");
    assert.equal(recordTypeFor("pricing_page"), "company");
    assert.equal(isContactArchetype("careers_page"), true);
    assert.equal(recordTypeFor("careers_page"), "contact");
  });

  await test("contact archetype is deferred (no company extraction)", async () => {
    const result = await extractPage(
      { html: "<html><title>Careers</title><body><h1>Join Our Team</h1></body></html>", url: "https://acmesolar.com/careers" },
      { provider }
    );
    assert.equal(result.deferred, true);
    assert.equal(result.recordType, "contact");
    assert.equal(result.payload, null);
  });

  await test("Tier 1 attempted first and sufficient (no Jina call)", async () => {
    const jina = fakeJina({ markdown: RICH_MARKDOWN });
    const result = await extractPage(
      { html: RICH_ABOUT, url: "https://acmesolar.com/about", content_hash: "rich" },
      { provider, jina }
    );
    assert.equal(result.tier, "deterministic");
    assert.ok(result.confidence >= 0.8, `expected tier1 >=0.8, got ${result.confidence}`);
    assert.equal(jina.calls.length, 0);
  });

  await test("Jina called only when Tier 1 is insufficient", async () => {
    const jina = fakeJina({ markdown: RICH_MARKDOWN });
    const result = await extractPage(
      { html: SPARSE_ABOUT, url: "https://acmeinnovations.com/about", content_hash: "sparse" },
      { provider, jina }
    );
    assert.equal(result.tier, "markdown");
    assert.equal(result.markdownSource, "jina");
    assert.ok(result.confidence >= 0.75, `expected tier2 >=0.75, got ${result.confidence}`);
    assert.equal(jina.calls.length, 1);
    assert.equal(jina.calls[0], "https://acmeinnovations.com/about");
  });

  await test("LLM is called 0 times (falls through to disabled provider)", async () => {
    const jina = fakeJina({ markdown: WEAK_MARKDOWN });
    const result = await extractPage(
      { html: SPARSE_ABOUT, url: "https://acmeinnovations.com/about", content_hash: "sparse2" },
      { provider, jina }
    );
    assert.equal(result.notAttempted, true);
    assert.equal(result.provider, "disabled");
  });

  await test("Jina client caches by URL (single fetch)", async () => {
    let fetches = 0;
    const client = createJinaClient(
      { ...config, jinaEnabled: true, jinaBaseUrl: "https://r.jina.ai", jinaApiKey: "", jinaTimeoutMs: 1000 },
      {
        fetchImpl: async () => {
          fetches += 1;
          return { ok: true, text: async () => "# Acme\nRich markdown" };
        },
      }
    );
    const first = await client.fetchMarkdown("https://acme.com/about");
    const second = await client.fetchMarkdown("https://acme.com/about");
    assert.ok(first);
    assert.equal(second, first);
    assert.equal(fetches, 1);
  });

  await test("confidence bands map to correct status", () => {
    assert.equal(statusForConfidence(0.9), "pending");
    assert.equal(statusForConfidence(0.7), "pending");
    assert.equal(statusForConfidence(0.5), "review");
    assert.equal(statusForConfidence(null), "review");
  });

  const ICP = { company_types: ["consulting firms", "marketing agencies"], location: "India", company_size: { max: 50 }, ideal_customer: "B2B service businesses" };
  const goodProfile = {
    company_name: "Kredis Consulting", business_type: "B2B sales consultancy", what_they_sell: "Lead generation",
    offerings: [], sells_to: "b2b", country: "India", city: "Mumbai", company_size: "small",
    is_operating_company: true, matching_target_types: ["consulting firms"],
    evidence: [{ field: "country", quote: "Mumbai, India" }],
  };

  await test("qualifyProfile: code decides from homepage facts", () => {
    assert.equal(qualifyProfile({ profile: goodProfile, icp: ICP }).status, "qualified");

    const cases = [
      [{ company_size: "large" }, "too large (large)"],
      [{ country: "United States" }, "based in United States, not India"],
      [{ sells_to: "b2c" }, "sells to consumers"],
      [{ matching_target_types: [], business_type: "courier service" }, "not a target type (courier service)"],
      [{ is_operating_company: false }, "not an operating company"],
    ];
    for (const [change, reason] of cases) {
      const result = qualifyProfile({ profile: { ...goodProfile, ...change }, icp: ICP });
      assert.equal(result.status, "not_qualified", reason);
      assert.ok(result.reasons.includes(reason), reason);
    }

    for (const change of [{ country: "" }, { company_size: "unknown" }, { sells_to: "unknown" }, { evidence: [] }]) {
      assert.equal(qualifyProfile({ profile: { ...goodProfile, ...change }, icp: ICP }).status, "review", JSON.stringify(change));
    }

    const noIcp = qualifyProfile({ profile: { ...goodProfile, company_size: "large" }, searchPlan: { location: "India", company_size: "small" } });
    assert.equal(noIcp.status, "not_qualified");
  });

  await test("extractCompanyProfile: homepage first, invented quotes and types dropped", async () => {
    const pages = [
      { url: "https://kredis.in/blog/post", html: "<title>Blog</title>" },
      { url: "https://kredis.in/about-us", html: "<title>About</title><body>Team of 12 in Mumbai</body>" },
      { url: "https://kredis.in/", html: "<title>Kredis</title><body>Kredis Consulting, Mumbai, India</body>" },
    ];
    assert.deepEqual(pickProfilePages(pages).map((p) => p.url), ["https://kredis.in/", "https://kredis.in/about-us"]);

    const provider = {
      name: "fake",
      async complete() {
        return { attempted: true, ok: true, data: { ...goodProfile, matching_target_types: ["consulting firms", "made up"], evidence: [
          { field: "country", quote: "Mumbai, India" },
          { field: "company_size", quote: "500 employees worldwide" },
        ] } };
      },
    };
    const result = await extractCompanyProfile({ domain: "kredis.in", pages: pickProfilePages(pages), provider, targetTypes: ICP.company_types });
    assert.equal(result.ok, true);
    assert.deepEqual(result.profile.evidence.map((e) => e.quote), ["Mumbai, India"]);
    assert.deepEqual(result.profile.matching_target_types, ["consulting firms"]);

    const failed = await extractCompanyProfile({ domain: "kredis.in", pages, provider: { name: "disabled" } });
    assert.equal(failed.ok, false);
  });

  const stored = await getRawPagesForParse({ parseVersion: 9999, limit: 200 });
  const companyPage = stored.find(
    (p) => !isContactArchetype(classify(p.html, p.url))
  );

  if (!companyPage) {
    console.log("        no stored company-archetype page; skipping DB tests");
  } else {
    await test("company record inserted into raw_records with provenance + confidence", async () => {
      await query(`UPDATE raw_pages SET parse_version = NULL, parsed_at = NULL WHERE id = $1`, [companyPage.id]);

      const beforeCount = (await query(`SELECT count(*)::int AS n FROM raw_records`)).rows[0].n;

      const jina = fakeJina({ markdown: null });
      const result = await parseAndPersist(
        await getRawPage(companyPage.id),
        { provider, jina, version: config.currentParseVersion }
      );

      assert.ok(result.payload, "expected a company payload");
      assert.equal(result.recordType, "company");

      const row = (await query(
        `SELECT * FROM raw_records WHERE page_id = $1 ORDER BY id DESC LIMIT 1`,
        [companyPage.id]
      )).rows[0];

      assert.ok(row, "expected a raw_record");
      assert.equal(row.record_type, "company");
      assert.equal(row.source_ref, companyPage.url);
      assert.equal(row.page_id, companyPage.id);
      assert.ok(row.confidence != null, "confidence should be stored");
      assert.ok(row.payload?.company_name, "payload.company_name should be present");

      const afterCount = (await query(`SELECT count(*)::int AS n FROM raw_records`)).rows[0].n;
      assert.ok(afterCount > beforeCount, "expected a new raw_record row");
    });

    await test("parse_version and parsed_at updated", async () => {
      const after = await getRawPage(companyPage.id);
      assert.equal(after.parse_version, config.currentParseVersion);
      assert.ok(after.parsed_at, "parsed_at should be set");
    });

    await test("existing raw_pages remain append-only", async () => {
      const countBefore = (await query(`SELECT count(*)::int AS n FROM raw_pages`)).rows[0].n;
      const before = await getRawPage(companyPage.id);

      await query(`UPDATE raw_pages SET parse_version = NULL, parsed_at = NULL WHERE id = $1`, [companyPage.id]);
      await parseAndPersist(
        await getRawPage(companyPage.id),
        { provider, jina: fakeJina({ markdown: null }), version: config.currentParseVersion }
      );

      const after = await getRawPage(companyPage.id);
      const countAfter = (await query(`SELECT count(*)::int AS n FROM raw_pages`)).rows[0].n;

      assert.equal(countAfter, countBefore, "raw_pages count must not change");
      assert.equal(after.url, before.url);
      assert.equal(after.content_hash, before.content_hash);
      assert.equal(after.html, before.html);
    });
  }

  console.log("");
  const failed = results.filter((r) => !r.ok);
  console.log(`Passed ${results.length - failed.length}/${results.length}`);

  if (failed.length) {
    console.error(`Failed ${failed.length}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("Test run failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
