// Code-based company qualification.
// Combines a product-specific ICP with the query-specific searchPlan.
//
// The LLM is NOT involved in this decision.
// Qualification is deterministic and happens after company extraction.
//
// Returns:
//   "qualified"
//   "not_qualified"
//   "review"
//
// IMPORTANT:
// Unknown / insufficient evidence must never become "qualified".


const NON_COMPANY_RE = /\b(directory|aggregator|marketplace|listicle|job board|review site|newsroom|magazine|publication|blog|wiki|tutorial|university|college|academy|forum|classifieds?|conference|event|summit|exhibition|expo)\b/i;
const INDIA_RE = /\b(india|indian)\b/i;
const ICP_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "who", "which", "their", "your",
  "company", "companies", "business", "businesses", "based", "looking", "target", "customer", "customers",
]);

function listValues(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

function evaluateProductIcp(profile, icp) {
  if (!profile?.company_name) {
    return { status: "review", reasons: ["missing company name"], evidence: [] };
  }

  const text = profileText(profile).toLowerCase();
  if (NON_COMPANY_RE.test(text)) {
    return { status: "not_qualified", reasons: ["not a real operating company"], evidence: ["non-company signal detected"] };
  }

  const targetPhrases = [...new Set([
    ...listValues(icp?.company_types || icp?.companyTypes),
    ...listValues(icp?.industries),
  ])];
  if (!targetPhrases.length) {
    return { status: "review", reasons: ["product ICP has no target company types or industries"], evidence: [] };
  }

  const exactMatches = targetPhrases.filter((phrase) => text.includes(phrase.toLowerCase()));
  if (exactMatches.length) {
    return { status: "qualified", reasons: [], evidence: [`matches target type: ${exactMatches.join(", ")}`] };
  }

  const terms = new Set(
    targetPhrases.flatMap((phrase) => tokenize(phrase)).filter((term) => !ICP_STOP_WORDS.has(term)),
  );
  const matchedTerms = [...terms].filter((term) => text.includes(term));
  if (matchedTerms.length >= 2) {
    return { status: "qualified", reasons: [], evidence: [`matches target terms: ${matchedTerms.join(", ")}`] };
  }
  if (matchedTerms.length === 1) {
    return { status: "review", reasons: ["partial match to product ICP"], evidence: [`matches target term: ${matchedTerms[0]}`] };
  }
  return { status: "not_qualified", reasons: ["does not match product ICP"], evidence: [] };
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "for",
  "by",
  "with",
  "in",
  "on",
  "to",
  "from",
  "find",
  "companies",
  "company",
  "that",
  "use",
  "using",
  "uses",
  "industry",
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(
      (word) =>
        word.length >= 3 &&
        !STOP_WORDS.has(word),
    );
}

function profileText(profile) {
  return [
    profile?.company_name,
    profile?.description,
    profile?.company_description,
    profile?.industry,
    ...(profile?.industries || []),
    profile?.business_type,
    profile?.company_type,
    ...(profile?.products_services || []),
    profile?.location,
    profile?.country,
    profile?.headquarters,
    profile?.city,
  ]
    .filter(Boolean)
    .join(" ");
}

function evaluateGeography(profile, icp, searchPlan, domain) {
  const targets = [
    ...listValues(icp?.geography || icp?.locations),
    ...listValues(icp?.location),
    ...listValues(searchPlan?.location),
  ];
  const target = targets[0];
  if (!target) return { status: "qualified", reasons: [], evidence: [] };

  const text = [
    profile?.country,
    profile?.headquarters,
    profile?.location,
    profile?.city,
    profile?.description,
    profile?.company_description,
  ].filter(Boolean).join(" ");

  const isIndia = /\bindia\b/i.test(target);
  const phoneEvidence = isIndia && (profile?.company_phones || []).some((phone) => /^\s*\+91\b/.test(String(phone)));
  const domainEvidence = isIndia && /(?:^|\.)[a-z0-9-]+\.in$/i.test(String(domain || ""));
  const textEvidence = isIndia ? INDIA_RE.test(text) : new RegExp(`\\b${escapeRegExp(target)}\\b`, "i").test(text);

  if (textEvidence || phoneEvidence || domainEvidence) {
    const evidence = [
      ...(textEvidence ? [`location mentions ${target}`] : []),
      ...(phoneEvidence ? ["company phone uses India country code +91"] : []),
      ...(domainEvidence ? ["company website uses the .in country domain"] : []),
    ];
    return { status: "qualified", reasons: [], evidence };
  }

  return {
    status: "review",
    reasons: [`no ${target} location evidence on the company profile`],
    evidence: [],
  };
}

function evaluateBuyerRole(profile, icp) {
  const buyerRoles = listValues(icp?.buyer_roles || icp?.buyerRoles);
  if (!buyerRoles.length) return { status: "qualified", reasons: [], evidence: [] };

  const text = profileText(profile).toLowerCase();
  const matched = buyerRoles.filter((role) => {
    const words = role.toLowerCase().trim().split(/\s+/).map(escapeRegExp);
    const escaped = words.join("\\s+").replace(/co-founder/i, "co[- ]?founder");
    const plural = escaped.endsWith("y")
      ? `${escaped.slice(0, -1)}(?:y|ies)`
      : `${escaped}(?:s|es)?`;
    return new RegExp(`\\b${plural}\\b`, "i").test(text);
  });

  if (matched.length) {
    return {
      status: "qualified",
      reasons: [],
      evidence: [`company profile mentions buyer role: ${matched.join(", ")}`],
    };
  }

  return {
    status: "review",
    reasons: ["target buyer role is not identified on the company profile"],
    evidence: [],
  };
}

function searchPlanTerms(searchPlan) {
  return [
    ...new Set([
      ...tokenize(
        searchPlan?.product_or_technology,
      ),
      ...tokenize(
        searchPlan?.industry,
      ),
      ...tokenize(
        searchPlan?.target_description,
      ),
    ]),
  ];
}

function offeringTechnologies(profile) {
  return (
    profile?.technology_signals || []
  )
    .filter(
      (signal) =>
        signal &&
        (
          signal.relationship ===
            "offers" ||
          signal.relationship ===
            "implements"
        ),
    )
    .map((signal) =>
      String(
        signal.technology || "",
      ).toLowerCase(),
    );
}

const USAGE_PHRASES =
  /\b(?:uses?|using|runs?\s+on|built\s+on|powered\s+by|deployed\s+on|migrated\s+to|adopted|rolled\s+out)\b/i;

function escapeRegExp(value) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
}

