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

1. **Add a residential proxy** — set `PROXY_URL=http://user:pass@host:port`
   - Recommended providers for Walmart: **Bright Data**, **Oxylabs**, **Webshare**
   - Once a session gets a clean IP through the challenge, Crawlee reuses that session's cookies automatically
2. **Slow down actions** — set `SLOW_MO=100` and `SLEEP_BASE_MS=3000`
3. **Lower concurrency** — set `CONCURRENCY=1`
