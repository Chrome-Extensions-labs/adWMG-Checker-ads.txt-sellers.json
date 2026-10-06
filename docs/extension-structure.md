# Chrome Extension Structure (MV3)

## Current layout

```text
background/
  background.js
content/
  overlay.js
shared/
  utils.js
  network.js
  registry.js
  ui.js
ui/
  popup/
    popup.html
    popup.css
    popup.js
  analyzer/
    analyzer.html
    analyzer.css
    analyzer.js
assets/
  icons/
    icon128.png
scripts/
  check.cjs
  restructure_sources.sh
tests/
  background.test.cjs
  shared.test.cjs
  browser.cjs
  automation_test.py
trigger action/
  trigger_action.py
manifest.json
package.json
package-lock.json
requirements.txt
```

## Why this structure

- `ui/popup` and `ui/analyzer` isolate independent UI entrypoints.
- `background` keeps MV3 service-worker logic separate from UI.
- `content` separates injected scripts that run in page context.
- `shared` stores reusable helpers imported by multiple runtime contexts.
- `assets` centralizes static files and keeps icon paths deterministic.
- `scripts/` keeps maintenance scripts outside runtime source.

## Path checklist

1. `manifest.json`
   - `action.default_popup`: `ui/popup/popup.html`
   - `background.service_worker`: `background/background.js`
   - `content_scripts[].js`: `shared/utils.js`, `shared/ui.js`, then `content/overlay.js`
   - `icons.128`: `assets/icons/icon128.png`

2. `ui/popup/popup.html`
   - Local links remain `popup.css` and `popup.js`.
   - Shared scripts load `utils.js`, `network.js` and `ui.js` before `popup.js`.
   - The footer uses an inline GitHub icon and links to the independent project repository.

3. `ui/analyzer/analyzer.html`
   - Local links remain `analyzer.css` and `analyzer.js`.
   - Shared scripts load `utils.js`, `network.js`, `registry.js` and `ui.js` before `analyzer.js`.

4. `background/background.js`
   - Imports `../shared/utils.js`, `../shared/network.js`, and `../shared/registry.js` through `importScripts`.

## Automation script

Use:

```bash
./scripts/restructure_sources.sh
```

It flattens a legacy `src/`-based tree into root-level extension folders.

## Local validation

Syntax and unit checks need no installed packages. Use Node.js 20 or newer:

```bash
node scripts/check.cjs
node --test
```

The first command checks JavaScript syntax and local resources referenced by the
manifest and UI. The second runs parser, network and service-worker regression
tests. For real browser verification:

```bash
npm ci
npx playwright install chromium --no-shell
npm run test:browser
```

Playwright is a development dependency only. Chrome loads the source folders
directly; no bundler or runtime package installation is required.

`shared/utils.js` contains URL/record parsing, the analysis model, cancellation
helpers and the callback-to-Promise Chrome adapter. `network.js` owns bounded
network reads. `registry.js` validates seller records and manages analyzer cache
and shared downloads. `ui.js` provides cancellable batched DOM rendering.

See `quality-audit.md` for findings, verification evidence and practical limits.
