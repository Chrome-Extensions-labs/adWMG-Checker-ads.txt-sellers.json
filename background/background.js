importScripts('../shared/utils.js');

const CACHE_KEY = "sellers_cache";
const CACHE_TS_KEY = "sellers_ts";
const CACHE_URL_KEY = "sellers_cache_url";
const BADGE_BG_COLOR = "#243b64";
const SCAN_COOLDOWN_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;
const FETCH_RETRIES = 3;
const FIXED_CACHE_TTL_MS = 1 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5000;
const RETRY_INTERVAL_MS = 5000;
const MAX_RETRIES = 3;

const countsByTab = Object.create(null);
const lastScanAt = Object.create(null);
const scheduledTimers = Object.create(null);
const retryAttempts = Object.create(null);

async function fetchAndCacheSellers() {
  const config = await new Promise(r => chrome.storage.local.get([CUSTOM_URL_KEY], (res) => {
    if (chrome.runtime.lastError) return r({});
    r(res || {});
  }));
  const urlToFetch = config[CUSTOM_URL_KEY] || DEFAULT_SELLERS_URL;
  try {
    const res = await fetchWithTimeoutAndRetry(urlToFetch, { timeout: FETCH_TIMEOUT_MS, retries: FETCH_RETRIES });
    const data = await res.json();
    const sellers = Array.isArray(data.sellers) ? data.sellers : [];
    const items = {};
    items[CACHE_KEY] = sellers;
    items[CACHE_TS_KEY] = Date.now();
    items[CACHE_URL_KEY] = urlToFetch;
    await new Promise((resolve) => chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) return resolve();
      resolve();
    }));
    return sellers;
  } catch (err) {
    return null;
  }
}

function getCachedSellers() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CACHE_KEY, CACHE_TS_KEY, CACHE_URL_KEY, CUSTOM_URL_KEY], (res) => {
      if (chrome.runtime.lastError) return resolve({ sellers: [], ts: 0 });
      const currentUrl = res[CUSTOM_URL_KEY] || DEFAULT_SELLERS_URL;
      if (res[CACHE_URL_KEY] !== currentUrl) return resolve({ sellers: [], ts: 0 });
      resolve({
        sellers: Array.isArray(res[CACHE_KEY]) ? res[CACHE_KEY] : [],
        ts: res[CACHE_TS_KEY] || 0
      });
    });
  });
}

function applyBadgeForTab(tabId) {
  const count = countsByTab[tabId] || 0;
  const text = count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ text }, () => {
    if (chrome.runtime.lastError) return;
  });
  if (text) {
    chrome.action.setBadgeBackgroundColor({ color: BADGE_BG_COLOR }, () => {
      if (chrome.runtime.lastError) return;
    });
  }
}

function cancelScheduled(tabId) {
  const t = scheduledTimers[tabId];
  if (t) {
    clearTimeout(t);
    delete scheduledTimers[tabId];
    delete retryAttempts[tabId];
  }
}

function cleanupTab(tabId) {
  cancelScheduled(tabId);
  delete countsByTab[tabId];
  delete lastScanAt[tabId];
}

async function getSellersDomain() {
  const config = await new Promise(r => chrome.storage.local.get([CUSTOM_URL_KEY], (res) => {
    if (chrome.runtime.lastError) return r({});
    r(res || {});
  }));
  const url = config[CUSTOM_URL_KEY] || DEFAULT_SELLERS_URL;
  return getBrandName(url);
}

