const DEFAULT_SELLERS_URL = "https://pubmatic.com/sellers.json";
const CUSTOM_URL_KEY = "custom_sellers_url";

/**
 * Extracts a stable brand token from a sellers registry URL.
 *
 * @param {string} url - Absolute URL to a sellers registry endpoint.
 * @returns {string} Brand-like hostname token used for text matching.
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
function cleanDomain(input) {
  if (!input) return "";
  let d = input.trim().toLowerCase();
  try {
    // Step 1: Prefer URL parsing to avoid custom parsing edge cases.
    const withProtocol = d.includes("://") ? d : "https://" + d;
    const hostname = new URL(withProtocol).hostname;
    return hostname.replace(/^www\./, "").replace(/\.+/g, ".");
  } catch {
    // Step 2: Fallback parser keeps popup UX resilient on malformed input.
    d = d.replace(/^https?:\/\//, "");
    d = d.replace(/^www\./, "");
    d = d.replace(/\.+/g, ".");
    d = d.split(/[/?#\s,;=:@]/)[0];
    return d;
  }
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
  if (!value) return null;
  let href = value.trim();
  // Step 1: Auto-prefix protocol so plain domains become clickable links.
  if (!href.startsWith("http://") && !href.startsWith("https://")) {
    href = "https://" + href;
  }
  try {
    const url = new URL(href);
    // Step 2: Restrict protocols to prevent javascript/data URI injection.
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetches a URL with timeout and retry semantics.
 *
 * @param {string} url - Endpoint to request.
 * @param {Object} [options={}] - Retry and fetch controls.
 * @param {number} [options.timeout=8000] - Abort timeout in milliseconds.
 * @param {number} [options.retries=1] - Number of additional retry attempts.
 * @param {Object} [options.fetchOptions={}] - Additional options passed to fetch.
 * @returns {Promise<Response>} Successful Fetch API response object.
 * @throws {Error} Propagates fetch/network/http errors after final retry.
 *
 * @example
 * const response = await fetchWithTimeoutAndRetry("https://example.com/ads.txt", {
 *   timeout: 10000,
 *   retries: 2
 * });
 * const body = await response.text();
 */
async function fetchWithTimeoutAndRetry(url, { timeout = 8000, retries = 1, fetchOptions = {} } = {}) {
  // Step 1: Retry loop smooths temporary upstream/network instability.
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { signal: controller.signal, ...fetchOptions });
      clearTimeout(id);
      // Step 2: Raise non-2xx responses so retry policy can handle them.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      clearTimeout(id);
      if (attempt === retries) throw err;
      // Step 3: Lightweight backoff reduces request bursts against flaky hosts.
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}
