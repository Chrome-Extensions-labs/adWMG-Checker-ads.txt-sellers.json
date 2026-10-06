const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}
for (const directory of ['background', 'content', 'shared', 'ui', 'scripts', 'tests']) {
  for (const file of files(path.join(root, directory)).filter(file => /\.(?:c?js)$/.test(file))) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
}
function resource(value, base = root) {
  const full = path.resolve(base, value);
  const relative = path.relative(root, full);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Outside extension: ${value}`);
  assert.ok(fs.statSync(full).isFile(), `Missing resource: ${value}`);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.match(manifest.version, /^\d+(?:\.\d+){0,3}$/);
resource(manifest.background.service_worker);
const workerPath = path.resolve(root, manifest.background.service_worker);
const workerSource = fs.readFileSync(workerPath, 'utf8');
for (const call of workerSource.matchAll(/importScripts\(([^)]+)\)/g)) {
  for (const argument of call[1].matchAll(/['"]([^'"]+)['"]/g)) resource(argument[1], path.dirname(workerPath));
}
resource(manifest.action.default_popup);
for (const icon of Object.values(manifest.icons)) resource(icon);
for (const script of manifest.content_scripts) {
  assert.equal(script.js[0], 'shared/utils.js', 'Content helpers must load before the viewer');
  for (const file of script.js) resource(file);
}
for (const file of files(path.join(root, 'ui')).filter(file => file.endsWith('.html'))) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(match => match[1]);
  assert.equal(scripts[0], '../../shared/utils.js', 'Shared helpers must load before UI scripts');
  assert.ok(scripts.includes('../../shared/network.js'), 'UI requires shared network helpers');
  assert.ok(scripts.includes('../../shared/ui.js'), 'UI requires batched rendering helpers');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (!/^(?:[a-z][\w+.-]*:|#)/i.test(match[1])) resource(match[1], path.dirname(file));
  }
}
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(packageInfo.version, manifest.version, 'Keep development package and manifest versions synchronized');
assert.ok(!packageInfo.dependencies || !Object.keys(packageInfo.dependencies).length, 'Extension needs no runtime packages');
console.log('JavaScript syntax, manifest and local UI resources verified.');
