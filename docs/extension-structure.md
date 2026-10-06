# Chrome Extension Structure (MV3)

## Current layout

```text
background/
  background.js
content/
  overlay.js
shared/
  utils.js
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
    icon.svg
scripts/
  restructure_sources.sh
trigger action/
  trigger_action.py
manifest.json
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
   - `content_scripts[].js`: `content/overlay.js`
   - `icons.128`: `assets/icons/icon128.png`

2. `ui/popup/popup.html`
   - Local links remain `popup.css` and `popup.js`.
   - Shared utility script remains `../../shared/utils.js`.
   - The footer uses an inline GitHub icon and links to the independent project repository.

3. `ui/analyzer/analyzer.html`
   - Local links remain `analyzer.css` and `analyzer.js`.

4. `background/background.js`
   - Shared utility import remains `importScripts('../shared/utils.js')`.

## Automation script

Use:

```bash
./scripts/restructure_sources.sh
```

It flattens a legacy `src/`-based tree into root-level extension folders.
