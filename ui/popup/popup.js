(() => {
  const adsTab = document.getElementById("ads-tab");
  const appAdsTab = document.getElementById("appads-tab");
  const sellerTab = document.getElementById("seller-tab");
  const output = document.getElementById("output");

  const filterArea = document.getElementById("filter-area");
  const filterLeftSection = document.getElementById("filter-left-section");
  const linkBlock = document.getElementById("link-block");
  const filterStatusText = document.getElementById("filter-status-text");

  const settingsToggle = document.getElementById("settings-toggle");
  const settingsPanel = document.getElementById("settings-panel");
  const urlInput = document.getElementById("sellers-url-input");
  const saveBtn = document.getElementById("save-settings");
  const refreshCacheBtn = document.getElementById("force-refresh-cache");

  const adsCountEl = document.getElementById("ads-line-count");
  const appAdsCountEl = document.getElementById("appads-line-count");
  const sellerCountEl = document.getElementById("seller-line-count");

  const statusContainer = document.getElementById("status-container");
  const fileDateEl = document.getElementById("file-date");
  const ownerBadgeEl = document.getElementById("owner-badge");
  const managerBadgeEl = document.getElementById("manager-badge");

  const qaBar = document.getElementById("quick-analyzer-bar");
  const qaLines = document.getElementById("qa-lines");
  const qaDupes = document.getElementById("qa-dupes");
  const qaErrors = document.getElementById("qa-errors");
  const qaRatio = document.getElementById("qa-ratio");
  const qaDR = document.getElementById("qa-dr");
  const qaBtn = document.getElementById("qa-btn");

  let adsData = { text: "", url: "", isError: false };
  let appAdsData = { text: "", url: "", isError: false };
  let sellersDataMap = new Map();
  let current = "seller";
  let isFilterActive = true;
  let currentSellersUrl = DEFAULT_SELLERS_URL;
  let currentTabDomain = "";
  let currentTabId;
  let currentTabUrl = "";
  let registryAvailable = false;
  let registryLoading = false;
  let renderController;
  let registryMessage = "";
  let loadGeneration = 0;
  let loadController;
  let loadPhase = "loading";
  let loadError = "";
  const dataStatus = document.getElementById("data-status");
  const settingsStatus = document.getElementById("settings-status");

  async function sendMessage(message) {
    let timer;
    try {
      return await Promise.race([
        chromeCall(chrome.runtime, "sendMessage", message),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Extension request timed out. Try again.")), 45000); })
      ]);
    } finally { clearTimeout(timer); }
  }

  function updateFilterText() {
    filterStatusText.textContent = `${isFilterActive ? "✔" : "✖"} Show only ${getBrandName(currentSellersUrl)}`;
    filterLeftSection.setAttribute("aria-pressed", String(isFilterActive));
  }

  function belongsToRegistry(line) {
    return Boolean(line.domain && line.domain === getRegistryDomain(currentSellersUrl));
  }

  function checkDomainField(analysis, fieldName) {
    const value = analysis.variables.get(fieldName)?.[0];
    if (!value) return { status: "NOT FOUND", value: null };
    const domain = cleanDomain(value);
    const site = cleanDomain(currentTabDomain);
    return { status: domain && site && (domain === site || site.endsWith("." + domain)) ? "MATCH" : "MISMATCH", value };
  }

  function renderBadge(element, label, result) {
    element.replaceChildren();
    element.className = `badge ${result.status === "NOT FOUND" ? "neutral" : result.status === "MATCH" ? "success" : "error"}`;
    element.textContent = `${label}: ${result.status === "MISMATCH" ? result.value : result.status}`;
    element.title = result.value || "";
  }

  async function renderText(container, lines, signal) {
    await renderInBatches(container, lines, line => {
      const raw = line.raw;
      const row = document.createElement("div");
      row.className = "line-row";
      row.textContent = raw;
      if (belongsToRegistry(line)) {
        const domainEnd = raw.indexOf(",");
        if (domainEnd >= 0) {
          const domain = document.createElement("b");
          domain.textContent = raw.slice(0, domainEnd);
          row.replaceChildren(domain, document.createTextNode(raw.slice(domainEnd)));
        }
        if (line.type === "error") { row.classList.add("line-critical-error"); row.title = line.reason; }
        else if (line.type === "data" && registryAvailable && !sellersDataMap.has(line.pubId)) {
          row.classList.add("line-warning"); row.title = "ID not found in sellers.json";
        }
        if (row.title) {
          const warning = document.createElement("span");
          warning.className = "warning-icon"; warning.textContent = " (!)"; warning.title = row.title;
          row.appendChild(warning);
        }
      }
      return row;
    }, signal);
  }

  function findSellerMatches() {
    const ids = new Set();
    for (const file of [adsData, appAdsData]) {
      for (const line of file.analysis?.lines || []) {
        if (matchesRegistryDomain(line, currentSellersUrl)) ids.add(line.pubId);
      }
    }
    return [...ids].filter(id => sellersDataMap.has(id)).map(id => sellersDataMap.get(id));
  }

  async function showCurrent() {
    renderController?.abort();
    renderController = new AbortController();
    const signal = renderController.signal;
    try {
      output.setAttribute("aria-labelledby", `${current}-tab`);
      if (loadPhase !== "ready") { output.textContent = loadPhase === "loading" ? "Loading…" : loadError; return; }
      linkBlock.replaceChildren();
      const matches = findSellerMatches();
      sellerCountEl.textContent = registryAvailable ? String(matches.length) : "—";
      filterArea.style.display = current === "seller" ? "none" : "flex";
      if (current === "seller") {
        statusContainer.style.display = "none";
        output.replaceChildren();
        if (registryLoading) output.textContent = "Loading seller registry…";
        else if (!registryAvailable) output.textContent = "Seller registry unavailable. Check the URL or use Cache to retry.";
        else if (!matches.length) output.textContent = `No ${getBrandName(currentSellersUrl)} matches.`;
        else {
          await renderInBatches(output, matches, seller => {
            const row = document.createElement("div");
            row.className = "line-row";
            if (cleanDomain(seller.domain) === cleanDomain(currentTabDomain) && currentTabDomain) row.classList.add("highlight-own-domain");
            const label = seller.domain || seller.name || (seller.is_confidential ? "Confidential seller" : "Domain not disclosed");
            row.textContent = `${label} (${seller.seller_id}) — ${seller.seller_type || "UNKNOWN"}`;
            return row;
          }, signal);
        }
        return;
      }
      const file = current === "ads" ? adsData : appAdsData;
      statusContainer.style.display = file.isError ? "none" : "flex";
      const date = new Date(file.lastModified);
      fileDateEl.textContent = file.lastModified && Number.isFinite(date.getTime()) ? `Modified: ${date.toLocaleDateString("en-GB")}` : "";
      renderBadge(ownerBadgeEl, "OWNER", checkDomainField(file.analysis, "OWNERDOMAIN"));
      renderBadge(managerBadgeEl, "MANAGER", checkDomainField(file.analysis, "MANAGERDOMAIN"));
      const href = safeHref(file.url);
      if (href) {
        const link = document.createElement("a");
        link.href = href; link.textContent = file.url; link.target = "_blank"; link.rel = "noopener noreferrer";
        linkBlock.appendChild(link);
      }
      if (file.isError) { output.textContent = `Unable to load ${current === "ads" ? "ads.txt" : "app-ads.txt"}: ${file.error}`; return; }
      const lines = file.analysis.lines.filter(line => line.raw.trim() && (!isFilterActive || belongsToRegistry(line)));
      if (!lines.length) output.textContent = isFilterActive ? `No ${getBrandName(currentSellersUrl)} matches.` : "This file is empty.";
      else await renderText(output, lines, signal);
    } catch (error) { if (!signal.aborted) dataStatus.textContent = error.message; }
  }

  function setActive(tab) {
    current = tab;
    for (const button of [adsTab, appAdsTab, sellerTab]) {
      const active = button.id === `${tab}-tab`;
      button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    showCurrent();
  }

  function updateQuickAnalyzer() {
    const ads = adsData.analysis;
    const app = appAdsData.analysis;
    const direct = ads.direct + app.direct;
    const reseller = ads.reseller + app.reseller;
    qaBar.style.display = "flex";
    qaLines.textContent = ads.totalData + app.totalData;
    qaDupes.textContent = ads.duplicateCount + app.duplicateCount;
    qaErrors.textContent = ads.errors + app.errors;
    qaRatio.textContent = `${direct} / ${reseller}`;
    qaDR.textContent = reseller ? (direct / reseller).toFixed(1) : direct ? "∞" : "—";
    qaDR.className = `qa-dr-value ${direct || reseller ? (direct >= reseller ? "dr-green" : "dr-red") : "dr-neutral"}`;
  }

  async function loadData(force = false, refresh = false) {
    const generation = ++loadGeneration;
    loadController?.abort();
    loadController = new AbortController();
    renderController?.abort();
    const signal = loadController.signal;
    loadPhase = "loading";
    registryAvailable = false; registryLoading = true; registryMessage = "";
    sellersDataMap.clear();
    output.textContent = "Loading…";
    qaBar.style.display = "none";
    output.setAttribute("aria-busy", "true");
    dataStatus.textContent = "";
    try {
      const [config, tabs] = await Promise.all([
        chromeCall(chrome.storage.local, "get", [CUSTOM_URL_KEY]),
        chromeCall(chrome.tabs, "query", { active: true, currentWindow: true })
      ]);
      if (generation !== loadGeneration) return;
      const url = normalizeSellersUrl(config[CUSTOM_URL_KEY]);
      if (!url) throw new Error("Invalid sellers.json URL. Open Settings and enter a valid HTTP or HTTPS address.");
      currentSellersUrl = url; urlInput.value = url; updateFilterText();
      const tab = tabs?.[0];
      if (!tab || !/^https?:\/\//i.test(tab.url || "")) throw new Error("Open an HTTP or HTTPS website to check its files.");
      const site = new URL(tab.url);
      currentTabDomain = site.hostname; currentTabId = tab.id; currentTabUrl = tab.url;
      const updateStatus = () => {
        dataStatus.textContent = [registryMessage, adsData.isError ? `ads.txt: ${adsData.error}` : "", appAdsData.isError ? `app-ads.txt: ${appAdsData.error}` : ""].filter(Boolean).join(" · ");
      };
      // Files and their analysis remain usable while a slow registry is downloading.
      const registryTask = sendMessage({ type: refresh ? "refreshSellers" : "getSellersCache" }).catch(error => ({ error: error.message })).then(registry => {
        if (generation !== loadGeneration) return registry;
        registryLoading = false;
        registryAvailable = Array.isArray(registry?.sellers) && (!registry.url || registry.url === url) && (!registry.error || registry.stale);
        sellersDataMap = new Map(registryAvailable ? registry.sellers.map(seller => [String(seller.seller_id).trim(), seller]) : []);
        registryMessage = registry?.error ? (registry.stale ? "Using cached seller data. " : "Seller registry unavailable. ") + registry.error : registry?.warning || "";
        if (loadPhase === "ready") { updateStatus(); void showCurrent(); }
        return registry;
      });
      const loadFile = async filename => {
        const file = await fetchAdsFile(`${site.origin}/${filename}`, { force, signal });
        return { ...file, analysis: await analyzeAdsTextAsync(file.isError ? null : file.text, signal) };
      };
      const [ads, app] = await Promise.all([loadFile("ads.txt"), loadFile("app-ads.txt")]);
      if (generation !== loadGeneration) return;
      adsData = ads; appAdsData = app;
      updateStatus();
      loadPhase = "ready";
      adsCountEl.textContent = ads.isError ? "—" : ads.analysis.totalData;
      appAdsCountEl.textContent = app.isError ? "—" : app.analysis.totalData;
      updateQuickAnalyzer(); showCurrent();
      const count = [ads, app].reduce((sum, file) => sum + file.analysis.lines.filter(line => matchesRegistryDomain(line, url)).length, 0);
      void sendMessage({ type: "setBadge", tabId: currentTabId, tabUrl: currentTabUrl, registryUrl: url, count }).catch(() => {});
      output.setAttribute("aria-busy", "false");
      const registry = await registryTask;
      return !registry?.error && !ads.isError && !app.isError;
    } catch (error) {
      if (generation !== loadGeneration || signal.aborted) return;
      loadPhase = "error"; loadError = error.message;
      output.textContent = loadError;
      adsCountEl.textContent = "—"; appAdsCountEl.textContent = "—"; sellerCountEl.textContent = "—";
      qaBar.style.display = "none";
      return false;
    } finally { if (generation === loadGeneration) output.setAttribute("aria-busy", "false"); }
  }

  settingsToggle.addEventListener("click", () => {
    const expanded = settingsPanel.style.display === "none";
    settingsPanel.style.display = expanded ? "flex" : "none";
    settingsToggle.setAttribute("aria-expanded", String(expanded));
    if (expanded) urlInput.focus();
  });

  async function runSettingsAction(save) {
    if (saveBtn.disabled) return;
    settingsStatus.textContent = "";
    const url = normalizeSellersUrl(urlInput.value);
    if (save && !url) { settingsStatus.textContent = "Enter an HTTP or HTTPS URL without credentials."; urlInput.setAttribute("aria-invalid", "true"); urlInput.focus(); return; }
    saveBtn.disabled = true; refreshCacheBtn.disabled = true;
    refreshCacheBtn.textContent = "…";
    try {
      if (save) { await chromeCall(chrome.storage.local, "set", { [CUSTOM_URL_KEY]: url }); urlInput.removeAttribute("aria-invalid"); }
      const ok = await loadData(true, true);
      settingsStatus.textContent = ok ? (save ? "Settings saved; files refreshed." : "Files and registry refreshed.") : "Refresh failed. See the error message above.";
    } catch (error) { settingsStatus.textContent = error.message; }
    finally { saveBtn.disabled = false; refreshCacheBtn.disabled = false; refreshCacheBtn.textContent = "Cache"; }
  }
  saveBtn.addEventListener("click", () => { void runSettingsAction(true); });
  refreshCacheBtn.addEventListener("click", () => { void runSettingsAction(false); });
  urlInput.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void runSettingsAction(true); } });
  adsTab.addEventListener("click", () => setActive("ads"));
  appAdsTab.addEventListener("click", () => setActive("appads"));
  sellerTab.addEventListener("click", () => setActive("seller"));
  filterLeftSection.addEventListener("click", () => {
    isFilterActive = !isFilterActive; filterArea.classList.toggle("active", isFilterActive); updateFilterText(); showCurrent();
  });
  qaBtn.addEventListener("click", () => {
    void sendMessage({ type: "openAnalyzer", siteUrl: currentTabUrl }).then(result => {
      if (!result?.ok) dataStatus.textContent = result?.error || "Unable to open the analyzer.";
    }).catch(error => { dataStatus.textContent = error.message; });
  });
  const tabs = [sellerTab, adsTab, appAdsTab];
  for (const [index, tab] of tabs.entries()) {
    tab.tabIndex = index === 0 ? 0 : -1;
    tab.setAttribute("aria-controls", "output");
    tab.addEventListener("keydown", event => {
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); tabs[next].click(); tabs[next].focus();
    });
  }
  window.addEventListener("pagehide", () => { loadController?.abort(); renderController?.abort(); });
  filterArea.classList.add("active");
  void loadData();
})();
