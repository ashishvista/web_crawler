# Valence Web Scraper

A TypeScript + Playwright scraper built on **Crawlee** that extracts product data (title, price, description, reviews) from **Amazon** and **Walmart** and writes results to a CSV file.

## Setup

```bash
npm install        # installs dependencies and Chromium via postinstall
```

## Running

```bash
npm run dev        # run with ts-node (development)
npm run build      # compile TypeScript → dist/
npm start          # run compiled output
npm test           # run Jest test suite
```

## Configuration

All settings are controlled via the `.env` file in the project root — the file is git-ignored so it won't be committed.

| Variable | Default | Description |
|---|---|---|
| `HEADLESS` | `false` | `false` = visible browser window, `true` = run invisibly |
| `BROWSER_CHANNEL` | `chrome` | `chrome` = system Google Chrome, empty = Playwright's bundled Chromium |
| `CONCURRENCY` | `1` | Max parallel browser contexts (Crawlee auto-scales up to this limit) |
| `PAGE_TIMEOUT` | `30000` | Navigation timeout per page (ms) |
| `SLEEP_BASE_MS` | `1500` | Post-load delay before extraction (ms); up to +1000ms random jitter added |
| `RETRY_COUNT` | `3` | Attempts per SKU before marking as failed (Crawlee manages retry backoff) |
| `SLOW_MO` | `0` | Delay between every browser action (ms) — helps bypass bot detection (try 50–150) |
| `PROXY_ENABLED` | `false` | `true` = route traffic through proxies in `proxies.json` |
| `PROXIES_PATH` | `proxies.json` | Path to JSON file containing list of proxy URLs |
| `CSV_PATH` | `product_data.csv` | Output file path |
| `ERROR_LOG` | `errors.log` | Error log file path |
| `SKUS_PATH` | `skus.json` | Input SKU list path |

## Adding SKUs

Edit `skus.json`:

```json
{
  "skus": [
    { "Type": "Amazon", "SKU": "B0CT4BB651" },
    { "Type": "Walmart", "SKU": "5326288985" }
  ]
}
```

Supported types: `Amazon`, `Walmart`.

## Output

Successful results are written to `product_data.csv` (appended if the file already exists):

| Column | Description |
|---|---|
| SKU | Product identifier |
| Source | Amazon or Walmart |
| Title | Product name |
| Description | Bullet points or product description |
| Price | Listed price |
| Number of Reviews and Rating | Rating + review count |

Failed SKUs are logged to `errors.log` with a timestamp and error message.

## How Bot Evasion Works

The scraper uses layered evasion. Each layer targets a different detection signal:

### Crawlee (browser fingerprinting)

Crawlee's built-in fingerprint engine (`@fingerprint-suite`) injects a consistent, realistic browser identity per session covering:

- User-agent string (fresh, frequency-weighted, desktop Chrome)
- Screen resolution matched to the UA
- WebGL renderer and vendor
- Canvas fingerprint
- Browser plugins list
- Navigator properties (platform, vendor, languages)

Each session gets a unique fingerprint. Sessions that get blocked are automatically retired and replaced.

### Session pool

`useSessionPool: true` + `persistCookiesPerSession: true` — once a session passes a bot challenge (e.g. after manual intervention or a clean IP), Crawlee reuses its cookies for subsequent requests, avoiding repeated challenges.

### Timing randomisation

A random jitter (base + up to 1000ms) is added after every page load via `postNavigationHooks`. `SLOW_MO` adds a per-action delay on top of that.

### Why bot challenges still appear (and what to do)

Crawlee fixes **browser-level** signals, but sites like Walmart use **Akamai Bot Manager** which also checks signals that no browser-level trick can fix:

| Signal | Crawlee fixes it? |
|---|---|
| `navigator.webdriver` flag | Yes |
| UA / screen size / fingerprint consistency | Yes |
| Cookie & session behaviour | Yes |
| **IP reputation** | **No — requires residential proxy** |
| TLS / HTTP2 fingerprint | Partially |
| Mouse movement / human interaction | No |

**IP reputation is the #1 cause of Walmart bot challenges.** Akamai flags datacenter and previously-seen scraper IPs regardless of how clean the browser fingerprint looks.

### Fixing bot challenges — in order of impact

1. **Add a residential proxy** — set `PROXY_ENABLED=true` in `.env`
   - Recommended providers for Walmart: **Bright Data**, **Oxylabs**, **Webshare**
   - Once a session gets a clean IP through the challenge, Crawlee reuses that session's cookies automatically
   - For Walmart, enable the proxy for **all requests** — not just on detection. By the time the challenge page is detected, Akamai has already flagged your real IP
