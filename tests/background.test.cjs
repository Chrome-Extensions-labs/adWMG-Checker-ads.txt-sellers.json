const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const sellers = [{ seller_id: 'Ab-1', domain: 'example.com', seller_type: 'PUBLISHER' }];
function harness(fetcher, initialStore = {}) {
  const store = { ...initialStore };
  const events = {};
  const badges = [];
  const windows = [];
  const tabs = new Map([[1, { id: 1, url: 'https://example.com/', active: true }]]);
  const event = name => ({ addListener(fn) { events[name] = fn; } });
  const chrome = {
    storage: { local: { get(keys, cb) { cb(Object.fromEntries(keys.map(key => [key, store[key]]))); }, set(items, cb) { Object.assign(store, items); cb(); } }, onChanged: event('storage') },
    runtime: { id: 'test', onMessage: event('message'), getURL: value => value },
    tabs: { onActivated: event('activate'), onUpdated: event('update'), onRemoved: event('remove'),
      get(id, cb) { if (!tabs.has(id)) { chrome.runtime.lastError = { message: 'Tab closed' }; cb(); delete chrome.runtime.lastError; } else cb(tabs.get(id)); },
      query(_query, cb) { cb([...tabs.values()]); } },
    windows: { create(options, cb) { windows.push(options); cb(options); } },
    action: { setBadgeText(options, cb) { badges.push(options); cb(); }, setBadgeBackgroundColor(_options, cb) { cb(); } }
  };
  const context = vm.createContext({ chrome, URL, AbortController, DOMException, TextDecoder, Uint8Array, setTimeout, clearTimeout, fetch: fetcher });
  context.importScripts = (...scripts) => { for (const script of scripts) vm.runInContext(fs.readFileSync(path.resolve(root, 'background', script), 'utf8'), context); };
  vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), context);
  const send = message => new Promise(resolve => events.message(message, { id: 'test' }, resolve));
  return { store, events, badges, tabs, send, chrome, windows };
}
const registryResponse = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Expected asynchronous update did not arrive');
}

test('simultaneous registry requests share a download and fresh cache is reused', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return registryResponse({ sellers }); });
  const results = await Promise.all([h.send({ type: 'getSellersCache' }), h.send({ type: 'getSellersCache' })]);
  assert.equal(calls, 1);
  assert.equal(results[0].sellers[0].seller_id, 'Ab-1');
  assert.equal(results[1].url, 'https://pubmatic.com/sellers.json');
  await h.send({ type: 'getSellersCache' });
  assert.equal(calls, 1);
});

test('invalid registry does not overwrite good cache and offline refresh reports stale data', async () => {
  let valid = true;
  const h = harness(async () => registryResponse(valid ? { sellers } : { sellers: null }));
  await h.send({ type: 'getSellersCache' });
  valid = false;
  const response = await h.send({ type: 'refreshSellers' });
  assert.equal(response.ok, false);
  assert.equal(response.stale, true);
  assert.equal(response.sellers[0].seller_id, 'Ab-1');
  assert.equal(h.store.sellers_cache[0].seller_id, 'Ab-1');
});

test('a slow old-provider request cannot overwrite a newer provider cache', async () => {
  let finishOld;
  const h = harness(url => url.includes('pubmatic') ? new Promise(resolve => { finishOld = () => resolve(registryResponse({ sellers })); }) : Promise.resolve(registryResponse({ sellers: [{ seller_id: 'NEW' }] })));
  const old = h.send({ type: 'getSellersCache' });
  await until(() => finishOld);
  h.store.custom_sellers_url = 'https://another.example/sellers.json';
  await h.send({ type: 'getSellersCache' });
  finishOld(); await old;
  assert.equal(h.store.sellers_cache_url, h.store.custom_sellers_url);
  assert.equal(h.store.sellers_cache[0].seller_id, 'NEW');
});

