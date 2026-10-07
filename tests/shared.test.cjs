const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');

function helpers(fetcher = fetch) {
  const context = vm.createContext({ URL, AbortController, DOMException, TextDecoder, Uint8Array, setTimeout, clearTimeout, fetch: fetcher });
  for (const file of ['utils.js', 'network.js', 'registry.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared', file), 'utf8'), context);
  context.RegistryCache = vm.runInContext('SellerRegistryCache', context);
  return context;
}

test('opaque IDs, inline comments, metadata and duplicate counts stay consistent', () => {
  const h = helpers();
  const record = h.parseAdsLine('PUBMATIC.COM, Pub-42:Ab.C, direct # approved');
  assert.equal(record.pubId, 'Pub-42:Ab.C');
  assert.equal(record.domain, 'pubmatic.com');
  assert.equal(record.relationship, 'DIRECT');
  assert.equal(h.parseAdsLine('# vendor, a, DIRECT').type, 'comment');
  assert.equal(h.parseAdsLine('OWNERDOMAIN_OTHER=example.com').name, 'OWNERDOMAIN_OTHER');
  assert.equal(h.parseAdsLine('pubmatic.com, Ab-1, DIRECT; custom=value, another=value').type, 'data');
  const stats = h.getAdsStats('pubmatic.com, Ab-1, DIRECT # one\rpubmatic.com, Ab-1, direct\rpubmatic.com, ab-1, DIRECT\rpubmatic.com, Ab-1, RESELLER\r# note, with commas\rCONTACT=ops@example.com\rbad record');
  assert.equal(stats.lines, 4);
  assert.equal(stats.dupes, 1);
  assert.equal(stats.errors, 1);
  assert.equal(stats.direct, 3);
  assert.equal(stats.reseller, 1);
});

test('registry matching uses domains rather than ID or comment substrings', () => {
  const h = helpers();
  const url = 'https://pubmatic.com/sellers.json';
  assert.ok(h.matchesRegistryDomain(h.parseAdsLine('pubmatic.com, 1, DIRECT'), url));
  assert.equal(h.matchesRegistryDomain(h.parseAdsLine('ssp.pubmatic.com, 1, DIRECT'), url), false);
  for (const raw of ['evilpubmatic.com, 1, DIRECT', 'pubmatic.com.example.com, 1, DIRECT', 'other.com, pubmatic, DIRECT', '# pubmatic.com, 1, DIRECT']) {
    assert.equal(h.matchesRegistryDomain(h.parseAdsLine(raw), url), false);
  }
});

test('unsafe URLs and malformed records are rejected', () => {
  const h = helpers();
  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'https://user:pass@example.com', 'https://example.com:bad', 'https://anzu.io,in-game/', 'example.com,another.example', 42]) assert.equal(h.safeHref(value), null);
  assert.equal(h.safeHref('HTTPS://Example.com'), 'https://example.com/');
  assert.equal(h.normalizeSellersUrl('ftp://example.com/sellers.json'), null);
  assert.equal(h.normalizeSellersUrl(''), 'https://pubmatic.com/sellers.json');
  for (const raw of ['__proto__, 1, DIRECT', 'https://example.com, 1, DIRECT', 'example.com, , DIRECT', 'example.com, id, INVALID', 'example.com, id, DIRECT, tag, extra']) assert.equal(h.parseAdsLine(raw).type, 'error');
});

test('domain directives separate manager scope from link and comparison hostname', () => {
  const h = helpers();
  const line = h.parseAdsLine('managerdomain=anzu.io,in-game # metadata');
  assert.equal(line.type, 'variable'); assert.equal(line.value, 'anzu.io,in-game');
  const manager = h.parseDomainDirective(line.value, line.name);
  assert.equal(manager.domain, 'anzu.io'); assert.equal(manager.href, 'https://anzu.io/'); assert.equal(manager.scope, 'in-game');
  const country = h.parseDomainDirective(' WWW.Example.com , FR ', 'MANAGERDOMAIN');
  assert.equal(country.href, 'https://www.example.com/'); assert.equal(country.scope, 'FR');
  assert.equal(h.cleanDomain(country.domain), 'example.com');
  assert.equal(h.parseDomainDirective('example.com', 'OWNERDOMAIN').href, 'https://example.com/');
  for (const value of [null, '', ',US', 'javascript:alert(1),US', 'https://user@example.com,US', 'bad domain,US']) {
    assert.equal(h.parseDomainDirective(value, 'MANAGERDOMAIN').href, null);
  }
  assert.equal(h.parseDomainDirective('example.com,other.example', 'OWNERDOMAIN').href, null);
  assert.equal(h.safeHref('https://example.com/path?a=one,two'), 'https://example.com/path?a=one,two');
  assert.equal(h.safeHref('http://localhost:3000'), 'http://localhost:3000/');
  assert.equal(h.safeHref('http://[::1]:3000'), 'http://[::1]:3000/');
});

