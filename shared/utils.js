const DEFAULT_SELLERS_URL = "https://pubmatic.com/sellers.json";
const CUSTOM_URL_KEY = "custom_sellers_url";

/**
 * Extracts a stable brand token from a sellers registry URL.
 *
 * @param {string} url - Absolute URL to a sellers registry endpoint.
 * @returns {string} Short provider name for interface labels; matching uses full domains.
 *
 * @example
 * const brand = getBrandName("https://pubmatic.com/sellers.json");
 * // brand === "pubmatic"
 */
function getBrandName(url) {
  try {
    // Step 1: Parse hostname through URL API for consistent splitting.
    const hostname = new URL(url).hostname;
    const parts = hostname.split(".");
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      const secondLast = parts[parts.length - 2];
      // Step 2: Handle ccTLD patterns (example: vendor.co.uk).
      if (parts.length > 2 && (secondLast === "co" || secondLast === "com") && last.length === 2) {
        return parts[parts.length - 3];
      }
      return secondLast;
    }
    return parts[0] || "pubmatic";
  } catch {
    return "pubmatic";
  }
}

/**
 * Normalizes user-provided domain-like input into a clean hostname.
 *
 * @param {string} input - URL, domain, or mixed text entered by a user.
 * @returns {string} Lowercased hostname without protocol, path, or leading www.
 *
 * @example
 * const domain = cleanDomain("https://www.Example.com/path?q=1");
 * // domain === "example.com"
 */
function normalizeSiteUrl(value) {
  if (typeof value !== "string" || !value.trim() || /[\s\\]/.test(value.trim())) return null;
  const input = value.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^https?:\/\//i.test(input) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(input)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : "https://" + input);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        !(normalizeAdvertisingDomain(url.hostname) || url.hostname === "localhost")) return null;
    return url.origin;
  } catch { return null; }
}

function cleanDomain(input) {
  const origin = normalizeSiteUrl(input);
  return origin ? new URL(origin).hostname.replace(/^www\./, "").replace(/\.$/, "") : "";
}

/**
 * Converts a domain or URL-ish value into a safe HTTP(S) link.
 *
 * @param {string} value - Domain or URL to convert into clickable href.
 * @returns {(string|null)} Normalized absolute URL, or null when invalid.
 *
 * @example
 * const href = safeHref("example.com");
 * // href === "https://example.com/"
 */
function safeHref(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const input = value.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^https?:\/\//i.test(input)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : "https://" + input);
    const hostname = url.hostname.replace(/\.$/, "");
    const validHost = normalizeAdvertisingDomain(hostname) ||
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname) ||
      (hostname.startsWith("[") && hostname.endsWith("]")); // IPv6 was validated by URL.
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && validHost ? url.href : null;
  } catch { return null; }
}

/** MANAGERDOMAIN's comma-delimited scope is metadata, never part of its hostname. */
function parseDomainDirective(value, fieldName) {
  const raw = typeof value === "string" ? value.trim() : "";
  const separator = fieldName === "MANAGERDOMAIN" ? raw.indexOf(",") : -1;
  const hostname = separator < 0 ? raw : raw.slice(0, separator).trim();
  const domain = normalizeAdvertisingDomain(hostname);
  return { domain, href: domain ? `https://${domain}/` : null,
    scope: separator < 0 ? "" : raw.slice(separator + 1).trim() };
}

/** Parse one ads.txt record without changing opaque, case-sensitive account IDs. */
function parseAdsLine(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return { type: "empty", raw, trimmed };
  if (trimmed.startsWith("#")) return { type: "comment", raw, trimmed };
  const data = trimmed.split("#", 1)[0].trim();
  const variable = data.match(/^([^\s=,]+)\s*=\s*(.*)$/);
  if (variable) return { type: "variable", raw, trimmed, name: variable[1].toUpperCase(), value: variable[2].trim() };
  const parts = data.split(";", 1)[0].split(",").map(part => part.trim());
  const domain = normalizeAdvertisingDomain(parts[0]);
  const error = reason => ({ type: "error", raw, trimmed, domain, reason });
  if (parts.length < 3) return error("Too few fields");
  if (parts.length > 4) return error("Too many fields");
  const pubId = parts[1];
  const relationship = parts[2].toUpperCase();
  if (!domain) return error("Invalid advertising system domain");
  if (!pubId || /\s/.test(pubId)) return error("Missing or invalid publisher ID");
  if (relationship !== "DIRECT" && relationship !== "RESELLER") return error(`Invalid relationship: ${parts[2]}`);
  if (parts[3] && /\s/.test(parts[3])) return error("Invalid certification authority ID");
  return { type: "data", raw, trimmed, domain, pubId, relationship,
    key: JSON.stringify([domain, pubId, relationship, parts[3] || ""]) };
}

