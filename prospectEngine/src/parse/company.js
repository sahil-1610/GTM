const TECH_KEYWORDS = [
  "sap",
  "s/4hana",
  "erp",
  "crm",
  "cloud",
  "ai",
  "machine learning",
  "iot",
  "software",
];

const PRODUCT_KEYWORDS = [
  "solar panel",
  "solar module",
  "solar",
  "inverter",
  "renewable energy",
  "energy",
  "platform",
  "solution",
  "services",
];

const INDUSTRY_KEYWORDS = [
  "solar",
  "renewable energy",
  "energy",
  "manufacturing",
  "technology",
  "software",
];

function scanKeywords(text, keywords) {
  const lower = String(text || "").toLowerCase();

  const matches = keywords.filter(
    (keyword) => lower.includes(keyword)
  );

  return [...new Set(matches)];
}

export function emptyCompanyPayload() {
  return {
    company_name: "",
    legal_name: "",
    country: "",
    headquarters: "",
    industries: [],
    products_services: [],
    technology_signals: [],
    company_description: "",
    role_emails: [],
    company_phones: [],
    linkedin_url: "",
  };
}

export function buildCompanyPayload({
  companyName = "",
  description = "",
  text = "",
  roleEmails = [],
  companyPhones = [],
  linkedinUrl = "",
}) {
  const technologies = scanKeywords(text, TECH_KEYWORDS);
  const products = scanKeywords(text, PRODUCT_KEYWORDS);
  const industries = scanKeywords(text, INDUSTRY_KEYWORDS);

  return {
    company_name: String(companyName || "").trim(),
    legal_name: "",
    country: "",
    headquarters: "",
    industries,
    products_services: products,
    technology_signals: technologies.map(
      (technology) => ({
        technology,
        relationship: "mentions",
        evidence_ids: [],
        explanation: "",
      })
    ),
    company_description: String(description || "").trim(),
    role_emails: [...new Set(roleEmails || [])],
    company_phones: [...new Set(companyPhones || [])],
    linkedin_url: linkedinUrl,
  };
}

export function computeCompanyConfidence(payload) {
  if (!payload) {
    return 0;
  }

  let score = 0;

  if (payload.company_name) {
    score += 0.35;
  }

  const description = payload.company_description || "";

  if (description.length >= 50) {
    score += 0.3;
  } else if (description.length > 0) {
    score += 0.15;
  }

  if (payload.products_services?.length) {
    score += 0.2;
  }

  if (payload.technology_signals?.length) {
    score += 0.1;
  }

  if (payload.industries?.length) {
    score += 0.05;
  }

  return Math.round(Math.min(1, score) * 100) / 100;
}

export function domainFromUrl(url) {
  try {
    return new URL(url).hostname
      .replace(/^www\./, "")
      .replace(/\.[a-z]{2,}$/i, "");
  } catch {
    return "";
  }
}
