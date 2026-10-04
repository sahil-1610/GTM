function clean(value) {
  return String(value || "").trim();
}

function firstValue(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[,;\n]/);
  return list.map(clean).find(Boolean) || "";
}

// Dorks quote the industry as an exact phrase, so only a short single value
// works; a full sentence or a joined list returns zero results.
export function buildDorkQueries(icp = {}) {
  const industry =
    firstValue(icp.industry) ||
    firstValue(icp.industries) ||
    firstValue(icp.company_type) ||
    firstValue(icp.company_types);

  if (!industry || industry.split(/\s+/).length > 4) {
    return [];
  }

  const location = clean(icp.location);

  const locationPart = location
    ? `"${location}"`
    : "";

  return [
    `intitle:pricing "${industry}" ${locationPart} -site:g2.com -site:capterra.com`,

    `inurl:careers "${industry}" ${locationPart}`,

    `"${industry}" ${locationPart} "about us"`,

    `"${industry}" ${locationPart} "official website"`,
  ]
    .map((query) => query.trim())
    .filter(Boolean);
}