function hasUseEvidence(
  profile,
  term,
) {
  const lower =
    String(term).toLowerCase();

  const signal = (
    profile?.technology_signals ||
    []
  ).some(
    (entry) =>
      entry &&
      (
        entry.relationship ===
          "uses" ||
        entry.relationship ===
          "integrates_with"
      ) &&
      String(
        entry.technology || "",
      )
        .toLowerCase()
        .includes(lower),
  );

  if (signal) {
    return true;
  }

  const text =
    profileText(
      profile,
    ).toLowerCase();

  const termPattern =
    new RegExp(
      `\\b${escapeRegExp(lower)}\\b`,
      "i",
    );

  return (
    termPattern.test(text) &&
    USAGE_PHRASES.test(text)
  );
}

function evaluateSearchPlanFit(
  profile,
  searchPlan,
) {
  const evidence = [];

  if (!searchPlan) {
    return {
      status: "review",
      reasons: [
        "missing search plan",
      ],
      evidence,
    };
  }

  const terms =
    searchPlanTerms(
      searchPlan,
    );

  if (!terms.length) {
    return {
      status: "review",
      reasons: [
        "no search plan terms",
      ],
      evidence,
    };
  }

  const hasContent =
    Boolean(
      profile?.company_description,
    ) ||
    (
      profile?.industries || []
    ).length > 0 ||
    (
      profile?.products_services || []
    ).length > 0;

  if (!hasContent) {
    return {
      status: "review",
      reasons: [
        "no profile evidence",
      ],
      evidence,
    };
  }

  const text =
    profileText(
      profile,
    ).toLowerCase();

  const matched =
    terms.filter(
      (term) =>
        text.includes(
          term,
        ),
    );

  if (!matched.length) {
    return {
      status: "not_qualified",
      reasons: [
        "does not match search plan",
      ],
      evidence,
    };
  }

  evidence.push(
    `matches: ${matched.join(", ")}`,
  );

  //
  // For "uses" queries, a vendor/implementation company
  // is not the intended prospect.
  //
  if (
    searchPlan.relationship ===
    "uses"
  ) {
    const offerings =
      offeringTechnologies(
        profile,
      );

    const vendorTerms =
      matched.filter(
        (term) =>
          offerings.some(
            (offering) =>
              offering.includes(
                term,
              ),
          ),
      );

    if (vendorTerms.length) {
      return {
        status:
          "not_qualified",

        reasons: [
          "sells the target technology",
        ],

        evidence: [
          `offers: ${vendorTerms.join(", ")}`,
        ],
      };
    }

    const usedTerms =
      matched.filter(
        (term) =>
          hasUseEvidence(
            profile,
            term,
          ),
      );

    if (usedTerms.length) {
      evidence.push(
        `uses: ${usedTerms.join(", ")}`,
      );
    } else {
      return {
        status: "review",

        reasons: [
          "mentions technology but no evidence of use",
        ],

        evidence,
      };
    }
  }

  return {
    status: "qualified",
    reasons: [],
    evidence,
  };
}

