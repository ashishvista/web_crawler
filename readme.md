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
| `CONCURRENCY` | `1` | Max parallel browser contexts (Crawlee auto-scales up to this limit) |
| `PAGE_TIMEOUT` | `30000` | Navigation timeout per page (ms) |
| `SLEEP_BASE_MS` | `1500` | Post-load delay before extraction (ms); up to +1000ms random jitter added |
| `RETRY_COUNT` | `3` | Attempts per SKU before marking as failed (Crawlee manages retry backoff) |
| `SLOW_MO` | `0` | Delay between every browser action (ms) — helps bypass bot detection (try 50–150) |
| `PROXY_URL` | _(none)_ | Residential proxy URL: `http://user:pass@host:port` |
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
