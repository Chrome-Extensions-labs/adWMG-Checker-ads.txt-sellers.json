/** Keep the deadline active until the complete body is read; enforce a byte limit. */
async function fetchTextWithTimeoutAndRetry(url, { timeout = 10000, retries = 1,
  maxBytes = 5 * 1024 * 1024, signal, fetchOptions = {} } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    let reader;
    let retry = false;
    try {
      const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
      }
      if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body?.cancel();
        const error = new Error(`Response exceeds ${Math.round(maxBytes / 1024 / 1024)} MB`);
        error.retryable = false;
        throw error;
      }
      reader = response.body?.getReader();
      const chunks = [];
      let bytes = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          const error = new Error(`Response exceeds ${Math.round(maxBytes / 1024 / 1024)} MB`);
          error.retryable = false;
          throw error;
        }
        chunks.push(value);
      }
      const merged = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
      return { text: new TextDecoder().decode(merged), url: response.url || url,
        redirected: response.redirected, headers: response.headers, byteLength: bytes };
    } catch (error) {
      if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
      if (timedOut) error = new Error("Request timed out");
      retry = error.retryable !== false && attempt < retries;
      if (!retry) throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reader?.releaseLock();
    }
    if (retry) {
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(backoff); reject(new DOMException("Request cancelled", "AbortError")); };
        const backoff = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 300 * (attempt + 1));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
}

async function fetchAdsFile(url, { force = false, signal } = {}) {
  try {
    const response = await fetchTextWithTimeoutAndRetry(url, { signal, fetchOptions: { cache: force ? "no-store" : "default" } });
    const text = response.text.replace(/\r\n|\r/g, "\n");
    if ((response.headers.get("content-type") || "").toLowerCase().includes("text/html") ||
        /^(?:\s*<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html|head|body|script)\b/i.test(text.trim().slice(0, 500))) {
      return { text: "", error: "Returned HTML instead of a text file", url: response.url, isError: true };
    }
    return { text, error: null, isError: false, url: response.url,
      redirected: response.redirected, lastModified: response.headers.get("last-modified") };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { text: "", error: error.message || "Network error", url, isError: true };
  }
}