export function qualifyCompany({
  profile,
  searchPlan,
  domain,
  icp = null,
} = {}) {
  const reasons = [];
  const evidence = [];

  //
  // 1. Apply the active product ICP gate
  //
  const icpResult = evaluateProductIcp(profile, icp || {});

  reasons.push(
    ...(icpResult.reasons || []),
  );

  evidence.push(
    ...(icpResult.evidence || []),
  );

  if (
    icpResult.status ===
    "not_qualified"
  ) {
    return {
      status:
        "not_qualified",
      reasons,
      evidence,
    };
  }

  //
  // 2. Query-specific searchPlan gate
  //
  const plan =
    evaluateSearchPlanFit(
      profile,
      searchPlan,
    );

  reasons.push(
    ...(plan.reasons || []),
  );

  evidence.push(
    ...(plan.evidence || []),
  );

  if (
    plan.status ===
    "not_qualified"
  ) {
    return {
      status:
        "not_qualified",
      reasons,
      evidence,
    };
  }

  const geography = evaluateGeography(profile, icp || {}, searchPlan, domain);
  reasons.push(...geography.reasons);
  evidence.push(...geography.evidence);

  const buyerRole = evaluateBuyerRole(profile, icp || {});
  reasons.push(...buyerRole.reasons);
  evidence.push(...buyerRole.evidence);

  //
  // Any uncertainty stays review.
  //
  if (
    icpResult.status === "review" ||
    plan.status === "review" ||
    geography.status === "review" ||
    buyerRole.status === "review"
  ) {
    return {
      status: "review",
      reasons,
      evidence,
    };
  }

  return {
    status: "qualified",
    reasons,
    evidence,
  };
}

export function shouldDeepCrawl(
  qualification,
) {
  return (
    qualification?.status ===
    "qualified"
  );
}

// Smallest headcount in each size bucket the profile extractor returns.
const SIZE_MIN_EMPLOYEES = { solo: 1, small: 2, mid: 51, large: 501 };

export function targetTypesFor(icp, searchPlan) {
  const types = [
    ...listValues(icp?.company_types || icp?.companyTypes),
    ...listValues(icp?.industries),
  ];

  if (types.length) {
    return [...new Set(types)];
  }

  return [searchPlan?.company_type, searchPlan?.industry]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function maxTargetSize(icp, searchPlan) {
  const max = Number(icp?.company_size?.max);
  if (max > 0) return max;
  if (searchPlan?.company_size === "small") return 50;
  if (searchPlan?.company_size === "mid") return 500;
  return Infinity;
}

function targetLocation(icp, searchPlan) {
  return [
    ...listValues(icp?.geography || icp?.locations),
    ...listValues(icp?.location),
    ...listValues(searchPlan?.location),
  ][0] || "";
}

function wantsB2B(icp, searchPlan) {
  return /\bb2b\b/i.test([
    icp?.ideal_customer,
    ...listValues(icp?.company_types),
    searchPlan?.target_description,
    searchPlan?.company_type,
  ].filter(Boolean).join(" "));
}

// Decides from LLM-extracted homepage facts. Any failed check is
// not_qualified with that check as the reason; any unknown is review.
export function qualifyProfile({ profile, icp = null, searchPlan = null } = {}) {
  const failed = [];
  const unsure = [];
  const evidence = [];

  if (profile.is_operating_company === false) {
    failed.push("not an operating company");
  } else if (profile.is_operating_company == null) {
    unsure.push("unclear if it is an operating company");
  }

  const location = targetLocation(icp, searchPlan);
  if (location) {
    const country = String(profile.country || "").trim();
    const matches = country &&
      (country.toLowerCase().includes(location.toLowerCase()) ||
        location.toLowerCase().includes(country.toLowerCase()));

    if (!country) unsure.push(`no ${location} location on the site`);
    else if (!matches) failed.push(`based in ${country}, not ${location}`);
    else evidence.push(`based in ${[profile.city, country].filter(Boolean).join(", ")}`);
  }

  const maxSize = maxTargetSize(icp, searchPlan);
  if (Number.isFinite(maxSize)) {
    if (profile.company_size === "unknown") unsure.push("company size unknown");
    else if (SIZE_MIN_EMPLOYEES[profile.company_size] > maxSize) failed.push(`too large (${profile.company_size})`);
    else evidence.push(`size: ${profile.company_size}`);
  }

  if (wantsB2B(icp, searchPlan)) {
    if (profile.sells_to === "b2c") failed.push("sells to consumers");
    else if (profile.sells_to === "unknown") unsure.push("unclear if it sells to businesses");
    else evidence.push(`sells to: ${profile.sells_to}`);
  }

  if (targetTypesFor(icp, searchPlan).length) {
    if (profile.matching_target_types.length) evidence.push(`type: ${profile.matching_target_types.join(", ")}`);
    else if (profile.business_type) failed.push(`not a target type (${profile.business_type})`);
    else unsure.push("business type unknown");
  }

  if (!profile.evidence.length) {
    unsure.push("no supporting quotes found on the site");
  }

  return {
    status: failed.length ? "not_qualified" : unsure.length ? "review" : "qualified",
    reasons: [...failed, ...unsure],
    evidence,
  };
}
