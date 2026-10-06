(async () => {
  // Only replace a plain-text ads file, never an HTML error page or a similarly named page.
  if (!document.body || document.getElementById("lines-checker-style") ||
      document.documentElement.hasAttribute("data-lines-checker-viewer") ||
      !/\/(?:app-)?ads\.txt$/i.test(window.location.pathname) || document.contentType === "text/html") return;
  const rawText = document.body.textContent || document.body.innerText || "";

  if (rawText.length > 5 * 1024 * 1024) return;
  document.documentElement.setAttribute("data-lines-checker-viewer", "loading");
  const analysis = await analyzeAdsTextAsync(rawText);
  const field = name => analysis.variables.get(name)?.[0] || null;
  const owner = field("OWNERDOMAIN");
  const manager = field("MANAGERDOMAIN");
  const contact = field("CONTACT");
  const contactEmail = field("CONTACT-EMAIL");
  const isAdsTxt = analysis.totalData > 0 || analysis.variables.size > 0;

  if (!isAdsTxt) { document.documentElement.removeAttribute("data-lines-checker-viewer"); return; }
  const style = document.createElement('style');
  style.id = 'lines-checker-style';
  style.textContent = `
    :root {
      --bg-color: #ffffff;
      --text-color: #24292f;
      --comment-color: #6e7781;
      --key-color: #0550ae;
      --value-color: #0a3069;
      --domain-color: #243b64;
      --pubid-color: #9a6700;
      --direct-color: #28518a;
      --reseller-color: #d1242f;
      --overlay-bg: rgba(255, 255, 255, 0.95);
      --overlay-border: #d0d7de;
      --overlay-text: #24292f;
      --overlay-title: #57606a;
      --overlay-close: #6e7781;
      --overlay-close-hover: #24292f;
      --overlay-label: #243b64;
      --btn-bg: transparent;
      --btn-text: #24292f;
      --btn-border: #6e7781;
      --btn-hover-bg: #243b64;
      --btn-hover-text: #ffffff;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg-color: #101a2b;
        --text-color: #c9d1d9;
        --comment-color: #8896a6;
        --key-color: #d2a8ff;
        --value-color: #79c0ff;
        --domain-color: #a8c7fa;
        --pubid-color: #e8a007;
        --direct-color: #a8c7fa;
        --reseller-color: #e03131;
        --overlay-bg: rgba(20, 35, 59, 0.95);
        --overlay-border: #304769;
        --overlay-text: #c9d1d9;
        --overlay-title: #aaa;
        --overlay-close: #aaa;
        --overlay-close-hover: #fff;
        --overlay-label: #a8c7fa;
        --btn-bg: transparent;
        --btn-text: #ffffff;
        --btn-border: #8896a6;
        --btn-hover-bg: #243b64;
        --btn-hover-text: #ffffff;
      }
    }

    body.lines-checker-custom-viewer {
      background-color: var(--bg-color);
      color: var(--text-color);
      margin: 0;
      padding-top: 30px;
    }

    .lines-checker-token-comment { color: var(--comment-color); }
    .lines-checker-token-key { color: var(--key-color); }
    .lines-checker-token-value { color: var(--value-color); }
    .lines-checker-token-domain { color: var(--domain-color); text-decoration: none; }
    .lines-checker-token-pubid { color: var(--pubid-color); }
    .lines-checker-token-direct { color: var(--direct-color); }
    .lines-checker-token-reseller { color: var(--reseller-color); }

    .lines-checker-overlay {
      position: fixed;
      top: 20px;
      right: 20px;
      background: var(--overlay-bg);
      color: var(--overlay-text);
      padding: 15px 20px;
      border-radius: 6px;
      z-index: 2147483647;
      font-family: 'Segoe UI', Helvetica, Arial, sans-serif;
      font-size: 14px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      border: 1px solid var(--overlay-border);
      width: 400px;
      max-width: calc(100vw - 40px);
      max-height: calc(100vh - 40px);
      overflow: auto;
      overflow-wrap: anywhere;
      box-sizing: border-box;
      backdrop-filter: blur(5px);
      line-height: 1.5;
    }

    .lines-checker-overlay-title {
      font-size: 12px;
      color: var(--overlay-title);
      margin-bottom: 8px;
      text-transform: uppercase;
      font-weight: bold;
    }

    .lines-checker-overlay-row { margin-bottom: 6px; }
    .lines-checker-overlay-label { font-weight: bold; margin-right: 5px; color: var(--overlay-label); }
    .lines-checker-overlay-link { color: var(--overlay-text); text-decoration: none; cursor: pointer; }
    .lines-checker-overlay-divider { border-top: 1px solid var(--overlay-border); margin: 10px 0 15px 0; }

    .lines-checker-close-btn {
      position: absolute;
      top: 5px;
      right: 8px;
      cursor: pointer;
      background: transparent;
      border: 0;
      padding: 4px;
      color: var(--overlay-close);
      font-size: 18px;
      line-height: 12px;
    }
    .lines-checker-close-btn:hover { color: var(--overlay-close-hover); }

    .lines-checker-btn-container {
      position: absolute;
      top: 10px;
      left: 10px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
    }

    .lines-checker-analyze-btn {
      background: var(--btn-bg);
      color: var(--btn-text);
      border: 1px solid var(--btn-border);
      padding: 3px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 500;
      font-size: 12px;
      font-family: 'Segoe UI', Helvetica, Arial, sans-serif;
      transition: background 0.2s, color 0.2s;
      outline: none;
    }
    .lines-checker-analyze-btn:hover {
      background: var(--btn-hover-bg);
      color: var(--btn-hover-text);
      border-color: var(--btn-hover-bg);
    }
    .lines-checker-analyze-btn:focus-visible, .lines-checker-close-btn:focus-visible {
      outline: 2px solid var(--domain-color);
      outline-offset: 2px;
    }

    .lines-checker-code-block {
      word-wrap: break-word;
      white-space: pre-wrap;
      font-family: monospace;
      font-size: 13px;
      padding: 8px;
      margin: 0;
    }
  `;
  document.head.appendChild(style);

  let container = null;

  if (owner || manager || contact || contactEmail) {
    container = document.createElement("div");
    container.className = "lines-checker-overlay";

    const hasDomains = owner || manager;
    const hasContact = contact || contactEmail;

    if (hasDomains) {
      const title = document.createElement("div");
      title.textContent = "Domains Found:";
      title.className = "lines-checker-overlay-title";
      container.appendChild(title);
    }

    function createRow(label, value, isLink) {
      if (!value) return;

      const row = document.createElement("div");
      row.className = "lines-checker-overlay-row";

      const labelSpan = document.createElement("span");
      labelSpan.textContent = `${label}: `;
      labelSpan.className = "lines-checker-overlay-label";

      if (isLink !== false) {
        const href = safeHref(value);
        if (href) {
          const link = document.createElement("a");
          link.href = href;
          link.textContent = value;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.className = "lines-checker-overlay-link";
          row.appendChild(labelSpan);
          row.appendChild(link);
        } else {
          row.appendChild(labelSpan);
          row.appendChild(document.createTextNode(value));
        }
      } else {
        row.appendChild(labelSpan);
        row.appendChild(document.createTextNode(value));
      }

      container.appendChild(row);
    }

    createRow("OwnerDomain", owner);
    createRow("ManagerDomain", manager);

    if (hasDomains && hasContact) {
      const divider = document.createElement("div");
      divider.className = "lines-checker-overlay-divider";
      container.appendChild(divider);
    }

    if (hasContact) {
      const contactTitle = document.createElement("div");
      contactTitle.textContent = "Contact Info:";
      contactTitle.className = "lines-checker-overlay-title";
      container.appendChild(contactTitle);
    }

    createRow("Contact", contact);
    createRow("Contact-email", contactEmail, false);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close file information");
    closeBtn.textContent = "×";
    closeBtn.className = "lines-checker-close-btn";
    closeBtn.onclick = () => container.remove();
    container.appendChild(closeBtn);
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  async function applySyntaxHighlighting() {
    if (!isAdsTxt) return;

    const highlightLine = cleanLine => {
      
      if (cleanLine.trim().startsWith("#")) {
        return `<span class="lines-checker-token-comment">${escapeHtml(cleanLine)}</span>`;
      }

      let commentPart = "";
      let dataPart = cleanLine;
      const hashIdx = cleanLine.indexOf("#");
      
      if (hashIdx !== -1) {
        dataPart = cleanLine.substring(0, hashIdx);
        commentPart = cleanLine.substring(hashIdx);
      }

      let resultHtml = "";
      const varMatch = dataPart.match(/^(\s*[A-Za-z0-9-]+\s*)(=)(.*)$/);
      const upperKey = varMatch ? varMatch[1].trim().toUpperCase() : "";

      if (varMatch && ["OWNERDOMAIN", "MANAGERDOMAIN", "CONTACT", "SUBDOMAIN", "CONTACT-EMAIL"].includes(upperKey)) {
        resultHtml = `<span class="lines-checker-token-key">${escapeHtml(varMatch[1])}</span>` +
                     escapeHtml(varMatch[2]) +
                     `<span class="lines-checker-token-value">${escapeHtml(varMatch[3])}</span>`;
      } 
      else if (dataPart.includes(",")) {
        const parts = dataPart.split(",");
        for (let i = 0; i < parts.length; i++) {
          let partText = escapeHtml(parts[i]);
          let coloredPart = partText;
          let trimmed = parts[i].trim();

          if (i === 0) {
            if (trimmed) {
              const href = safeHref(trimmed);
              coloredPart = href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="lines-checker-token-domain">${partText}</a>` : `<span class="lines-checker-token-domain">${partText}</span>`;
            } else {
              coloredPart = `<span class="lines-checker-token-domain">${partText}</span>`;
            }
          } else if (i === 1) {
            coloredPart = `<span class="lines-checker-token-pubid">${partText}</span>`;
          } else if (i === 2) {
            const upType = trimmed.toUpperCase();
            if (upType === "DIRECT") {
              coloredPart = `<span class="lines-checker-token-direct">${partText}</span>`;
            } else if (upType === "RESELLER") {
              coloredPart = `<span class="lines-checker-token-reseller">${partText}</span>`;
            }
          } else if (i === 3) {
            coloredPart = `<span class="lines-checker-token-comment">${partText}</span>`;
          }

          resultHtml += coloredPart;
          if (i < parts.length - 1) resultHtml += ",";
        }
      } else {
        resultHtml = escapeHtml(dataPart);
      }

      if (commentPart) {
        resultHtml += `<span class="lines-checker-token-comment">${escapeHtml(commentPart)}</span>`;
      }

      return resultHtml;
    };

    document.body.innerHTML = "";
    document.body.classList.add("lines-checker-custom-viewer");
    
    const newPre = document.createElement("pre");
    newPre.className = "lines-checker-code-block";
    document.body.appendChild(newPre);

    if (container) {
      document.body.appendChild(container);
    }

    const leftContainer = document.createElement("div");
    leftContainer.className = "lines-checker-btn-container";

    const analyzeBtn = document.createElement("button");
    analyzeBtn.textContent = "Analyzer .txt file";
    analyzeBtn.className = "lines-checker-analyze-btn";
    
    analyzeBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: "openAnalyzer", siteUrl: window.location.origin }, () => { void chrome.runtime.lastError; });
    };

    leftContainer.appendChild(analyzeBtn);
    document.body.appendChild(leftContainer);
    try {
      await renderInBatches(newPre, analysis.lines, (line, index) => {
        const span = document.createElement("span");
        // Every fragment derived from the file is escaped by highlightLine.
        span.innerHTML = highlightLine(line.raw) + (index < analysis.lines.length - 1 ? "\n" : "");
        return span;
      });
    } catch { newPre.textContent = rawText; }
    document.documentElement.setAttribute("data-lines-checker-viewer", "ready");
  }

  await applySyntaxHighlighting();

})().catch(() => { /* Keep plain-text access available if the optional viewer fails. */ });