2. **Slow down actions** — set `SLOW_MO=100` and `SLEEP_BASE_MS=3000`
3. **Lower concurrency** — set `CONCURRENCY=1`

## How Bot Detection Works

- **IP reputation** — Akamai maintains a global database of datacenter, proxy, and previously-flagged IPs shared across all Akamai-protected sites
- **TLS / JA3 fingerprint** — every TLS handshake reveals the client's cipher suite order; Chromium's JA3 differs from real Chrome and is known to Akamai
- **HTTP/2 fingerprint** — browsers send HTTP/2 frames in a specific order; automation tools produce a recognisably different pattern
- **JavaScript sensor** — Akamai injects a script that collects 300+ signals: mouse paths, scroll physics, keyboard timing, `performance.now()` precision, canvas entropy, and more — encrypted and scored server-side
- **Browser environment consistency** — checks that UA, screen size, plugins, timezone, and `window.chrome` structure are all internally coherent
- **Behavioural patterns** — no referrer on a direct product URL, perfect request intervals, no prior domain cookies, non-US geo on a US retailer
- **Press-and-hold challenge** — triggered when the score is borderline; measures physical mouse pressure curve, micro-tremor during hold, and sub-millisecond event timing that synthetic events cannot replicate

## How Akamai Bot Manager Detects Bots

Akamai runs a multi-layered scoring system. Every request gets a risk score — if it crosses a threshold, you get the "press and hold" challenge or a block.

### 1. IP Reputation (biggest factor)
- Maintains a global database of datacenter IP ranges (AWS, GCP, Azure, DigitalOcean, etc.)
- Tracks IPs seen scraping across **all Akamai-protected sites** — not just Walmart
- Residential IPs with a scraping history also get flagged over time
- This is why a fresh residential proxy works — clean IP history

### 2. TLS Fingerprint (JA3/JA4)
- Every TLS handshake produces a fingerprint based on cipher suites, extensions, and elliptic curves
- Real Chrome on Windows has a known JA3 hash — Playwright's Chromium produces a slightly different one
- Akamai cross-checks: does this JA3 match the claimed User-Agent?

### 3. HTTP/2 Fingerprint
- Real browsers send HTTP/2 frames in a specific order with specific settings
- Automated tools (including Playwright) send subtly different frame orders
- Akamai can fingerprint the HTTP/2 stack independently of the browser

### 4. JavaScript Sensor Data
- Akamai injects a JavaScript payload that collects 300+ signals from the browser:
  - Mouse movement patterns and velocity
  - Keyboard timing between keypresses
  - Scroll behaviour
  - `performance.now()` precision
  - Battery API values
  - Device orientation events
  - Timing of `requestAnimationFrame`
- This data is encrypted and sent back to Akamai servers for scoring

### 5. Browser Environment Consistency
- Checks that all signals are internally consistent:
  - Does the screen resolution match the UA's typical platform?
  - Do navigator plugins match what that browser version ships with?
  - Is `window.chrome` present and structured correctly?
  - Does `Intl.DateTimeFormat` match the declared timezone?
- Crawlee's fingerprint injection addresses most of these

### 6. Behavioural Patterns
- Request timing — humans don't hit pages at perfectly regular intervals
- Navigation path — real users arrive from Google/social, not directly to product URLs
- Missing referrer header on direct product URL requests is suspicious
- Cookie presence — real users have browsing history cookies

### Why the "press and hold" challenge is hard to automate

This challenge specifically collects mouse pressure, movement curve, and hold duration — patterns that are very hard to fake programmatically. That is why Crawlee's session reuse matters: once a session passes the challenge (manually or via a clean IP), the cookie is reused for all subsequent requests from that session, avoiding the challenge entirely.

## How Retries Work When a Bot Challenge Is Detected

When the scraper detects `"Robot or human?"` or `"Access Denied"` in the page HTML, this is what happens:

```
Anti-bot detected
  → session.retire()          # immediately discard blocked session + its cookies
  → throw error               # signal Crawlee to retry
  → Crawlee assigns new session   # fresh fingerprint, no cookies from blocked session
  → Webshare rotating proxy   # new residential IP on every new connection
  → retry with clean identity
```

### Why session.retire() matters

Without explicitly retiring the session, Crawlee only increments the session's internal error score. The same session — with the same cookies Akamai used to flag you — would be reused for the retry. The retry would likely get challenged again.

Calling `session.retire()` immediately before throwing forces Crawlee to:
- Discard the blocked session and all its cookies
- Create a fresh session with a new browser fingerprint
- Combined with Webshare's rotating proxy, the retry arrives with a completely new identity

