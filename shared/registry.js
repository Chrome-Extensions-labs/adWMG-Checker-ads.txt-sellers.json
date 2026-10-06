/** Normalize registries once and reject ambiguous account IDs. */
function parseSellersRegistry(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.sellers)) throw new Error("Invalid sellers.json: sellers must be an array.");
  const map = Object.create(null);
  let ignored = 0;
  for (const value of data.sellers) {
    const validId = value && !Array.isArray(value) &&
      (typeof value.seller_id === "string" || (Number.isSafeInteger(value.seller_id) && value.seller_id >= 0));
    if (!validId || !String(value.seller_id).trim() || /\s/.test(String(value.seller_id).trim())) { ignored++; continue; }
    const seller = {
      seller_id: String(value.seller_id).trim(),
      domain: typeof value.domain === "string" ? value.domain.trim() : "",
      name: typeof value.name === "string" ? value.name.trim() : "",
      seller_type: typeof value.seller_type === "string" ? value.seller_type.trim().toUpperCase() : "UNKNOWN",
      is_confidential: value.is_confidential === true || value.is_confidential === 1
    };
    if (!["PUBLISHER", "INTERMEDIARY", "BOTH", "UNKNOWN"].includes(seller.seller_type)) { ignored++; continue; }
    const previous = map[seller.seller_id];
    if (previous && JSON.stringify(previous) !== JSON.stringify(seller)) throw new Error(`Conflicting seller records for ID ${seller.seller_id}`);
    map[seller.seller_id] = seller;
  }
  const sellers = Object.values(map);
  if (data.sellers.length && !sellers.length) throw new Error("Invalid sellers.json: no usable seller records.");
  return { sellers, map, warning: ignored ? `${ignored} invalid seller records ignored.` : "" };
}

/** Bound successful registry retention and concurrent downloads across both columns. */
class SellerRegistryCache {
  constructor({ ttl = 600000, maxBytes = 64 * 1024 * 1024, maxEntries = 30, concurrency = 4 } = {}) {
    this.ttl = ttl;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.concurrency = concurrency;
    this.entries = new Map();
    this.requests = new Map();
    this.queue = [];
    this.active = 0;
    this.bytes = 0;
  }

  drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      job.signal.removeEventListener("abort", job.cancel);
      if (job.signal.aborted) { job.reject(new DOMException("Request cancelled", "AbortError")); continue; }
      this.active++;
      job.resolve();
    }
  }

  acquire(signal) {
    throwIfCancelled(signal);
    return new Promise((resolve, reject) => {
      const job = { signal, resolve, reject };
      job.cancel = () => { this.queue = this.queue.filter(item => item !== job); reject(new DOMException("Request cancelled", "AbortError")); };
      signal.addEventListener("abort", job.cancel, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }

  remove(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  remember(key, result, sourceBytes) {
    this.remove(key);
    const bytes = sourceBytes * 3 + result.sellers.length * 256; // Estimated retention budget, including per-record overhead.
    if (bytes > this.maxBytes) return;
    while (this.entries.size && (this.bytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries)) this.remove(this.entries.keys().next().value);
    this.entries.set(key, { result, bytes, ts: Date.now() });
    this.bytes += bytes;
  }

  start(key) {
    const controller = new AbortController();
    const request = { controller, users: 0 };
    request.promise = (async () => {
      let acquired = false;
      try {
        await this.acquire(controller.signal);
        acquired = true;
        const response = await fetchTextWithTimeoutAndRetry(key, {
          timeout: 12000, retries: 1, maxBytes: 20 * 1024 * 1024, signal: controller.signal
        });
        throwIfCancelled(controller.signal);
        const result = { ...parseSellersRegistry(response.text), failed: false, timedOut: false, cancelled: false };
        this.remember(key, result, response.byteLength);
        return result;
      } catch (error) {
        return { map: null, failed: true, timedOut: /timed out/i.test(error.message), cancelled: controller.signal.aborted, error: error.message };
      } finally {
        if (acquired) { this.active--; this.drain(); }
        if (this.requests.get(key) === request) this.requests.delete(key);
      }
    })();
    this.requests.set(key, request);
    return request;
  }

  async get(url, signal) {
    const cancelled = { map: null, failed: true, timedOut: false, cancelled: true };
    if (signal?.aborted) return cancelled;
    const key = normalizeSellersUrl(url);
    if (!key) return { map: null, failed: true, error: "Invalid registry URL" };
    const cached = this.entries.get(key);
    const age = cached ? Date.now() - cached.ts : -1;
    if (cached && age >= 0 && age < this.ttl) {
      this.entries.delete(key); this.entries.set(key, cached);
      return cached.result;
    }
    this.remove(key);
    const existing = this.requests.get(key);
    const request = existing && !existing.controller.signal.aborted ? existing : this.start(key);
    request.users++;
    let cancel;
    try {
      return await Promise.race([
        request.promise,
        new Promise(resolve => { cancel = () => resolve(cancelled); signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel(); })
      ]);
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (--request.users === 0 && this.requests.get(key) === request) request.controller.abort();
    }
  }
}