function normalizeAdvertisingDomain(value) {
  if (typeof value !== "string" || !value || /[\s/\\:%@?#\[\]]/.test(value)) return "";
  try {
    const host = (/^[\x00-\x7f]+$/.test(value) ? value.toLowerCase() : new URL(`https://${value}`).hostname).replace(/\.$/, "");
    if (host.length > 253 || !host.includes(".") || !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return "";
    return host;
  } catch { return ""; }
}

function matchesRegistryDomain(line, registryUrl) {
  return line.type === "data" && line.domain === getRegistryDomain(registryUrl);
}

function getRegistryDomain(url) {
  try { return normalizeAdvertisingDomain(new URL(url).hostname.replace(/^www\./, "")); }
  catch { return ""; }
}

function getAdsStats(text) {
  const analysis = analyzeAdsText(text);
  return { lines: analysis.totalData, dupes: analysis.duplicateCount, errors: analysis.errors,
    direct: analysis.direct, reseller: analysis.reseller };
}

function createAdsAnalysis(loaded) {
  return { loaded, lines: [], totalData: 0, duplicateCount: 0, duplicateIndices: new Set(), errors: 0,
    direct: 0, reseller: 0, keySet: new Set(), linesBySSP: Object.create(null), variables: new Map() };
}

function addAdsLine(analysis, seen, raw) {
  const line = parseAdsLine(raw);
  const index = analysis.lines.length;
  analysis.lines.push(line);
  if (line.type === "variable") {
    if (!analysis.variables.has(line.name)) analysis.variables.set(line.name, []);
    analysis.variables.get(line.name).push(line.value);
  }
  if (line.type === "error") analysis.errors++;
  if (line.type !== "data") return;
  if (seen.has(line.key)) {
    analysis.duplicateIndices.add(seen.get(line.key)); analysis.duplicateIndices.add(index); analysis.duplicateCount++;
  } else seen.set(line.key, index);
  analysis.keySet.add(line.key);
  analysis.totalData++;
  if (line.relationship === "DIRECT") analysis.direct++;
  else analysis.reseller++;
  if (!analysis.linesBySSP[line.domain]) analysis.linesBySSP[line.domain] = [];
  analysis.linesBySSP[line.domain].push({ id: line.pubId, type: line.relationship });
}

function analyzeAdsText(text) {
  const analysis = createAdsAnalysis(text !== null && text !== undefined);
  if (!analysis.loaded) return analysis;
  const seen = new Map();
  for (const raw of text.split(/\r\n|\r|\n/)) addAdsLine(analysis, seen, raw);
  return analysis;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
}

function yieldTask(signal) {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new DOMException("Request cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, 0);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

async function analyzeAdsTextAsync(text, signal) {
  const analysis = createAdsAnalysis(text !== null && text !== undefined);
  if (!analysis.loaded) return analysis;
  const seen = new Map();
  const rows = text.split(/\r\n|\r|\n/);
  for (let start = 0; start < rows.length; start += 2000) {
    throwIfCancelled(signal);
    for (let i = start; i < Math.min(start + 2000, rows.length); i++) addAdsLine(analysis, seen, rows[i]);
    if (start + 2000 < rows.length) await yieldTask(signal);
  }
  return analysis;
}

function normalizeSellersUrl(value) {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return DEFAULT_SELLERS_URL;
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

/** Callback APIs always settle, including runtime.lastError and synchronous failures. */
function chromeCall(api, method, ...args) {
  return new Promise((resolve, reject) => {
    try {
      api[method](...args, result => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message || "Extension API error"));
        else resolve(result);
      });
    } catch (error) { reject(error); }
  });
}