### "Product not found" does not retire the session

A missing product page is a legitimate response from the site — not a block. Retrying with a new IP won't help, so the session is kept alive for other requests.

### Without a proxy, retries have limited value

If `PROXY_ENABLED=false`, every retry still originates from your real IP. Akamai has already flagged it, so retries will keep hitting the challenge regardless of the fresh session and fingerprint. This is why the proxy should be enabled for all Walmart requests from the start — not just on detection.

## Why Crawlee Cannot Pass the "Press and Hold" Challenge

The "press and hold" challenge is a **physical interaction test**, not a browser fingerprint test. Crawlee fixes passive signals — things the browser reports about itself. This challenge requires active signals generated by a real human physically interacting with a mouse or touchscreen.

### What the challenge actually measures

When you press and hold the button, Akamai's JavaScript collector captures:

- **Mouse down coordinates** — did the cursor land naturally or teleport to the exact center?
- **Pressure curve** — real fingers show gradual pressure build-up; automation jumps to full click instantly
- **Micro-movements during hold** — humans have natural hand tremor (1–3px drift); automation holds perfectly still
- **Hold duration variance** — humans release slightly before or after the target time; automation hits it exactly
- **Mouse up trajectory** — how the cursor moves after release
- **Event timing** — `mousedown`, `mousemove`, `mouseup` timestamps at millisecond precision; real users show irregular gaps, automation shows suspiciously even intervals

### Why simulating mouse events doesn't work

Playwright's `page.mouse` API can simulate a hold:

```typescript
await page.mouse.move(x, y);
await page.mouse.down();
await page.waitForTimeout(3000);
await page.mouse.up();
```

But Akamai's collector detects this because:

1. Synthetic DOM events lack the sub-millisecond timing irregularities of real hardware input
2. Movement to the button is a perfect straight line, not a natural curve
3. No micro-tremor during the hold
4. Pressure ramps are missing entirely — only available from real touch hardware
5. Event timestamps are generated by Node.js, not a real OS input driver — they have different jitter characteristics

### What actually works

| Approach | Works? | Why |
|---|---|---|
| Crawlee fingerprinting | No | Fixes passive signals, not active interaction |
| Simulated mouse events | No | Synthetic events lack hardware timing characteristics |
| Clean residential IP | Often yes | Akamai may not show the challenge at all to trusted IPs |
| Session reuse after human solve | Yes | Cookie proves the challenge was solved; not shown again |
| CAPTCHA solving services (2captcha, CapSolver) | Sometimes | Routes to human workers who physically solve it |

The approach used in this project — **residential proxy + session reuse** — is the most reliable path. A trusted IP often skips the challenge entirely, and once a session is through it, the cookie keeps it clear for all subsequent requests.

---

## Development Journey

A chronological record of every approach tried, what it was meant to solve, and what happened.

### Anti-Bot & Stealth

| # | Approach | Problem it solved | Outcome |
|---|---|---|---|
| 1 | Manual `User-Agent` header string | Basic UA detection | Worked for simple sites; not enough for Amazon/Walmart |
| 2 | `user-agents` npm package | Randomise UA per request | Added realistic UAs but didn't handle fingerprint signals beyond the header |
| 3 | `playwright-extra` stealth plugin | Mask `navigator.webdriver`, canvas, plugins | Helped with basic bot checks; not effective against Akamai |
| 4 | Migrated to **Crawlee** `PlaywrightCrawler` | Replace all manual stealth code | Crawlee injects full browser fingerprints (UA, WebGL, canvas, screen, plugins) per session — replaced stealth plugin and `user-agents` package entirely |
| 5 | `browserPoolOptions.useFingerprints: true` | Realistic fingerprint per session | Each session gets a unique, consistent fingerprint; Crawlee handles rotation automatically |

### Proxy Setup

| # | Approach | Problem it solved | Outcome |
|---|---|---|---|
| 6 | No proxy (direct IP) | — | Amazon worked; Walmart blocked immediately |
| 7 | Webshare rotating proxy — port **80** | Mask real IP | `ERR_PROXY_CONNECTION_FAILED` — port 80 only handles HTTP, not HTTPS CONNECT tunneling |
| 8 | Webshare rotating proxy — port **3128** | HTTPS CONNECT tunneling | Connectivity fixed; proxy working (confirmed via `npm run test:proxy`) |
| 9 | Sticky session via username format (`cvtaqxhe-rotate-session-ID`) | Keep same IP per session | Webshare rejected the modified username format — `ERR_TUNNEL_CONNECTION_FAILED` |
| 10 | Reverted to simple `proxyUrls` array | Drop sticky username hack | Rotating proxy worked but gave a new IP every request — no session stickiness |
| 11 | Static residential proxies (`proxies.json`) | True IP stickiness per session | Each session gets a fixed IP; Crawlee's `proxyConfiguration.newUrl(sessionId)` assigns and locks the mapping automatically |

