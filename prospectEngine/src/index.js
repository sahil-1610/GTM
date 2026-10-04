import {
  mkdir,
  writeFile,
} from "node:fs/promises";

import {
  config,
} from "./config.js";

import {
  closePool,
} from "./storage/pg.js";

import {
  discover,
} from "./discovery/discoveryService.js";

import {
  crawlTargets,
} from "./crawl/crawlers.js";

import {
  runExtraction,
} from "./pipeline.js";

import {
  getRawRecords,
} from "./storage/pgStore.js";

const LEADERSHIP_ROLES =
  new Set([
    "cofounder",
    "founder",
    "ceo",
    "technology_leader",
    "marketing_leader",
    "revenue_leader",
    "sales_leader",
    "operations_leader",
    "executive",
  ]);

async function saveJson(
  filename,
  data,
) {
  await mkdir(
    config.outputDir,
    {
      recursive: true,
    },
  );

  const filePath =
    `${config.outputDir}/${filename}`;

  await writeFile(
    filePath,
    JSON.stringify(
      data,
      null,
      2,
    ),
    "utf8",
  );

  return filePath;
}

function domainOf(record) {
  const joined =
    String(
      record.domain || "",
    ).trim();

  if (joined) {
    return joined;
  }

  try {
    return new URL(
      record.source_ref,
    )
      .hostname.replace(
        /^www\./,
        "",
      );
  } catch {
    return "";
  }
}

function buildReport(
  companyRecords,
  contactRecords,
) {
  const companies =
    companyRecords
      .filter(
        (record) =>
          record.payload
            ?.company_name,
      )
      .map(
        (record) => ({
          domain:
            domainOf(record),

          name:
            record.payload
              .company_name,

          confidence:
            Number(
              record.confidence ??
                0,
            ),
        }),
      );

  const byDomain =
    new Map();

  for (
    const company of
      companies
  ) {
    if (
      !company.domain
    ) {
      continue;
    }

    const existing =
      byDomain.get(
        company.domain,
      );

    if (
      !existing ||
      company.confidence >
        existing.confidence
    ) {
      byDomain.set(
        company.domain,
        company,
      );
    }
  }

  const contacts =
    contactRecords.map(
      (record) => {
        const payload =
          record.payload ||
          {};

        return {
          domain:
            domainOf(record),

          name:
            payload.full_name ||
            payload.name ||
            "",

          title:
            payload.title ||
            payload.designation ||
            payload.role_category ||
            "",

          email:
            payload.email ||
            "",

          phone:
            payload.phone ||
            "",

          source_url:
            payload.source_url ||
            payload.source_urls?.[0] ||
            record.source_ref ||
            "",

          confidence:
            Number(
              record.confidence ??
                0,
            ),

          role_category:
            payload.role_category ||
            null,
        };
      },
    );

  const companiesOut = [];

  for (
    const [
      domain,
      company,
    ] of byDomain
  ) {
    const companyContacts =
      contacts
        .filter(
          (contact) =>
            contact.domain ===
            domain,
        )
        .sort(
          (a, b) =>
            b.confidence -
            a.confidence,
        )
        .slice(0, 5);

    companiesOut.push({
      ...company,

      contacts:
        companyContacts,
    });
  }

  companiesOut.sort(
    (a, b) =>
      b.confidence -
      a.confidence,
  );

  return {
    companies:
      companiesOut,

    totalContacts:
      contacts.length,

    leadershipContacts:
      contacts.filter(
        (contact) =>
          contact.role_category &&
          LEADERSHIP_ROLES.has(
            contact.role_category,
          ),
      ).length,
  };
}

function printReport(
  report,
) {
  console.log("");
  console.log(
    "========================================",
  );
  console.log(
    "FINAL RESULTS",
  );
  console.log(
    "========================================",
  );

  if (
    !report.companies.length
  ) {
    console.log(
      "No useful companies found.",
    );
    return;
  }

  report.companies.forEach(
    (company, index) => {
      console.log("");
      console.log(
        `${index + 1}. ${company.name}`,
      );

      console.log(
        `   Domain: ${company.domain}`,
      );

      console.log(
        `   Confidence: ${company.confidence}`,
      );

      if (
        !company.contacts.length
      ) {
        console.log(
          "   Contacts: none",
        );
        return;
      }

      console.log(
        "   Contacts:",
      );

      company.contacts.forEach(
        (contact) => {
          const email =
            contact.email ||
            "—";

          const phone =
            contact.phone ||
            "—";

          console.log(
            `     - ${contact.name} | ${
              contact.title || "—"
            } | ${email} | ${phone} | ${
              contact.source_url ||
              "—"
            } | ${
              contact.confidence
            }`,
          );
        },
      );
    },
  );

  console.log("");
  console.log(
    "----------------------------------------",
  );

  console.log(
    `Companies found: ${report.companies.length}`,
  );

  console.log(
    `Contacts found: ${report.totalContacts}`,
  );

  console.log(
    `Founders/leadership contacts: ${report.leadershipContacts}`,
  );
}

async function main() {
  console.log("");
  console.log(
    "========================================",
  );
  console.log(
    "PROSPECT ENGINE",
  );
  console.log(
    "========================================",
  );

  console.log("");

  console.log(
    `USER QUERY: ${config.userQuery}`,
  );

  const runId =
    `RUN-${Date.now()}`;

  //
  // 1. Discovery
  //
  const discovery =
    await discover(
      config.userQuery,
    );

  //
  // Keep the exact domains discovered during this run.
  //
  const runDomains =
    new Set(
      discovery.targets.map(
        (target) =>
          target.domain,
      ),
    );

  //
  // 2. Crawl
  //
  const crawlStats =
    await crawlTargets(
      discovery.targets,
    );

  console.log("");
  console.log(
    "========================================",
  );
  console.log(
    "PARSING STORED PAGES",
  );
  console.log(
    "========================================",
  );

  //
  // 3-4. Parse and contact extraction.
  //
  const extraction =
    await runExtraction({
      version:
        config.currentParseVersion,

      searchPlan:
        discovery.searchPlan,

      domains:
        runDomains,

      runId,
    });

  //
  // Read back only records written by this run.
  //
  const allCompanyRecords =
    await getRawRecords({
      recordType: "company",
    });

  const allContactRecords =
    await getRawRecords({
      recordType: "contact",
    });

  const companyRecords =
    allCompanyRecords.filter(
      (record) =>
        record.run_id === runId,
    );

  const contactRecords =
    allContactRecords.filter(
      (record) =>
        record.run_id === runId,
    );

  const report =
    buildReport(
      companyRecords,
      contactRecords,
    );

  const finalRun = {
    runId,

    generatedAt:
      new Date().toISOString(),

    userQuery:
      discovery.userQuery,

    discovery:
      discovery.statistics,

    crawl:
      crawlStats,

    parse: {
      pagesProcessed:
        extraction.pagesProcessed,

      companyRecords:
        extraction.companyRecords,

      domainsProcessed:
        extraction.domainsProcessed,

      contactRecords:
        extraction.contactRecords,
    },

    report: {
      companies:
        report.companies.length,

      contacts:
        report.totalContacts,

      leadership:
        report.leadershipContacts,
    },
  };

  await saveJson(
    "latest-run.json",
    finalRun,
  );

  printReport(
    report,
  );

  await closePool();
}

main().catch(
  async (error) => {
    console.error("");
    console.error(
      "PIPELINE FAILED",
    );
    console.error(
      error,
    );

    await closePool();

    process.exit(1);
  },
);