test('full-body deadlines, byte limits, retries, cancellation and HTML detection', async t => {
  const h = helpers();
  let attempts = 0;
  let missing = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/stall') { res.writeHead(200); res.flushHeaders(); res.write('started'); return; }
    if (req.url === '/retry' && ++attempts === 1) { res.writeHead(503); res.end(); return; }
    if (req.url === '/missing') { missing++; res.writeHead(404); res.end(); return; }
    if (req.url === '/large') { res.writeHead(200); res.write('123'); res.end('456'); return; }
    if (req.url === '/html') { res.end('<HTML><BODY>not an ads file</BODY></HTML>'); return; }
    if (req.url === '/comment') { res.end('# <script>example</script>\nexample.com, Ab-1, DIRECT'); return; }
    res.end('example.com, Ab-1, DIRECT');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(h.fetchTextWithTimeoutAndRetry(base + '/stall', { timeout: 80, retries: 0 }), /timed out/);
  await assert.rejects(h.fetchTextWithTimeoutAndRetry(base + '/large', { maxBytes: 4, retries: 0 }), /exceeds/);
  await h.fetchTextWithTimeoutAndRetry(base + '/retry');
  assert.equal(attempts, 2);
  await assert.rejects(h.fetchTextWithTimeoutAndRetry(base + '/missing', { retries: 3 }), /HTTP 404/);
  assert.equal(missing, 1);
  const controller = new AbortController();
  const pending = h.fetchTextWithTimeoutAndRetry(base + '/stall', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal((await h.fetchAdsFile(base + '/html')).isError, true);
  assert.equal((await h.fetchAdsFile(base + '/comment')).isError, false);
});

test('website origins preserve protocol, host and port and reject invalid input', () => {
  const h = helpers();
  assert.equal(h.normalizeSiteUrl('http://WWW.Example.com:8080/path?q=1'), 'http://www.example.com:8080');
  assert.equal(h.normalizeSiteUrl('example.com:8080/path'), 'https://example.com:8080');
  assert.equal(h.normalizeSiteUrl('localhost:3000'), 'https://localhost:3000');
  for (const value of ['not a site', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com:bad', 42, 'example.com\\evil']) assert.equal(h.normalizeSiteUrl(value), null);
  for (const value of ['%65xample.com', 'example.com\\evil', 'a..example.com', '-bad.example', 'a'.repeat(64) + '.com']) assert.equal(h.normalizeAdvertisingDomain(value), '');
  assert.equal(h.normalizeAdvertisingDomain('пример.рф'), 'xn--e1afmkfd.xn--p1ai');
  assert.equal(h.normalizeSellersUrl(42), null);
});

test('shared analysis keeps repeated metadata, exact duplicate keys and async parity', async () => {
  const h = helpers();
  const text = '# OWNERDOMAIN=wrong.example\rOWNERDOMAIN=example.com\nMANAGERDOMAIN=one.example\nMANAGERDOMAIN=two.example\nexample.com, __proto__, DIRECT; extra=value\nexample.com, __proto__, direct # duplicate\nexample.com, __proto__, DIRECT, certification\nexample.com, id, INVALID';
  const sync = h.analyzeAdsText(text);
  const asyncResult = await h.analyzeAdsTextAsync(text);
  assert.equal(JSON.stringify(asyncResult), JSON.stringify(sync));
  assert.deepEqual([...sync.duplicateIndices], [4, 5]);
  assert.deepEqual([...asyncResult.duplicateIndices], [...sync.duplicateIndices]);
  assert.deepEqual([...sync.variables.get('MANAGERDOMAIN')], ['one.example', 'two.example']);
  assert.equal(sync.totalData, 3); assert.equal(sync.duplicateCount, 1); assert.equal(sync.errors, 1);
  assert.equal(h.analyzeAdsText(null).loaded, false);
  assert.equal(h.analyzeAdsText('').loaded, true);
  const controller = new AbortController();
  const pending = h.analyzeAdsTextAsync(('example.com, id, DIRECT\n').repeat(10000), controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('registry validation preserves opaque IDs and rejects unusable or conflicting records', () => {
  const h = helpers();
  const parse = sellers => h.parseSellersRegistry(JSON.stringify({ sellers }));
  const result = parse([{ seller_id: ' Ab-1:Case ', seller_type: 'publisher' }, { seller_id: 0 }, { seller_id: '__proto__', is_confidential: 1 }, { seller_id: 'bad id' }]);
  assert.equal(result.sellers.length, 3);
  assert.equal(result.map['Ab-1:Case'].seller_type, 'PUBLISHER');
  assert.equal(result.map.__proto__.is_confidential, true);
  assert.equal(Object.getPrototypeOf(result.map), null);
  assert.match(result.warning, /1 invalid/);
  assert.throws(() => parse([{}]), /no usable/);
  assert.throws(() => parse([{ seller_id: 'id', domain: 'one.example' }, { seller_id: 'id', domain: 'two.example' }]), /Conflicting/);
  assert.equal(parse([{ seller_id: 'id' }, { seller_id: 'id' }]).sellers.length, 1);
  assert.throws(() => h.parseSellersRegistry('{"sellers":null}'), /must be an array/);
});

test('registry downloads coalesce, respect concurrency and cancel only unused requests', async () => {
  const downloads = [];
  const h = helpers((url, options) => new Promise((resolve, reject) => {
    const job = { url, finish: () => resolve(new Response('{"sellers":[{"seller_id":"id"}]}')) };
    options.signal.addEventListener('abort', () => { job.cancelled = true; reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
    downloads.push(job);
  }));
  const cache = new h.RegistryCache({ concurrency: 1 });
  const one = new AbortController(); const queued = new AbortController();
  const first = cache.get('https://one.example/sellers.json', one.signal);
  const second = cache.get('https://one.example/sellers.json');
  const waiting = cache.get('https://two.example/sellers.json', queued.signal);
  const third = cache.get('https://three.example/sellers.json');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(downloads.length, 1);
  one.abort(); queued.abort();
  assert.equal((await first).cancelled, true); assert.equal((await waiting).cancelled, true);
  assert.equal(downloads[0].cancelled, undefined);
  downloads[0].finish(); assert.equal((await second).failed, false);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(downloads.length, 2); assert.ok(downloads[1].url.includes('three.example'));
  downloads[1].finish(); await third;
  assert.equal(cache.active, 0); assert.equal(cache.requests.size, 0); assert.equal(cache.queue.length, 0);
});

test('registry cache enforces retention budget, LRU, expiry and retries failed lookups', async () => {
  let calls = 0; let valid = true;
  const h = helpers(async () => { calls++; return new Response(valid ? '{"sellers":[{"seller_id":"id"}]}' : '{"sellers":[{}]}'); });
  const cache = new h.RegistryCache({ maxEntries: 2, maxBytes: 1000 });
  const urls = ['https://one.example/sellers.json', 'https://two.example/sellers.json', 'https://three.example/sellers.json'];
  await cache.get(urls[0]); await cache.get(urls[1]); await cache.get(urls[0]);
  assert.equal(calls, 2);
  await cache.get(urls[2]);
  assert.equal(cache.entries.has(urls[0]), true); assert.equal(cache.entries.has(urls[1]), false);
  assert.ok(cache.bytes <= cache.maxBytes);
  cache.entries.get(urls[0]).ts = Date.now() - 600001;
  await cache.get(urls[0]); assert.equal(calls, 4);
  valid = false;
  assert.equal((await cache.get(urls[1])).failed, true);
  assert.equal(cache.entries.has(urls[1]), false);
  valid = true; assert.equal((await cache.get(urls[1])).failed, false);
  const tiny = new h.RegistryCache({ maxBytes: 1 });
  await tiny.get(urls[0]); assert.equal(tiny.entries.size, 0); assert.equal(tiny.bytes, 0);
});