### Session Management

| # | Approach | Problem it solved | Outcome |
|---|---|---|---|
| 12 | `useSessionPool: true` + `persistCookiesPerSession: true` | Reuse browser session across retries | Sessions persist cookies; same session → same proxy IP → same fingerprint within a run |
| 13 | `CRAWLEE_PURGE_ON_START=false` in `.env` | Keep solved session cookies between runs | Sessions survive restarts; Walmart cookies from a solved challenge carried over *(must be in `.env` — Crawlee reads this at import time)* |
| 14 | Explicit `RequestQueue.drop()` at startup | SKUs being skipped because queue from previous run still existed | Fixed — queue wiped on every run; session store preserved separately |
| 15 | `npm run delete_queue` / `npm run delete_sessions` scripts | Manual control over what gets wiped | Clean alternative to `CRAWLEE_PURGE_ON_START=true`; purge only what you need |

### Walmart Bot Detection (Akamai)

| # | Approach | Problem it solved | Outcome |
|---|---|---|---|
| 16 | `session.retire()` on challenge detection | Force new fingerprint + proxy IP on retry | Correct pattern for headless mode; Crawlee creates a fresh session on next retry |
| 17 | `page.waitForFunction()` — wait for challenge to clear | Manual press-and-hold in visible mode | Works — user solves the challenge in the open browser window; scraper continues automatically |
| 18 | `HEADLESS=false` + manual press-and-hold | Unblockable Akamai challenge | Most reliable current approach; Akamai validates physical press timing that automation can't replicate |
| 19 | Static residential proxies (higher reputation) | Rotating IPs flagged by Akamai | Akamai still shows challenge — IP reputation alone isn't the deciding factor; JS sensor data and behavioral signals matter more |
| 20 | Switched to US-based static residential proxies | Non-US IPs (Germany, UK) scoring as higher risk for a US retailer | Same Akamai press-and-hold challenge — geolocation was not the root cause; Webshare IP ranges are flagged in Akamai's threat database regardless of country |
| 21 | `channel: 'chrome'` via `BROWSER_CHANNEL=chrome` env var | Chromium's JA3 and HTTP/2 fingerprints are known to Akamai | Pending — real Chrome has a far more common TLS fingerprint vs Chromium's recognisable scraper fingerprint |

### Infrastructure & Config

| # | Approach | Problem it solved | Outcome |
|---|---|---|---|
| 22 | `.env` file for all runtime config | Hard-coded values | All settings (headless, proxy, concurrency, timeouts, paths) externalised |
| 23 | `SLOW_MO` env var | Make browser actions look human during debugging | Useful at 50–150ms for debugging; keep at `0` for production |
| 24 | `parseProxyUrl()` in `test-proxy.ts` | Chromium doesn't parse credentials embedded in proxy URL reliably | Split into `server` / `username` / `password` fields; Crawlee handles this internally for the scraper |
| 25 | `proxies.json` (git-ignored) | Store list of static proxy URLs outside code | Clean separation of credentials from code; loaded at runtime |
| 26 | `postNavigationHooks` random jitter | Fixed sleep timing is a bot signal | `SLEEP_BASE_MS + random * 1000ms` after every page load |
| 27 | `preNavigationHooks` — `gotoOptions.referer = 'https://www.google.com/'` | Direct deep-link navigation is a strong bot signal | Did not work — Akamai challenge still shown; IP reputation and JS sensor score outweigh the referrer header |

### Current State

| Layer | Solution in use |
|---|---|
| Browser automation | Crawlee `PlaywrightCrawler` |
| Browser binary | Google Chrome (`BROWSER_CHANNEL=chrome`) |
| Fingerprinting | Crawlee `useFingerprints: true` (Chrome, desktop, Windows/macOS) |
| Proxy | Static residential IPs from `proxies.json` |
| Session stickiness | Crawlee session pool + `proxyConfiguration.newUrl(sessionId)` (automatic) |
| Cookie persistence | `persistCookiesPerSession: true` + `CRAWLEE_PURGE_ON_START=false` |
| Walmart bot bypass | `HEADLESS=false` + manual press-and-hold; `session.retire()` in headless mode |
| Amazon bot bypass | Session retire + retry on CAPTCHA detection |
| Output | `product_data.csv` (append mode), `errors.log` |