test('errors settle messages and badges stay scoped to the requested tab', async () => {
  const h = harness(async () => registryResponse({ sellers }));
  h.store.custom_sellers_url = 'not a URL';
  assert.equal((await h.send({ type: 'getSellersCache' })).ok, false);
  await h.send({ type: 'setBadge', tabId: 1, tabUrl: 'https://example.com/', count: 12 });
  assert.deepEqual({ ...h.badges[0] }, { tabId: 1, text: '12' });
  await h.send({ type: 'setBadge', tabId: 1, tabUrl: 'https://old.example/', count: 99 });
  assert.equal(h.badges.length, 1);
  await h.send({ type: 'setBadge', tabId: 1, count: 'invalid' });
  assert.equal(h.badges.at(-1).text, '');
});

test('automatic scans count valid SSP records and navigation cancels pending scans', async () => {
  let mode = 'fast';
  let started = 0;
  let aborted = 0;
  const h = harness(async (_url, options) => {
    if (mode === 'fast') return new Response('pubmatic.com, Ab-1, DIRECT\nother.com, pubmatic, DIRECT\n# pubmatic.com, 2, DIRECT');
    started++;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => { aborted++; reject(new DOMException('Cancelled', 'AbortError')); }, { once: true }));
  });
  h.events.activate({ tabId: 1 });
  await until(() => h.badges.some(badge => badge.text === '2'));
  mode = 'slow';
  h.events.update(1, { status: 'loading' });
  h.events.update(1, { status: 'complete' });
  await until(() => started === 2);
  h.tabs.set(1, { id: 1, url: 'https://new.example/' });
  h.events.update(1, { url: 'https://new.example/', status: 'loading' });
  await until(() => aborted === 2);
  assert.equal(h.badges.at(-1).text, '');
});

test('provider changes reject old popup counts and analyzer URLs preserve origins', async () => {
  const h = harness(async () => registryResponse({ sellers }));
  h.store.custom_sellers_url = 'https://different.example/sellers.json';
  assert.equal((await h.send({ type: 'setBadge', tabId: 1, registryUrl: 'https://pubmatic.com/sellers.json', count: 5 })).ok, false);
  assert.equal(h.badges.length, 0);
  await h.send({ type: 'openAnalyzer', siteUrl: 'http://www.example.com:8080/path' });
  assert.equal(new URL(h.windows[0].url, 'https://extension.example/').searchParams.get('site'), 'http://www.example.com:8080');
  assert.equal((await h.send({ type: 'openAnalyzer', siteUrl: 'javascript:alert(1)' })).ok, false);
  assert.equal(h.windows.length, 1);
});

test('cache survives worker restart, retains validation warnings and malformed refreshes', async () => {
  const h = harness(async () => registryResponse({ sellers: [...sellers, {}] }));
  const first = await h.send({ type: 'getSellersCache' });
  assert.match(first.warning, /1 invalid/);
  let downloads = 0;
  const restarted = harness(async () => { downloads++; return registryResponse({ sellers: [{}] }); }, h.store);
  const cached = await restarted.send({ type: 'getSellersCache' });
  assert.equal(downloads, 0); assert.match(cached.warning, /1 invalid/);
  const failed = await restarted.send({ type: 'refreshSellers' });
  assert.equal(failed.stale, true); assert.equal(failed.sellers[0].seller_id, 'Ab-1');
  assert.equal(restarted.store.sellers_ts, h.store.sellers_ts);
});

test('corrupted persistent cache is refreshed instead of reported as usable seller data', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return registryResponse({ sellers }); }, {
    sellers_cache: [null, {}], sellers_ts: Date.now(), sellers_cache_url: 'https://pubmatic.com/sellers.json'
  });
  const result = await h.send({ type: 'getSellersCache' });
  assert.equal(calls, 1); assert.equal(result.ok, true); assert.equal(result.sellers[0].seller_id, 'Ab-1');
});
