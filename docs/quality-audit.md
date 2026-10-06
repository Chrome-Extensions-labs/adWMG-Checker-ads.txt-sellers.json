# Detailed stability review — version 7.5.0

Reviewed on 2026-10-06. The manifest version was retained. Scope: runtime, UI,
assets, scripts, tests, workflows, configuration and project documentation.
License and community policy terms were retained.

## Findings and changes

| Area | Finding | Implemented change |
| --- | --- | --- |
| Website URLs | Analyzer lost HTTP, ports and the original www host. | Popup/viewer pass the complete URL; analysis preserves the origin and final redirect links. Legacy domain parameters still work. |
| Popup | Slow registry blocked both text files. | File analysis becomes usable independently; registry loading and fallback have explicit states. |
| Parsing | Statistics, filtering, metadata and columns repeated parsing. | A shared analysis model parses each loaded file once; parsing yields every 2,000 rows. |
| Provider matching | Related subdomains could falsely share an account namespace. | Filter compares normalized advertising-system and registry hostnames exactly. |
| Registry schema | Unusable records and conflicting duplicate IDs could replace valid data. | Normalize fields once; warn about unusable entries; reject entirely unusable registries and conflicting IDs without destroying good cache. |
| Analyzer resources | Many large cache entries and independent column downloads could accumulate. | Shared cache: 64 MiB estimated retention budget, 30 entries, ten-minute TTL, LRU and four concurrent downloads. Verification retains only requested IDs. |
| Rendering | Large synchronous DOM updates delayed input. | Files, popup results, verification and viewer render in batches of 400 rows. Account lookup uses native keyboard-accessible buttons. |
| Cancellation | Shared requests needed independent subscriber cancellation; obsolete results could affect a newer analysis. | Cancel queued work and unused downloads; dispose old panels and rendering; prevent old results from updating new views. |
| Badges | Old registry results could replace a new count. | Validate source URL and tab URL; content-script messages stay scoped to the originating tab; extension UI can target the selected publisher tab. |
| Text detection | An HTML-like comment could invalidate a real text file. | HTML sniffing checks the beginning of the document, while MIME validation remains in place. |
| Viewer | Repeated metadata scans and concurrent reinjection. | Shared metadata analysis and an injection marker reserved before asynchronous work. Preserve original text; fall back to plain text if batch rendering fails. |
| Resource checks | Worker imports and helper order were unchecked. | Check importScripts resources, content/UI helper order, syntax and package/manifest version consistency. |
| CI/templates | Templates described a different pipeline; checkout permissions and CLI repository context were incomplete. | Extension-specific reproduction/checklists; fixed permissions and GH_REPO; browser and offline automation tests added to CI. |
| Optional AI automation | Authentication during import, unchecked model output, substring deduplication and wrong PR SHA. | Import-safe main, configuration guards, output validation, constrained file references, complete deduplication markers, PR-head links and hard diff limits. Fork PRs skip the optional job. |
| Dependencies | Automation pins were hidden inside workflow commands. | requirements.txt enables dependency tracking; Requests updated to 2.34.2. Pinned Playwright is only a development dependency; the extension has no runtime package dependencies. |

## Retained behavior

- Opaque, case-sensitive seller IDs; CR/CRLF/LF; inline comments and semicolon
  extensions. Duplicate keys include domain, ID, relationship and certification ID.
- Deadlines cover the complete response body. Files are limited to 5 MiB and
  registries to 20 MiB. Only transient failures are retried.
- Persistent cache writes are serialized and tied to their provider URL. Failed
  refreshes show cached-data warnings. Navigation/closure cancel background scans.
- Independent GitHub footer, navy palette and default PubMatic registry.

## Verification completed

- **17 JavaScript tests passed:** parsing/async parity, URLs, opaque IDs, metadata,
  exact matching, streaming limits/deadlines, retries, cancellation, registry
  schema, subscriber handling, cache budgets/LRU/expiry, provider races, badges
  worker cache recovery and corrupted persistent cache repair.
- **6 Python tests passed offline:** configuration guards, output validation,
  exact deduplication, encoded permalinks, hard diff limits and a complete PR
  pipeline with fake API clients. No real issue or comment was published.
- **12 browser scenario groups passed in headless Chromium 151 on Windows with
  the unpacked MV3 extension actually loaded.** Chrome extension APIs were not
  mocked. Scenarios cover progressive popup loading, warnings/filtering,
  settings validation/recovery, malformed/offline cache fallback, stale badges,
  HTTP/port preservation through messaging, shared verification cache,
  keyboard lookup/search, cancellation/reanalysis and all-SSP grouping, empty/HTML/redirected files,
  12,000 records in each column, real content-script injection, text preservation,
  dark theme and service-worker restart. No uncaught page errors occurred.
- The test stops the real worker through CDP, confirms the stopped state, wakes
  it through messaging and checks that an in-memory probe disappeared while
  persistent cache survived without another registry download.
- Live PubMatic registry check: 934,398 bytes, 6,467 usable sellers. Eighteen
  records with unsupported seller_type NA were excluded with a visible warning.
  This is a point-in-time check; live data can change.
- Installed Requests/PyGithub passed a local HTTP transport/context-manager smoke
  check. No external write API was called.
- Popup/analyzer screenshots were visually inspected. Syntax, manifest and local
  resource checks passed.

## Repeating the checks

Node.js 20+; no packages needed for syntax/unit checks:

```bash
node scripts/check.cjs
node --test
```

Browser tests:

```bash
npm ci
npx playwright install chromium --no-shell
npm run test:browser
```

On Linux use `npx playwright install chromium --with-deps --no-shell` if system
libraries are missing. The test removes its isolated temporary profile and writes
screenshots to ignored test-results/. Publisher/registry responses are local
fixtures; analyzer HTTPS registry requests use controlled intercepted responses.

Offline repository-automation tests (Python 3.11+):

```bash
python -m unittest discover -s tests -p '*_test.py' -v
```

## Practical limits

- Seller verification confirms account-ID presence. It does not prove commercial
  relationships, certify identities or validate a complete supply chain.
- Provider namespace follows the configured registry hostname, with leading www
  normalized. Use a canonical provider URL for popup filtering when the actual
  JSON lives on an unrelated CDN. Subdomain namespaces remain distinct.
- Cache byte accounting estimates retained objects; it is not an exact heap cap.
  Entry counts and source sizes are independently bounded. Parsing/rendering
  yield, but the implementation does not virtualize an entire document.
- Protected sites, authentication, outages and browser policies can prevent
  retrieval. Size limits and errors are reported explicitly.
- Tests exercise actual popup pages and runtime messaging, not the user's toolbar
  button or Web Store installation. Reload an existing unpacked installation to
  apply the local edits.
- GitHub Actions was updated and reviewed locally but not dispatched. Linux CI,
  hosted model access and GitHub write permissions depend on repository settings.

## Reference checks

- [IAB ads.txt 1.1](https://github.com/InteractiveAdvertisingBureau/Supply-Chain-Validation/blob/main/ads.txt%20v1.1.md)
- [Chrome action API](https://developer.chrome.com/docs/extensions/reference/api/action)
- [Playwright extension testing](https://playwright.dev/docs/chrome-extensions)
- [PyGithub 2.5 context manager](https://pygithub.readthedocs.io/en/v2.5.0/github.html)
- [Requests release history](https://requests.readthedocs.io/en/latest/community/updates/)
