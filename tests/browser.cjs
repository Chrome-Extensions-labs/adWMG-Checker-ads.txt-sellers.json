// Real MV3 extension APIs; publisher/registry fixtures use a local HTTP server.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-checker-browser-'));
const errors = [];
let context;
let registryMode = 'slow';
let adsMode = 'normal';
let registryCalls = 0;
const record = '127.0.0.1, Ab-1:Case, DIRECT';
const normalAds = `# OWNERDOMAIN=wrong.example\nOWNERDOMAIN=127.0.0.1\nMANAGERDOMAIN=127.0.0.1,in-game\n${record}\n${record} # duplicate\n127.0.0.1, missing, RESELLER\n127.0.0.1, id, INVALID\nother.example, Ab-1:Case, DIRECT\n# <script> is a comment\n`;
const registry = { sellers: [{ seller_id: 'Ab-1:Case', domain: '127.0.0.1', seller_type: 'PUBLISHER' }] };
const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/sellers.json') {
    registryCalls++;
    if (registryMode === 'offline') { res.writeHead(503); res.end('Unavailable'); return; }
    res.setHeader('Content-Type', 'application/json');
    const payload = registryMode === 'invalid' ? { sellers: [{}] } : registry;
    if (registryMode === 'slow') setTimeout(() => { if (!res.destroyed) res.end(JSON.stringify(payload)); }, 1800);
    else res.end(JSON.stringify(payload));
    return;
  }
  if (req.url === '/different.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ sellers: [{ seller_id: 'NEW' }] })); return; }
  if (req.url === '/ads.txt' || req.url === '/app-ads.txt') {
    if (adsMode === 'html') { res.setHeader('Content-Type', 'text/html'); res.end('<html>Access denied</html>'); return; }
    if (adsMode === 'redirect' && req.url === '/ads.txt') { res.writeHead(302, { Location: '/published/ads.txt' }); res.end(); return; }
    res.setHeader('Content-Type', 'text/plain');
    res.end(adsMode === 'empty' ? '' : adsMode === 'large' ? (record + '\n').repeat(12000) : req.url === '/ads.txt' ? normalAds : record + '\n');
    return;
  }
  if (req.url === '/published/ads.txt') { res.setHeader('Content-Type', 'text/plain'); res.end(record); return; }
  res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Publisher fixture</title><h1>Publisher</h1>');
});
const waitText = (page, selector, value) => page.waitForFunction(({ selector, value }) => document.querySelector(selector)?.textContent.includes(value), { selector, value });
const report = name => console.log(`PASS ${name}`);

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const registryUrl = origin + '/sellers.json';
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 780 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionOrigin = 'chrome-extension://' + new URL(worker.url()).hostname;
  await worker.evaluate(url => chrome.storage.local.set({ custom_sellers_url: url }), registryUrl);
  const publisher = await context.newPage();
  await publisher.goto(origin);
  const popup = await context.newPage();
  await popup.goto(extensionOrigin + '/ui/popup/popup.html');
  await publisher.bringToFront();
  await popup.reload();
  await waitText(popup, '#ads-line-count', '4');
  await popup.locator('#ads-tab').click();
  await waitText(popup, '#output', 'Ab-1:Case');
  assert.equal(await popup.locator('#owner-badge').textContent(), 'OWNER: MATCH');
  assert.equal(await popup.locator('#manager-badge').textContent(), 'MANAGER: MATCH');
  assert.equal(await popup.locator('#seller-line-count').textContent(), '—');
  report('popup files and metadata available before slow registry completes');
  await waitText(popup, '#seller-line-count', '1');
  assert.equal(await popup.locator('#output .line-critical-error').count(), 1);
  assert.equal(await popup.locator('#output .line-warning').count(), 1);
  await popup.locator('#seller-tab').click();
  await waitText(popup, '#output', 'Ab-1:Case');
  assert.equal(await popup.locator('#output .line-row').count(), 1);
  report('opaque seller IDs, warnings, deduplication and exact provider filter');

  const message = value => popup.evaluate(message => chrome.runtime.sendMessage(message), value);
  registryMode = 'normal';
  await popup.locator('#settings-toggle').click();
  await popup.locator('#sellers-url-input').fill('javascript:alert(1)');
  await popup.locator('#save-settings').click();
  assert.equal(await popup.locator('#sellers-url-input').getAttribute('aria-invalid'), 'true');
  assert.equal(await popup.locator('#save-settings').isEnabled(), true);
  await popup.locator('#sellers-url-input').fill(registryUrl);
  await popup.locator('#save-settings').click();
  await waitText(popup, '#settings-status', 'Settings saved');
  await popup.locator('#settings-toggle').click();
  report('settings reject unsafe URLs and recover through a successful refresh');
  const callsBeforeCache = registryCalls;
  assert.equal((await message({ type: 'getSellersCache' })).sellers.length, 1);
  assert.equal(registryCalls, callsBeforeCache);
  registryMode = 'invalid';
  const stale = await message({ type: 'refreshSellers' });
  assert.equal(stale.ok, false); assert.equal(stale.stale, true); assert.equal(stale.sellers[0].seller_id, 'Ab-1:Case');
  registryMode = 'offline';
  assert.equal((await message({ type: 'refreshSellers' })).stale, true);
  registryMode = 'normal';
  report('cached data retained after malformed registry and transient HTTP failure');

  const tabs = await worker.evaluate(() => chrome.tabs.query({}));
  const publisherTab = tabs.find(tab => tab.url === origin + '/');
  await message({ type: 'setBadge', tabId: publisherTab.id, tabUrl: publisherTab.url, registryUrl, count: 8 });
  assert.equal(await worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), publisherTab.id), '8');
  assert.equal((await message({ type: 'setBadge', tabId: publisherTab.id, tabUrl: origin + '/old', registryUrl, count: 99 })).ok, false);
  assert.equal((await message({ type: 'setBadge', tabId: publisherTab.id, registryUrl: origin + '/different.json', count: 99 })).ok, false);
  assert.equal(await worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), publisherTab.id), '8');
  report('stale navigation/provider messages cannot replace the tab badge');

  const newPage = context.waitForEvent('page');
  await popup.locator('#qa-btn').click();
  const analyzer = await newPage;
  await waitText(analyzer, '#ads-total', 'Lines: 4');
  assert.equal(await analyzer.locator('#domain-input').inputValue(), origin);
  assert.equal(await analyzer.locator('#ads-link').getAttribute('href'), origin + '/ads.txt');
  assert.equal(await analyzer.locator('#ads-dupes').textContent(), 'Dupes: 1');
  assert.equal(await analyzer.locator('#ads-errors').textContent(), 'Errors: 1');
  assert.equal(await analyzer.locator('#ads-content .line-duplicate').count(), 2);
  report('analyzer opened through real messaging preserves HTTP and port');

  let verificationRequests = 0;
  await context.route('https://127.0.0.1/sellers.json', async route => {
    verificationRequests++;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(registry) }).catch(() => {});
  });
  await analyzer.locator('#ads-ssp-dropdown').selectOption('127.0.0.1');
  await analyzer.locator('#ads-verify-btn').click();
  await waitText(analyzer, '#ads-line-results', 'Verified');
  assert.equal(await analyzer.locator('#ads-line-results .verified').count(), 2);
  assert.equal(await analyzer.locator('#ads-line-results .not-verified').count(), 1);
  await analyzer.locator('#appads-ssp-dropdown').selectOption('127.0.0.1');
  await analyzer.locator('#appads-verify-btn').click();
  await waitText(analyzer, '#appads-line-results', 'Verified');
  assert.equal(verificationRequests, 1);
  await analyzer.locator('#ads-line-results .line-id').first().focus();
  await analyzer.keyboard.press('Enter');
  assert.equal(await analyzer.locator('#ads-content mark.line-highlight').textContent(), 'Ab-1:Case');
  await analyzer.locator('#ads-search').fill('Ab-1:Case');
  await waitText(analyzer, '#ads-search-count', '1/3');
  report('verification shares cache across columns; keyboard ID lookup and search work');

  let slowRequests = 0;
  await context.route('https://other.example/sellers.json', async route => {
    slowRequests++;
    await new Promise(resolve => setTimeout(resolve, 600));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(registry) }).catch(() => {});
  });
  await analyzer.locator('#ads-ssp-dropdown').selectOption('other.example');
  await analyzer.locator('#ads-verify-btn').click();
  await analyzer.locator('#ads-cancel-btn').click();
  await waitText(analyzer, '#ads-line-results', 'Cancelled');
  await analyzer.waitForTimeout(700);
  assert.equal(await analyzer.locator('#ads-line-results .verified').count(), 0);
  assert.equal(await analyzer.locator('#ads-verify-btn').isEnabled(), true);
  await analyzer.locator('#ads-verify-btn').click();
  await analyzer.locator('#analyze-btn').click();
  await analyzer.waitForFunction(() => !document.querySelector('#analyze-btn').disabled && !document.querySelector('#ads-ssp-dropdown').value);
  await analyzer.waitForTimeout(700);
  assert.equal(await analyzer.locator('#ads-line-results .line-row').count(), 0);
  assert.ok(slowRequests >= 1);
  await analyzer.locator('#ads-verify-all-btn').click();
  await analyzer.waitForFunction(() => document.querySelectorAll('#ads-line-results .ssp-group').length === 2 && !document.querySelector('#ads-verify-all-btn').disabled);
  assert.equal(await analyzer.locator('#ads-line-results .line-row').count(), 4);
  report('cancelled verification, reanalysis and all-SSP grouped verification');

  adsMode = 'empty';
  await analyzer.locator('#analyze-btn').click();
  await waitText(analyzer, '#ads-total', 'Lines: 0');
  assert.equal(await analyzer.locator('#ads-line-panel').isVisible(), false);
  adsMode = 'html';
  await analyzer.locator('#analyze-btn').click();
  await waitText(analyzer, '#status-msg', 'Returned HTML');
  assert.equal(await analyzer.locator('#analyze-btn').isEnabled(), true);
  adsMode = 'redirect';
  await analyzer.locator('#analyze-btn').click();
  await waitText(analyzer, '#ads-total', 'Lines: 1');
  assert.equal(await analyzer.locator('#ads-link').getAttribute('href'), origin + '/published/ads.txt');
  assert.equal(await analyzer.locator('#ads-redirect').isVisible(), true);
  report('empty files, HTML error pages and redirected file links handled');

  adsMode = 'large';
  await analyzer.locator('#analyze-btn').click();
  await waitText(analyzer, '#ads-total', 'Lines: 12000');
  await analyzer.waitForFunction(() => document.querySelectorAll('#ads-content .line').length === 12001 && !document.querySelector('#analyze-btn').disabled);
  assert.equal(await analyzer.locator('#ads-dupes').textContent(), 'Dupes: 11999');
  report('12,000 records per column parsed and rendered in batches');
  adsMode = 'normal';

  const viewer = await context.newPage();
  await viewer.goto(origin + '/ads.txt');
  await viewer.waitForSelector('#lines-checker-style', { state: 'attached' });
  await viewer.waitForFunction(() => document.querySelector('.lines-checker-code-block')?.textContent.includes('Ab-1:Case'));
  assert.equal(await viewer.locator('.lines-checker-code-block').textContent(), normalAds);
  const managerLink = viewer.locator('.lines-checker-overlay-row').filter({ hasText: 'ManagerDomain:' }).locator('a');
  assert.equal(await managerLink.getAttribute('href'), 'https://127.0.0.1/');
  assert.equal(await managerLink.textContent(), '127.0.0.1');
  assert.equal(await viewer.locator('.lines-checker-overlay-scope').textContent(), ' (in-game)');
  await viewer.addScriptTag({ path: path.join(root, 'content/overlay.js') });
  assert.equal(await viewer.locator('#lines-checker-style').count(), 1);
  await viewer.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await viewer.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(0, 0, 0)');
  report('real content-script injection, original text preservation and dark theme');

  // Stop the actual extension service worker through CDP, then wake it via messaging.
  const cdp = await context.newCDPSession(publisher);
  const versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', event => { for (const version of event.versions) versions.set(version.versionId, version); });
  await cdp.send('ServiceWorker.enable');
  for (let i = 0; i < 100 && ![...versions.values()].some(v => v.scriptURL === worker.url()); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const version = [...versions.values()].find(v => v.scriptURL === worker.url());
  assert.ok(version, 'Extension service worker visible through CDP');
  await worker.evaluate(() => { globalThis.__restartProbe = 'old-instance'; });
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  for (let i = 0; i < 250 && versions.get(version.versionId)?.runningStatus !== 'stopped'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(versions.get(version.versionId)?.runningStatus, 'stopped');
  const beforeRestart = registryCalls;
  const restartedCache = await message({ type: 'getSellersCache' });
  const restartedWorker = context.serviceWorkers().find(item => item.url() === worker.url());
  assert.ok(restartedWorker);
  assert.equal(await restartedWorker.evaluate(() => globalThis.__restartProbe), undefined);
  assert.equal(restartedCache.sellers[0].seller_id, 'Ab-1:Case');
  assert.equal(registryCalls, beforeRestart);
  report('persistent cache survives real service-worker stop and restart');

  assert.deepEqual(errors, []);
  const output = path.join(root, 'test-results'); fs.mkdirSync(output, { recursive: true });
  await popup.screenshot({ path: path.join(output, 'popup.png') });
  await analyzer.screenshot({ path: path.join(output, 'analyzer.png') });
  console.log('All loaded-extension browser scenarios passed; no uncaught page errors.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await context?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  // profile is a newly created, isolated child of the OS temp directory.
  fs.rmSync(profile, { recursive: true, force: true });
});
