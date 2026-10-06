(() => {
  /* ═══════════════════════════════════════════════════════════════════════════
     analyzer.js — Enhanced ads.txt / app-ads.txt Analyzer
     ═══════════════════════════════════════════════════════════════════════════ */

  const FETCH_CONCURRENCY = 4;
  const registryCache = new SellerRegistryCache({ concurrency: FETCH_CONCURRENCY });

  const domainInput  = document.getElementById("domain-input");
  const analyzeBtn   = document.getElementById("analyze-btn");
  const statsBar     = document.getElementById("stats-bar");
  const workspace    = document.getElementById("workspace");
  const statusMsg    = document.getElementById("status-msg");

  const adsContent    = document.getElementById("ads-content");
  const appadsContent = document.getElementById("appads-content");

  const adsLink        = document.getElementById("ads-link");
  const appadsLink     = document.getElementById("appads-link");
  const adsRedirect    = document.getElementById("ads-redirect");
  const appadsRedirect = document.getElementById("appads-redirect");

  const adsSearchInput = document.getElementById("ads-search");
  const adsSearchCount = document.getElementById("ads-search-count");
  const adsSearchPrev  = document.getElementById("ads-search-prev");
  const adsSearchNext  = document.getElementById("ads-search-next");

  const appadsSearchInput = document.getElementById("appads-search");
  const appadsSearchCount = document.getElementById("appads-search-count");
  const appadsSearchPrev  = document.getElementById("appads-search-prev");
  const appadsSearchNext  = document.getElementById("appads-search-next");

  const adsLinePanel       = document.getElementById("ads-line-panel");
  const adsSspDropdown     = document.getElementById("ads-ssp-dropdown");
  const adsVerifyBtn       = document.getElementById("ads-verify-btn");
  const adsVerifyAllBtn    = document.getElementById("ads-verify-all-btn");
  const adsCancelBtn       = document.getElementById("ads-cancel-btn");
  const adsLineResults     = document.getElementById("ads-line-results");
  const adsVerifyProgress  = document.getElementById("ads-verify-progress");
  const adsProgressBar     = document.getElementById("ads-progress-bar");
  const adsProgressMsg     = document.getElementById("ads-progress-msg");
  const adsProgressCount   = document.getElementById("ads-progress-count");

  const appadsLinePanel       = document.getElementById("appads-line-panel");
  const appadsSspDropdown     = document.getElementById("appads-ssp-dropdown");
  const appadsVerifyBtn       = document.getElementById("appads-verify-btn");
  const appadsVerifyAllBtn    = document.getElementById("appads-verify-all-btn");
  const appadsCancelBtn       = document.getElementById("appads-cancel-btn");
  const appadsLineResults     = document.getElementById("appads-line-results");
  const appadsVerifyProgress  = document.getElementById("appads-verify-progress");
  const appadsProgressBar     = document.getElementById("appads-progress-bar");
  const appadsProgressMsg     = document.getElementById("appads-progress-msg");
  const appadsProgressCount   = document.getElementById("appads-progress-count");

  let analysisGeneration = 0;
  let analysisController;
  let panelCleanups = [];

  function setupLinkNavigation(linkEl) {
    if (!linkEl) return;
    linkEl.addEventListener("click", (e) => {
      e.preventDefault();
      const href = linkEl.href;
      if (!href || href === "#") return;
      if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: href });
      } else {
        window.open(href, "_blank", "noopener,noreferrer");
      }
    });
  }

  setupLinkNavigation(adsLink);
  setupLinkNavigation(appadsLink);

  async function fetchFile(origin, filename, signal) {
    const file = await fetchAdsFile(`${origin}/${filename}`, { force: true, signal });
    return { ...file, text: file.isError ? null : file.text, isRedirect: file.redirected || false };
  }

  function computeRatio(direct, reseller) {
    if (reseller > 0) {
      const r = direct / reseller;
      return { text: r.toFixed(1), cls: r >= 1 ? "green" : "red" };
    } else if (direct > 0) {
      return { text: "∞", cls: "green" };
    }
    return { text: "N/A", cls: "neutral" };
  }

  async function renderColumn(container, analysis, otherAnalysis, signal) {
    const { lines, duplicateIndices } = analysis;
    const otherKeySet = otherAnalysis.loaded ? otherAnalysis.keySet : null;
    await renderInBatches(container, lines, (line, idx) => {
      const el = document.createElement("span");
      el.className = "line";
      el.dataset.lineIdx = idx;
      if (line.type === "data") { el.dataset.sellerId = line.pubId; el.dataset.ssp = line.domain; }
      if (line.type === "error") {
        el.classList.add("line-error");
        el.title = line.reason;
      } else if (line.type === "data" && duplicateIndices.has(idx)) {
        el.classList.add("line-duplicate");
        el.title = "Duplicate line";
      } else if (line.type === "data" && otherKeySet && !otherKeySet.has(line.key)) {
        el.classList.add("line-discrepancy");
        el.title = "Not found in the other file";
      }
      el.textContent = line.raw;
      return el;
    }, signal);
  }

  function updateStats(prefix, analysis) {
    const totalEl = document.getElementById(`${prefix}-total`);
    const dupesEl = document.getElementById(`${prefix}-dupes`);
    const errorsEl = document.getElementById(`${prefix}-errors`);
    const ratioEl = document.getElementById(`${prefix}-ratio-display`);
    if (totalEl) totalEl.textContent = `Lines: ${analysis.loaded ? analysis.totalData : "—"}`;
    if (dupesEl) dupesEl.textContent = `Dupes: ${analysis.loaded ? analysis.duplicateCount : "—"}`;
    if (errorsEl) errorsEl.textContent = `Errors: ${analysis.loaded ? analysis.errors : "—"}`;
    if (ratioEl) {
      const ratio = computeRatio(analysis.direct, analysis.reseller);
      ratioEl.textContent = `D/R: ${ratio.text}`;
      ratioEl.className = `stat-item ratio-${ratio.cls}`;
    }
  }

  function createSearchController(searchInput, countEl, prevBtn, nextBtn, contentEl) {
    let matches = [];
    let currentIdx = -1;

    function clearHighlights() {
      contentEl.querySelectorAll("mark.search-highlight, mark.search-highlight-current").forEach(m => {
        const parent = m.parentNode;
        parent.replaceChild(document.createTextNode(m.textContent), m);
        parent.normalize();
      });
      contentEl.querySelectorAll(".line-search-match, .line-search-current").forEach(el => {
        el.classList.remove("line-search-match", "line-search-current");
      });
    }

    function highlightAllOccurrences(lineEl, query) {
      const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT, null);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      for (const node of textNodes) {
        const text = node.textContent;
        const lower = text.toLowerCase();
        let searchFrom = 0;
        const fragments = [];
        let lastEnd = 0;
        while (searchFrom < lower.length) {
          const idx = lower.indexOf(query, searchFrom);
          if (idx === -1) break;
          if (idx > lastEnd) fragments.push(document.createTextNode(text.substring(lastEnd, idx)));
          const mark = document.createElement("mark");
          mark.className = "search-highlight";
          mark.textContent = text.substring(idx, idx + query.length);
          fragments.push(mark);
          lastEnd = idx + query.length;
          searchFrom = lastEnd;
        }
        if (fragments.length === 0) continue;
        if (lastEnd < text.length) fragments.push(document.createTextNode(text.substring(lastEnd)));
        const parent = node.parentNode;
        for (const frag of fragments) parent.insertBefore(frag, node);
        parent.removeChild(node);
      }
    }

    function doSearch() {
      clearHighlights();
      matches = [];
      currentIdx = -1;
      const query = searchInput.value.trim().toLowerCase();
      if (!query) {
        countEl.textContent = "";
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        return;
      }
      const lineEls = contentEl.querySelectorAll(".line");
      lineEls.forEach(lineEl => {
        if (lineEl.textContent.toLowerCase().includes(query)) {
          matches.push(lineEl);
          lineEl.classList.add("line-search-match");
          highlightAllOccurrences(lineEl, query);
        }
      });
      if (matches.length > 0) { currentIdx = 0; focusCurrent(); }
      updateCounter();
      prevBtn.disabled = matches.length === 0;
      nextBtn.disabled = matches.length === 0;
    }

    function focusCurrent() {
      contentEl.querySelectorAll(".line-search-current").forEach(el => el.classList.remove("line-search-current"));
      contentEl.querySelectorAll("mark.search-highlight-current").forEach(m => { m.className = "search-highlight"; });
      if (currentIdx >= 0 && currentIdx < matches.length) {
        const lineEl = matches[currentIdx];
        lineEl.classList.add("line-search-current");
        const firstMark = lineEl.querySelector("mark.search-highlight");
        if (firstMark) firstMark.className = "search-highlight-current";
        lineEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
      updateCounter();
    }

    function updateCounter() {
      if (matches.length === 0) countEl.textContent = searchInput.value.trim() ? "0/0" : "";
      else countEl.textContent = `${currentIdx + 1}/${matches.length}`;
    }

    prevBtn.addEventListener("click", () => {
      if (matches.length === 0) return;
      currentIdx = (currentIdx - 1 + matches.length) % matches.length;
      focusCurrent();
    });
    nextBtn.addEventListener("click", () => {
      if (matches.length === 0) return;
      currentIdx = (currentIdx + 1) % matches.length;
      focusCurrent();
    });
    let debounceTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(doSearch, 200);
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) { if (matches.length > 0) { currentIdx = (currentIdx - 1 + matches.length) % matches.length; focusCurrent(); } }
        else { if (matches.length > 0) { currentIdx = (currentIdx + 1) % matches.length; focusCurrent(); } }
      }
    });
    return { reset: () => { clearTimeout(debounceTimer); clearHighlights(); matches = []; currentIdx = -1; countEl.textContent = ""; searchInput.value = ""; prevBtn.disabled = true; nextBtn.disabled = true; } };
  }

  const adsSearch = createSearchController(adsSearchInput, adsSearchCount, adsSearchPrev, adsSearchNext, adsContent);
  const appadsSearch = createSearchController(appadsSearchInput, appadsSearchCount, appadsSearchPrev, appadsSearchNext, appadsContent);

  function fetchSellersJson(domain, signal) {
    return registryCache.get(`https://${domain}/sellers.json`, signal);
  }

  async function runWithConcurrency(tasks, limit, signal) {
    let nextIdx = 0;
    async function worker() {
      while (nextIdx < tasks.length) {
        if (signal && signal.aborted) return;
        const idx = nextIdx++;
        await tasks[idx]();
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(limit, tasks.length); i++) workers.push(worker());
    await Promise.all(workers);
  }

  function applyStatus(statusEl, lineId, map, failed, timedOut, cancelled = false, detail = "") {
    statusEl.title = detail;
    if (cancelled) { statusEl.textContent = "Cancelled"; statusEl.className = "line-status pending"; return; }
    if (timedOut) { statusEl.textContent = "⧖ Timeout"; statusEl.className = "line-status timeout"; }
    else if (failed || !map) { statusEl.textContent = "∅ Unavailable"; statusEl.className = "line-status no-sellers"; }
    else {
      const match = map[String(lineId).trim()];
      if (!match) { statusEl.textContent = "✕ Not found"; statusEl.className = "line-status not-verified"; }
      else if (match.is_confidential === 1 || match.is_confidential === true) { statusEl.textContent = "! Confidential"; statusEl.className = "line-status confidential"; }
      else { statusEl.textContent = "✓ Verified"; statusEl.className = "line-status verified"; }
    }
  }

  function buildLineRow(lineId, type, onClickLine) {
    const row = document.createElement("div");
    row.className = "line-row";
    row.dataset.lineId = lineId;
    const idEl = document.createElement("button");
    idEl.type = "button";
    idEl.className = "line-id";
    idEl.textContent = lineId;
    idEl.title = "Click to locate in file";
    idEl.addEventListener("click", () => onClickLine(lineId));
    const typeEl = document.createElement("span");
    typeEl.className = `line-type ${type === "DIRECT" ? "direct" : "reseller"}`;
    typeEl.textContent = type;
    const statusEl = document.createElement("span");
    statusEl.className = "line-status pending";
    statusEl.textContent = "—";
    row.appendChild(idEl);
    row.appendChild(typeEl);
    row.appendChild(statusEl);
    return row;
  }

  function scrollToLine(contentEl, lineId, domain) {
    contentEl.querySelectorAll("mark.line-highlight").forEach(m => {
      const p = m.parentNode;
      p.replaceChild(document.createTextNode(m.textContent), m);
      p.normalize();
    });
    const lines = contentEl.querySelectorAll(".line");
    let target = null;
    for (const line of lines) { if (line.dataset.sellerId === lineId && line.dataset.ssp === domain) { target = line; break; } }
    if (!target) return;
    const text = target.textContent;
    const comma = text.indexOf(",");
    if (comma < 0) return;
    const fieldStart = comma + 1 + (text.slice(comma + 1).match(/^\s*/) || [""])[0].length;
    const fieldEnd = fieldStart + lineId.length;
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let offset = 0;
    for (const node of nodes) {
      const start = Math.max(0, fieldStart - offset);
      const end = Math.min(node.textContent.length, fieldEnd - offset);
      offset += node.textContent.length;
      if (start >= end) continue;
      const mark = document.createElement("mark"); mark.className = "line-highlight";
      mark.textContent = node.textContent.slice(start, end);
      node.replaceWith(document.createTextNode(node.textContent.slice(0, start)), mark, document.createTextNode(node.textContent.slice(end)));
    }
    target.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function setupLinePanel(opts) {
    const { linesBySSP, linePanel, sspDropdown, verifyBtn, verifyAllBtn, cancelBtn,
      lineResults, verifyProgress, progressBar, progressMsg, progressCount, contentEl } = opts;
    const sspList = Object.keys(linesBySSP).sort();
    const generation = analysisGeneration;
    let operation;
    let rendering = new AbortController();
    let disposed = false;
    panelCleanups.push(() => { disposed = true; operation?.abort(); rendering.abort(); });
    lineResults.replaceChildren();
    verifyProgress.classList.remove("visible");
    cancelBtn.style.display = "none";
    verifyAllBtn.style.display = "inline-block";
    verifyBtn.textContent = "Verify";
    verifyBtn.disabled = true;
    sspDropdown.disabled = false;
    verifyAllBtn.disabled = false;
    if (!sspList.length) { linePanel.style.display = "none"; return; }
    linePanel.style.display = "flex";
    sspDropdown.replaceChildren(new Option("Select SSP platform", ""));
    for (const domain of sspList) sspDropdown.appendChild(new Option(`${domain} (${linesBySSP[domain].length} lines)`, domain));
    const alive = () => !disposed && generation === analysisGeneration;
    const addRows = async (container, domain, result) => {
      await renderInBatches(container, linesBySSP[domain], line => {
        const row = buildLineRow(line.id, line.type, id => scrollToLine(contentEl, id, domain));
        if (result) applyStatus(row.querySelector(".line-status"), line.id, result.map, result.failed, result.timedOut, result.cancelled, result.error || result.warning || "");
        return row;
      }, rendering.signal);
    };
    sspDropdown.onchange = () => {
      rendering.abort(); rendering = new AbortController();
      lineResults.replaceChildren();
      const selected = sspDropdown.value;
      verifyBtn.disabled = !selected;
      if (selected) void addRows(lineResults, selected).catch(error => { if (alive() && error.name !== "AbortError") statusMsg.textContent = error.message; });
    };
    cancelBtn.onclick = () => operation?.abort();

    async function verify(all) {
      if (operation) return;
      const selected = all ? sspList : [sspDropdown.value];
      if (!selected[0]) return;
      const controller = new AbortController();
      rendering.abort(); rendering = new AbortController();
      operation = controller;
      sspDropdown.disabled = true; verifyBtn.disabled = true; verifyAllBtn.disabled = true;
      cancelBtn.style.display = "inline-block";
      verifyProgress.classList.add("visible");
      progressBar.style.width = "0%";
      progressMsg.textContent = "Checking seller IDs…";
      progressCount.textContent = `0 / ${selected.length}`;
      lineResults.replaceChildren();
      const results = new Map();
      let completed = 0;
      try {
        await runWithConcurrency(selected.map(domain => async () => {
          const result = await fetchSellersJson(domain, controller.signal);
          // Retain only IDs requested by this file, rather than every downloaded registry.
          const map = result.map ? Object.create(null) : null;
          if (map) for (const line of linesBySSP[domain]) if (result.map[line.id]) map[line.id] = result.map[line.id];
          results.set(domain, { ...result, sellers: undefined, map });
          if (!alive() || result.cancelled) return;
          completed++;
          progressBar.style.width = `${Math.round(completed / selected.length * 100)}%`;
          progressCount.textContent = `${completed} / ${selected.length}`;
        }), FETCH_CONCURRENCY, controller.signal);
        if (!alive()) return;
        for (const domain of selected) {
          if (!alive()) return;
          const group = document.createElement("div");
          group.className = all ? "ssp-group" : "";
          if (all) {
            const label = document.createElement("div"); label.className = "ssp-group-label";
            label.textContent = `${domain} (${linesBySSP[domain].length} lines)`; group.appendChild(label);
          }
          lineResults.appendChild(group);
          const rows = document.createElement("div"); group.appendChild(rows);
          await addRows(rows, domain, results.get(domain) || { cancelled: true });
        }
      } catch (error) {
        if (alive() && error.name !== "AbortError") { statusMsg.style.display = "flex"; statusMsg.textContent = error.message; }
      } finally {
        if (alive()) {
          operation = null; sspDropdown.disabled = false; verifyBtn.disabled = !sspDropdown.value;
          verifyAllBtn.disabled = false; cancelBtn.style.display = "none";
          verifyProgress.classList.remove("visible");
        }
      }
    }
    verifyBtn.onclick = () => { void verify(false); };
    verifyAllBtn.onclick = () => { void verify(true); };
  }

  async function runAnalysis(input) {
    const origin = normalizeSiteUrl(input);
    if (!origin) { statusMsg.style.display = "flex"; statusMsg.textContent = "Enter a valid HTTP or HTTPS website URL."; return; }
    const thisGeneration = ++analysisGeneration;
    analysisController?.abort();
    analysisController = new AbortController();
    const signal = analysisController.signal;
    for (const cleanup of panelCleanups) cleanup();
    panelCleanups = [];
    statusMsg.style.display = "flex";
    statusMsg.textContent = `Fetching files from ${origin}…`;
    adsLink.href = `${origin}/ads.txt`;
    appadsLink.href = `${origin}/app-ads.txt`;
    adsRedirect.style.display = "none";
    appadsRedirect.style.display = "none";
    statsBar.style.display = "none";
    workspace.style.display = "none";
    analyzeBtn.disabled = true;
    adsSearch.reset(); appadsSearch.reset();
    adsLinePanel.style.display = "none";
    appadsLinePanel.style.display = "none";
    try {
      const [adsResult, appadsResult] = await Promise.all([
        fetchFile(origin, "ads.txt", signal), fetchFile(origin, "app-ads.txt", signal)
      ]);
      throwIfCancelled(signal);
      if (adsResult.text === null && appadsResult.text === null) {
        statusMsg.textContent = `Could not fetch files from ${origin}. ads.txt: ${adsResult.error}. app-ads.txt: ${appadsResult.error}.`;
        return;
      }
      adsLink.href = adsResult.url; appadsLink.href = appadsResult.url;
      if (adsResult.isRedirect) adsRedirect.style.display = "inline-block";
      if (appadsResult.isRedirect) appadsRedirect.style.display = "inline-block";
      const [adsAnalysis, appadsAnalysis] = await Promise.all([
        analyzeAdsTextAsync(adsResult.text, signal), analyzeAdsTextAsync(appadsResult.text, signal)
      ]);
      throwIfCancelled(signal);
      statsBar.style.display = "flex"; workspace.style.display = "flex";
      updateStats("ads", adsAnalysis); updateStats("appads", appadsAnalysis);
      const renderFile = async (container, result, analysis, other) => {
        if (analysis.loaded) await renderColumn(container, analysis, other, signal);
        else {
          const message = document.createElement("span");
          message.className = "line line-error"; message.textContent = `Error: ${result.error}`;
          container.replaceChildren(message);
        }
      };
      await Promise.all([
        renderFile(adsContent, adsResult, adsAnalysis, appadsAnalysis),
        renderFile(appadsContent, appadsResult, appadsAnalysis, adsAnalysis)
      ]);
      throwIfCancelled(signal);
      statusMsg.style.display = "none";
      setupLinePanel({
        linesBySSP: adsAnalysis.linesBySSP, linePanel: adsLinePanel,
        sspDropdown: adsSspDropdown, verifyBtn: adsVerifyBtn, verifyAllBtn: adsVerifyAllBtn,
        cancelBtn: adsCancelBtn, lineResults: adsLineResults,
        verifyProgress: adsVerifyProgress, progressBar: adsProgressBar,
        progressMsg: adsProgressMsg, progressCount: adsProgressCount,
        contentEl: adsContent
      });

      setupLinePanel({
        linesBySSP: appadsAnalysis.linesBySSP, linePanel: appadsLinePanel,
        sspDropdown: appadsSspDropdown, verifyBtn: appadsVerifyBtn, verifyAllBtn: appadsVerifyAllBtn,
        cancelBtn: appadsCancelBtn, lineResults: appadsLineResults,
        verifyProgress: appadsVerifyProgress, progressBar: appadsProgressBar,
        progressMsg: appadsProgressMsg, progressCount: appadsProgressCount,
        contentEl: appadsContent
      });
    } catch (error) {
      if (thisGeneration === analysisGeneration && !signal.aborted) {
        statusMsg.style.display = "flex"; statusMsg.textContent = error.message;
      }
    } finally { if (thisGeneration === analysisGeneration) analyzeBtn.disabled = false; }
  }

  const params = new URLSearchParams(window.location.search);
  const initialDomain = normalizeSiteUrl(params.get("site") || params.get("domain") || "");
  if (initialDomain) domainInput.value = initialDomain;

  analyzeBtn.addEventListener("click", () => runAnalysis(domainInput.value));
  domainInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runAnalysis(domainInput.value); });
  window.addEventListener("pagehide", () => { analysisController?.abort(); for (const cleanup of panelCleanups) cleanup(); });
  if (initialDomain) void runAnalysis(initialDomain);
})();
