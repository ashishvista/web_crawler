# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # run scraper with ts-node (development)
npm run build        # compile TypeScript → dist/
npm start            # run compiled output
npm test             # run all Jest tests
npm run test:proxy   # verify proxy connectivity before running scraper
```

Run a single test file:
```bash
npx jest src/_tests_/utils.test.ts
```

Run a single test by name:
```bash
npx jest -t "retries and succeeds on second attempt"
```

## Architecture

### Data flow

```
skus.json → PlaywrightCrawler → extractAmazon / extractWalmart → results[] → product_data.csv
                                                                           → errors.log (failures)
```

`scraper.ts` is the entry point and contains everything: crawler setup, anti-bot detection, extraction logic, and output. `utils.ts` provides the `ProductData` interface, `writeToCSV`, and `logError`. The `runConcurrent` and `retry` helpers in `utils.ts` are no longer used by the scraper (Crawlee replaced them) but are kept because the test suite covers them.

### Crawlee integration

`PlaywrightCrawler` handles browser lifecycle, concurrency, retries, and session management. Key design decisions:

- **Navigation is done by Crawlee** — `extractAmazon` / `extractWalmart` receive an already-loaded page and only extract data. They do not call `page.goto`.
- **`postNavigationHooks`** adds a random sleep after every page load (before `requestHandler` runs).
- **`useSessionPool: true` + `persistCookiesPerSession: true`** — each session maintains its own cookies and fingerprint across requests. When `session.retire()` is called on bot detection, Crawlee creates a fresh session (new fingerprint + new proxy IP) for the retry.
- **`browserPoolOptions.useFingerprints: true`** — Crawlee injects realistic browser fingerprints per session (UA, WebGL, canvas, plugins). This replaces what `playwright-extra` stealth plugin and the `user-agents` package previously handled.

### Anti-bot detection

In `requestHandler`, after page load the HTML is checked for known bot-challenge strings before extraction is attempted. On detection: `session.retire()` is called first (discards cookies), then an error is thrown to trigger Crawlee's retry with a fresh session and proxy IP.

- `"Product not found"` errors do **not** retire the session — they are legitimate responses, not blocks.

### Proxy

Configured via `.env`. `PROXY_ENABLED=false` disables it entirely without touching the URL. The proxy URL must use **port 3128** (not 80) for HTTPS CONNECT tunneling to work with Playwright/Chromium.

`src/test-proxy.ts` (`npm run test:proxy`) verifies proxy connectivity independently of the scraper using raw Playwright. It uses `parseProxyUrl()` to split credentials into separate `username`/`password` fields — required because Chromium doesn't reliably parse credentials embedded in the proxy URL. Crawlee's `ProxyConfiguration` handles this internally so the scraper uses the full URL directly.

### Configuration

All runtime settings come from `.env` via `dotenv/config` (loaded at module import time). Defaults are defined inline on each `process.env` read. The `.env` file is git-ignored.

### CSS selector strategy

Both extractors use ordered arrays of CSS selectors with fallbacks, trying each in sequence and returning the first match. Amazon and Walmart both A/B test their layouts frequently, so multiple selectors per field are expected and intentional.