async function executeCountSellerLines(tabId, origin) {
  const domain = await getSellersDomain();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (originUrl, timeoutMs, filterDomain) => {
        function fetchWithTimeout(url, timeout) {
          return new Promise((resolve) => {
            const controller = new AbortController();
            const id = setTimeout(() => { controller.abort(); resolve(null); }, timeout);
            fetch(url, { signal: controller.signal, credentials: "same-origin" })
              .then(r => {
                clearTimeout(id);
                if (!r.ok) return resolve(null);
                r.text().then(t => resolve(t)).catch(() => resolve(null));
              })
              .catch(() => { clearTimeout(id); resolve(null); });
          });
        }
        function countSellerLines(text, brand) {
          if (!text) return 0;
          return text.replace(/\r\n|\r/g, "\n").split("\n").filter(l => l.toLowerCase().includes(brand.toLowerCase())).length;
        }
        return (async () => {
          const baseUrl = originUrl.replace(/\/$/, "");
          const [adsText, appAdsTextLocal] = await Promise.all([
            fetchWithTimeout(baseUrl + "/ads.txt", timeoutMs),
            fetchWithTimeout(baseUrl + "/app-ads.txt", timeoutMs)
          ]);
          return {
            ok: true,
            adsCount: countSellerLines(adsText, filterDomain),
            appAdsLocalFailed: appAdsTextLocal === null,
            appAdsCountLocal: countSellerLines(appAdsTextLocal, filterDomain)
          };
        })();
      },
      args: [origin, FETCH_TIMEOUT_MS, domain],
      world: "ISOLATED"
    });

    if (!Array.isArray(results) || results.length === 0 || !results[0].result) return { ok: false, count: 0 };
    const res0 = results[0].result;
    let totalCount = res0.adsCount + res0.appAdsCountLocal;

    if (res0.appAdsLocalFailed) {
      const appAdsUrl = origin.replace(/\/$/, "") + "/app-ads.txt";
      try {
        const res = await fetchWithTimeoutAndRetry(appAdsUrl, { timeout: FETCH_TIMEOUT_MS, retries: 0 });
        const text = await res.text();
        totalCount += text.split("\n").filter(l => l.toLowerCase().includes(domain.toLowerCase())).length;
      } catch (e) {}
    }
    return { ok: true, count: totalCount };
  } catch (err) {
    return { ok: false, count: 0 };
  }
}

async function processScan(tabId) {
  if (Date.now() - (lastScanAt[tabId] || 0) < SCAN_COOLDOWN_MS) return null;
  lastScanAt[tabId] = Date.now();
  const tab = await new Promise((resolve) => chrome.tabs.get(tabId, (t) => {
    if (chrome.runtime.lastError) return resolve(null);
    resolve(t);
  }));
  if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) return null;
  const origin = new URL(tab.url).origin;
  const scanRes = await executeCountSellerLines(tabId, origin);
  countsByTab[tabId] = scanRes.count;
  return scanRes.count;
}

async function retryScanForTab(tabId) {
  cancelScheduled(tabId);
  const currentAttempts = (retryAttempts[tabId] || 0) + 1;
  retryAttempts[tabId] = currentAttempts;
  const matches = await processScan(tabId);
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) return;
    if (tabs && tabs[0] && tabs[0].id === tabId) applyBadgeForTab(tabId);
  });
  if (matches > 0 || currentAttempts >= MAX_RETRIES) {
    delete retryAttempts[tabId];
    return;
  }
  scheduledTimers[tabId] = setTimeout(() => retryScanForTab(tabId), RETRY_INTERVAL_MS);
}

function scheduleScan(tabId) {
  cancelScheduled(tabId);
  delete lastScanAt[tabId];
  scheduledTimers[tabId] = setTimeout(() => retryScanForTab(tabId), INITIAL_DELAY_MS);
}

chrome.tabs.onActivated.addListener((info) => { applyBadgeForTab(info.tabId); scheduleScan(info.tabId); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "loading") {
    delete countsByTab[tabId];
    cancelScheduled(tabId);
    scheduleScan(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => { cleanupTab(tabId); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "getSellersCache") {
      let cached = await getCachedSellers();
      if (!cached.ts) {
        // Return the new registry on the first request, including after changing providers.
        const sellers = await fetchAndCacheSellers();
        cached = { sellers: sellers || [], ts: sellers ? Date.now() : 0 };
      } else if ((Date.now() - cached.ts) > FIXED_CACHE_TTL_MS) {
        fetchAndCacheSellers();
      }
      sendResponse({ sellers: cached.sellers, ts: cached.ts });
    } else if (message.type === "refreshSellers") {
      const sellers = await fetchAndCacheSellers();
      sendResponse({ ok: !!sellers, sellers });
    } else if (message.type === "setBadge") {
      const count = Math.max(0, message.count || 0);
      chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" }, () => {
        if (chrome.runtime.lastError) return;
      });
      chrome.action.setBadgeBackgroundColor({ color: BADGE_BG_COLOR }, () => {
        if (chrome.runtime.lastError) return;
      });
      sendResponse({ ok: true });
    } else if (message.type === "openAnalyzer") {
      const targetUrl = chrome.runtime.getURL(`ui/analyzer/analyzer.html?domain=${message.domain || ""}`);
      chrome.windows.create({
        url: targetUrl,
        type: "popup",
        width: 1050,
        height: 700
      });
      sendResponse({ ok: true });
    }
  })();
  return true;
});
