import assert from "node:assert/strict";

import {
  deterministicFilter,
  classifyCandidates,
  decideFromFacts,
  rankCandidates,
} from "../src/relevance/companyRelevance.js";

import {
  isBlockedDomain,
  isListicleTitle,
} from "../src/relevance/blocklist.js";

import { config } from "../src/config.js";

function candidate(url, extra = {}) {
  return {
    url,
    domain: extra.domain || new URL(url).hostname,
    title: extra.title || "",
    snippet: extra.snippet || "",
  };
}

function facts(domain, extra = {}) {
  return {
    domain,
    type: extra.type || "company",
    is_company_website: extra.is_company_website ?? true,
    matches_search_plan: extra.matches_search_plan ?? true,
    sells_what_target_needs: extra.sells_what_target_needs ?? false,
    is_large_enterprise: extra.is_large_enterprise ?? false,
    reason_code: extra.reason_code || "matches_industry",
    evidence: extra.evidence || "solar company",
  };
}

function fakeProvider(handler) {
  const calls = [];

  return {
    name: "openai",
    calls,
    async complete(input) {
      calls.push(input);

      return handler(input, calls.length);
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
  await test("blocklist suffix-matches root domains and subdomains", () => {
    assert.equal(isBlockedDomain("linkedin.com"), true);
    assert.equal(isBlockedDomain("jobs.linkedin.com"), true);
    assert.equal(isBlockedDomain("blog.medium.com"), true);
    assert.equal(isBlockedDomain("zoominfo.com"), true);
    assert.equal(isBlockedDomain("stanford.edu"), true);
    assert.equal(isBlockedDomain("acme.com"), false);
  });

  await test("obvious listicle titles are rejected before LLM", () => {
    assert.equal(isListicleTitle("Top 10 Companies Using SAP"), true);
    assert.equal(isListicleTitle("List of SAP Companies in India"), true);
    assert.equal(isListicleTitle("Best 25 Solar Companies"), true);
    assert.equal(isListicleTitle("Acme Solar — Renewable Energy"), false);
  });

  await test("deterministic filter rejects malformed/assets/blocked/listicle/dupes", () => {
    const { accepted, rejected } = deterministicFilter([
      { url: "not a url" },
      { url: "https://acme.com/report.pdf" },
      { url: "https://jobs.linkedin.com/company/acme" },
      { url: "https://acme.com/about", title: "Top 10 Solar Companies" },
      { url: "https://acme.com/solar" },
      { url: "https://acme.com/solar" },
    ]);

    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].url, "https://acme.com/solar");

    const reasons = rejected.map((r) => r.reason_code).sort();
    assert.ok(reasons.includes("malformed_url"));
    assert.ok(reasons.includes("non_html_asset"));
    assert.ok(reasons.includes("excluded_domain"));
    assert.ok(reasons.includes("listicle_title"));
    assert.ok(reasons.includes("duplicate_url"));
  });

  await test("classifyCandidates validates facts-only structured output", async () => {
    const valid = fakeProvider(() => ({
      attempted: true,
      ok: true,
      data: { decisions: [facts("acme.com")] },
    }));

    const ok = await classifyCandidates(
      valid,
      { userQuery: "solar companies", searchPlan: null },
      [{ domain: "acme.com", title: "", snippet: "", url: "https://acme.com" }],
    );

    assert.equal(ok.ok, true);
    assert.equal(ok.decisions.length, 1);

    const invalid = fakeProvider(() => ({
      attempted: true,
      ok: true,
      data: { decisions: [{ domain: "acme.com" }] },
    }));

    const bad = await classifyCandidates(
      invalid,
      { userQuery: "solar companies", searchPlan: null },
      [{ domain: "acme.com", title: "", snippet: "", url: "https://acme.com" }],
    );

    assert.equal(bad.ok, false);
    assert.match(bad.error, /invalid relevance output/);
  });

  await test("decideFromFacts: code decides, LLM score never qualifies", () => {
    assert.equal(
      decideFromFacts(facts("acme.com"), { providerName: "openai" }).status,
      "approved",
    );
    assert.equal(
      decideFromFacts(facts("acme.com", { is_company_website: false })).status,
      "rejected",
    );
    assert.equal(
      decideFromFacts(facts("acme.com", { type: "directory" })).status,
      "rejected",
    );
    assert.equal(
      decideFromFacts(facts("acme.com", { matches_search_plan: false })).status,
      "rejected",
    );
    assert.equal(
      decideFromFacts(facts("acme.com", { sells_what_target_needs: true })).reason_code,
      "vendor_not_buyer",
    );
    assert.equal(
      decideFromFacts(facts("tcs.com", { is_large_enterprise: true }), { searchPlan: { company_size: "small" } }).reason_code,
      "too_large",
    );
    assert.equal(
      decideFromFacts(facts("tcs.com", { is_large_enterprise: true }), { searchPlan: { company_size: "any" } }).status,
      "approved",
    );
    assert.equal(decideFromFacts(null).status, "review");
  });

  await test("rankCandidates fails closed when provider fails", async () => {
    const provider = fakeProvider(() => ({
      attempted: true,
      ok: false,
      error: "boom",
    }));

    const result = await rankCandidates({
      userQuery: "solar companies",
      candidates: [
        candidate("https://acme.com/about"),
        candidate("https://acme.com/solar"),
      ],
      provider,
    });

    assert.equal(result.approved.length, 0);
    assert.equal(result.review.length, 2);
    assert.ok(
      result.review.every(
        (c) => c.relevance.status === "review",
      ),
    );
  });

  await test("rankCandidates retries a failed batch once and continues others", async () => {
    const originalBatchSize = config.relevanceBatchSize;
    config.relevanceBatchSize = 1;

    try {
      const provider = fakeProvider((input) => {
        if (/acme0\.com/.test(input.prompt)) {
          return { attempted: true, ok: false, error: "boom" };
        }

        const match = input.prompt.match(/Domain: ([a-z0-9.-]+)/);
        return {
          attempted: true,
          ok: true,
          data: { decisions: [facts(match[1])] },
        };
      });

      const result = await rankCandidates({
        userQuery: "solar companies",
        candidates: [
          candidate("https://acme0.com/about"),
          candidate("https://acme1.com/about"),
          candidate("https://acme2.com/about"),
        ],
        provider,
      });

      // acme0 failed twice -> review; acme1/acme2 still approved.
      assert.equal(result.approved.length, 2);
      assert.equal(result.review.length, 1);
      assert.equal(result.review[0].domain, "acme0.com");
      assert.equal(result.review[0].relevance.reason_code, "llm-unavailable");
    } finally {
      config.relevanceBatchSize = originalBatchSize;
    }
  });

  await test("rankCandidates judges by root domain, not individual URLs", async () => {
    const provider = fakeProvider(() => ({
      attempted: true,
      ok: true,
      data: { decisions: [facts("acme.com")] },
    }));

    const result = await rankCandidates({
      userQuery: "solar companies",
      candidates: [
        candidate("https://acme.com/about"),
        candidate("https://acme.com/team"),
        candidate("https://acme.com/pricing"),
      ],
      provider,
    });

    assert.equal(result.approved.length, 3);
    assert.equal(provider.calls.length, 1);
    assert.ok(
      result.approved.every((c) => c.relevance.status === "approved"),
    );
  });

  await test("rankCandidates batches many domains into few LLM calls", async () => {
    const candidates = Array.from(
      { length: 60 },
      (_, i) => candidate(`https://acme${i}.com/about`),
    );

    const provider = fakeProvider((input) => {
      const domains = [...input.prompt.matchAll(/Domain: ([a-z0-9.-]+)/g)].map(
        (m) => m[1],
      );
      return {
        attempted: true,
        ok: true,
        data: { decisions: domains.map((d) => facts(d)) },
      };
    });

    const result = await rankCandidates({
      userQuery: "solar companies",
      candidates,
      provider,
    });

    assert.ok(provider.calls.length < candidates.length);
    assert.equal(result.approved.length, 60);
  });

  await test("rankCandidates preserves URL provenance and facts", async () => {
    const provider = fakeProvider(() => ({
      attempted: true,
      ok: true,
      data: {
        decisions: [
          facts("acme.com", { reason_code: "matches_industry", evidence: "solar" }),
        ],
      },
    }));

    const result = await rankCandidates({
      userQuery: "solar companies",
      candidates: [
        candidate("https://acme.com/about", {
          title: "About Acme Solar",
          snippet: "Solar panels in India",
        }),
      ],
      provider,
    });

    const approved = result.approved[0];

    assert.equal(approved.url, "https://acme.com/about");
    assert.equal(approved.title, "About Acme Solar");
    assert.equal(approved.snippet, "Solar panels in India");
    assert.equal(approved.domain, "acme.com");
    assert.equal(approved.relevance.provider, "openai");
    assert.equal(approved.relevance.reason_code, "matches_industry");
    assert.equal(approved.relevance.evidence, "solar");
  });

  console.log("");
  const failed = results.filter((r) => !r.ok);
  console.log(
    `Passed ${results.length - failed.length}/${results.length}`,
  );

  if (failed.length) {
    process.exit(1);
  }
}

main();
