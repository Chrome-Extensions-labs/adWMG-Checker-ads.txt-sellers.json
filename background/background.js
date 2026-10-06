importScripts('../shared/utils.js', '../shared/network.js', '../shared/registry.js');

const CACHE_KEY = "sellers_cache";
const CACHE_TS_KEY = "sellers_ts";
const CACHE_URL_KEY = "sellers_cache_url";
const CACHE_WARNING_KEY = "sellers_cache_warning";
const BADGE_BG_COLOR = "#243b64";
const CACHE_TTL_MS = 60 * 60 * 1000;
const SCAN_COOLDOWN_MS = 60 * 1000;
const registryRequests = new Map();
const scans = new Map();
const lastScanAt = new Map();
let cacheWrites = Promise.resolve();

async function getRegistryUrl() {
  const config = await chromeCall(chrome.storage.local, "get", [CUSTOM_URL_KEY]);
  const url = normalizeSellersUrl(config[CUSTOM_URL_KEY]);
  if (!url) throw new Error("Invalid sellers.json URL. Use an HTTP or HTTPS URL without credentials.");
  return url;
}

function fetchAndCacheSellers(url) {
  if (registryRequests.has(url)) return registryRequests.get(url);
  const request = (async () => {
    const response = await fetchTextWithTimeoutAndRetry(url, {
      timeout: 12000, retries: 1, maxBytes: 20 * 1024 * 1024,
      fetchOptions: { cache: "no-store" }
    });
    const { sellers, warning } = parseSellersRegistry(response.text);
    const result = { sellers, warning, ts: Date.now(), url, stale: false, error: null };
    // Serialize writes and never let an old provider replace the current provider's cache.
    const write = cacheWrites.catch(() => {}).then(async () => {
      if (await getRegistryUrl() !== url) return;
      await chromeCall(chrome.storage.local, "set", {
        [CACHE_KEY]: sellers, [CACHE_TS_KEY]: result.ts, [CACHE_URL_KEY]: url, [CACHE_WARNING_KEY]: warning
      });
    });
    cacheWrites = write;
    await write;
    return result;
  })().finally(() => registryRequests.delete(url));
  registryRequests.set(url, request);
  return request;
}

async function getSellers(force = false) {
  const url = await getRegistryUrl();
  const cached = await chromeCall(chrome.storage.local, "get", [CACHE_KEY, CACHE_TS_KEY, CACHE_URL_KEY, CACHE_WARNING_KEY]);
  let validated;
  if (cached[CACHE_URL_KEY] === url && Array.isArray(cached[CACHE_KEY]) && Number.isFinite(cached[CACHE_TS_KEY])) {
    try { validated = parseSellersRegistry(JSON.stringify({ sellers: cached[CACHE_KEY] })); }
    catch { /* Corrupt or incompatible stored data must be refreshed, never displayed as valid. */ }
  }
  const hasCache = Boolean(validated);
  const result = { sellers: validated?.sellers || [], ts: hasCache ? cached[CACHE_TS_KEY] : 0, url,
    warning: hasCache ? validated.warning || cached[CACHE_WARNING_KEY] || "" : "" };
  const age = Date.now() - result.ts;
  if (!force && hasCache && age >= 0 && age < CACHE_TTL_MS) return { ...result, stale: false, error: null };
  try { return await fetchAndCacheSellers(url); }
  catch (error) { return { ...result, stale: hasCache, error: error.message }; }
}

function setBadge(tabId, count) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const value = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  chrome.action.setBadgeText({ tabId, text: value > 999 ? "999+" : value ? String(value) : "" }, () => { void chrome.runtime.lastError; });
  chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_BG_COLOR }, () => { void chrome.runtime.lastError; });
}

function cancelScan(tabId) {
  scans.get(tabId)?.controller.abort();
  scans.delete(tabId);
  lastScanAt.delete(tabId);
}

async function scanTab(tabId) {
  if (scans.has(tabId)) return;
  if (Date.now() - (lastScanAt.get(tabId) || 0) < SCAN_COOLDOWN_MS) return;
  const state = { controller: new AbortController() };
  scans.set(tabId, state);
  try {
    const tab = await chromeCall(chrome.tabs, "get", tabId);
    if (state.controller.signal.aborted) return;
    if (!/^https?:\/\//i.test(tab.url || "")) { setBadge(tabId, 0); return; }
    const url = await getRegistryUrl();
    const origin = new URL(tab.url).origin;
    const files = await Promise.all(["ads.txt", "app-ads.txt"].map(name =>
      fetchAdsFile(`${origin}/${name}`, { signal: state.controller.signal })));
    const currentTab = await chromeCall(chrome.tabs, "get", tabId);
    if (state.controller.signal.aborted || currentTab.url !== tab.url || await getRegistryUrl() !== url) return;
    const domain = getRegistryDomain(url);
    const count = files.reduce((sum, file) => sum + file.text.split("\n")
      .filter(raw => { const line = parseAdsLine(raw); return line.type === "data" && line.domain === domain; }).length, 0);
    setBadge(tabId, count);
    if (files.every(file => !file.isError)) lastScanAt.set(tabId, Date.now());
  } catch { /* Closed/restricted tabs and cancelled navigations require no UI update. */ }
  finally { if (scans.get(tabId) === state) scans.delete(tabId); }
}

chrome.tabs.onActivated.addListener(({ tabId }) => { void scanTab(tabId); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "loading") { cancelScan(tabId); setBadge(tabId, 0); }
  if (changeInfo.status === "complete") void scanTab(tabId);
});
chrome.tabs.onRemoved.addListener(tabId => { cancelScan(tabId); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[CUSTOM_URL_KEY]) return;
  for (const tabId of scans.keys()) cancelScan(tabId);
  lastScanAt.clear();
  chrome.tabs.query({}, tabs => {
    if (chrome.runtime.lastError) return;
    for (const tab of tabs) {
      setBadge(tab.id, 0);
      if (tab.active) void scanTab(tab.id);
    }
  });
});

async function handleMessage(message, sender) {
  if (message.type === "getSellersCache" || message.type === "refreshSellers") {
    const result = await getSellers(message.type === "refreshSellers");
    return { ...result, ok: !result.error };
  }
  if (message.type === "setBadge") {
    const fromContentScript = sender.tab && /^https?:\/\//i.test(sender.url || sender.tab.url || "");
    const tabId = fromContentScript ? sender.tab.id : message.tabId;
    if (!Number.isInteger(tabId)) throw new Error("Missing tab ID");
    const tab = await chromeCall(chrome.tabs, "get", tabId);
    if (message.tabUrl && message.tabUrl !== tab.url) return { ok: false };
    if (message.registryUrl && normalizeSellersUrl(message.registryUrl) !== await getRegistryUrl()) return { ok: false };
    setBadge(tabId, message.count);
    return { ok: true };
  }
  if (message.type === "openAnalyzer") {
    const origin = normalizeSiteUrl(message.siteUrl || message.domain);
    if (!origin) throw new Error("Invalid website URL");
    const targetUrl = chrome.runtime.getURL(`ui/analyzer/analyzer.html?site=${encodeURIComponent(origin)}`);
    await chromeCall(chrome.windows, "create", { url: targetUrl, type: "popup", width: 1050, height: 700 });
    return { ok: true };
  }
  return { ok: false, error: "Unknown message type" };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string" || (sender.id && sender.id !== chrome.runtime.id)) return false;
  handleMessage(message, sender).then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});
