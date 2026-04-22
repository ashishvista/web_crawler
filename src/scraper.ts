import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';
import {chromium, Browser,BrowserContext, Page} from 'playwright';
import {ProductData, logError, retry, sleep, writeToCSV, runConcurrent} from './utils';

const HEADLESS      = process.env.HEADLESS !== 'false';
const CONCURRENCY   = parseInt(process.env.CONCURRENCY   ?? '2', 10);
const PAGE_TIMEOUT  = parseInt(process.env.PAGE_TIMEOUT  ?? '30000', 10);
const SLEEP_BASE_MS = parseInt(process.env.SLEEP_BASE_MS ?? '1500', 10);
const RETRY_COUNT   = parseInt(process.env.RETRY_COUNT   ?? '3', 10);
const RETRY_DELAY   = parseInt(process.env.RETRY_DELAY_MS ?? '3000', 10);
const SKUS_PATH     = path.resolve(process.cwd(), process.env.SKUS_PATH ?? 'skus.json');

interface SKUEntry {
  Type: 'Amazon' | 'Walmart';
  SKU: string;
}
// Rotate UAs to reduce bot fingerprinting

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function pickUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function stealthContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    userAgent: pickUA(),
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  // Pass as a string — runs in browser context, not Node.js
  await ctx.addInitScript(
    `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`
  );

  return ctx;
}
// Amazon
async function scrapeAmazon(page: Page, sku: string): Promise<ProductData> {
  await page.goto(`https://www.amazon.com/dp/${sku}`, {
    waitUntil: 'domcontentloaded',
    timeout: PAGE_TIMEOUT,
  });
  await sleep(SLEEP_BASE_MS + Math.random() * 1000);

  const html = await page.content();
  if (/robot check|Enter the characters you see/i.test(html))
    throw new Error('CAPTCHA detected');
  if (/Looking for something\?|Page Not Found/i.test(html))
    throw new Error('Product not found');

  const title = await page
    .$eval('#productTitle', el => el.textContent?.trim() ?? '')
    .catch(() => 'N/A');

  const price = await page.evaluate((): string => {
    const candidates = [
      '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
      '.priceToPay .a-offscreen',
      '#price_inside_buybox',
      '#priceblock_ourprice',
      '.a-price .a-offscreen',
    ];
    for (const sel of candidates) {
      const t = document.querySelector(sel)?.textContent?.trim();
      if (t) return t;
    }
    return 'N/A';
  });
    const description = await page.evaluate((): string => {
    const bullets = Array.from(
      document.querySelectorAll('#feature-bullets .a-list-item')
    )
      .map(el => el.textContent?.trim())
      .filter(Boolean)
      .join('; ');
    if (bullets) return bullets;
    return document.querySelector('#productDescription')?.textContent?.trim() ?? 'N/A';
  });

  const reviewsAndRating = await page.evaluate((): string => {
    const rating = document.querySelector('#acrPopover .a-icon-alt')?.textContent?.trim()
      ?? document.querySelector('span[data-hook="rating-out-of-text"]')?.textContent?.trim()
      ?? '';
    const count = document.querySelector('#acrCustomerReviewText')?.textContent?.trim() ?? '';
    return [rating, count].filter(Boolean).join(' | ') || 'N/A';
  });

  return { sku, source: 'Amazon', title, description, price, reviewsAndRating };
}

// ─── Walmart ─────────────────────────────────────────────────────────────────

async function scrapeWalmart(page: Page, sku: string): Promise<ProductData> {
  await page.goto(`https://www.walmart.com/ip/${sku}`, {
    waitUntil: 'domcontentloaded',
    timeout: PAGE_TIMEOUT,
  });
  await sleep(SLEEP_BASE_MS + Math.random() * 1000);

  const html = await page.content();
  if (/Robot or human\?|Access Denied/i.test(html))
    throw new Error('Anti-bot challenge detected');
  if (/couldn't find|page not found/i.test(html))
    throw new Error('Product not found');

  await page.waitForSelector('h1', { timeout: 10_000 }).catch(() => {});

  const title = await page.evaluate((): string => {
    for (const sel of ['h1[itemprop="name"]', '#main-title', 'h1.prod-ProductTitle', 'h1']) {
      const t = document.querySelector(sel)?.textContent?.trim();
      if (t) return t;
    }
    return 'N/A';
  });

  const price = await page.evaluate((): string => {
    for (const sel of [
      '[itemprop="price"]',
      '[data-testid="price-wrap"] .price-characteristic',
      'span.price-characteristic',
      '[data-automation="buybox-price"]',
    ]) {
      const el = document.querySelector(sel);
      const v = el?.getAttribute('content') ?? el?.textContent?.trim();
      if (v) return v;
    }
    return 'N/A';
  });

  const description = await page.evaluate((): string => {
    for (const sel of [
      '[data-testid="product-description-content"]',
      '.about-product-description',
      '[data-automation="product-description"]',
      '#product-description',
    ]) {
      const t = document.querySelector(sel)?.textContent?.trim();
      if (t) return t;
    }
    return 'N/A';
  });

  const reviewsAndRating = await page.evaluate((): string => {
    const rating = document.querySelector('.stars-container')?.textContent?.trim()
      ?? document.querySelector('[itemprop="ratingValue"]')?.getAttribute('content')
      ?? '';
    const count  = document.querySelector('.rating-number')?.textContent?.trim()
      ?? document.querySelector('[itemprop="reviewCount"]')?.getAttribute('content')
      ?? '';
    return [rating, count].filter(Boolean).join(' | ') || 'N/A';
  });

  return { sku, source: 'Walmart', title, description, price, reviewsAndRating };
}

// ─── Per-SKU runner (own browser context + retry) ────────────────────────────

async function processSKU(browser: Browser, entry: SKUEntry): Promise<ProductData | null> {
  const ctx  = await stealthContext(browser);
  const page = await ctx.newPage();

  try {
    const data = await retry(
      () => entry.Type === 'Amazon'
        ? scrapeAmazon(page, entry.SKU)
        : scrapeWalmart(page, entry.SKU),
      RETRY_COUNT,
      RETRY_DELAY,
    );
    console.log(`[OK] ${entry.Type} | ${entry.SKU} | ${data.title.slice(0, 60)}`);
    return data;
  } catch (err) {
    logError(entry.SKU, entry.Type, (err as Error).message);
    return null;
  } finally {
    await ctx.close();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { skus }: { skus: SKUEntry[] } = JSON.parse(fs.readFileSync(SKUS_PATH, 'utf-8'));

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ],
  });

  try {
    const tasks = skus.map(entry => () => processSKU(browser, entry));
    const settled = await runConcurrent(tasks, CONCURRENCY);

    const successful = settled
      .filter((r): r is PromiseFulfilledResult<ProductData> =>
        r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value!);

    if (successful.length > 0) {
      await writeToCSV(successful);
      console.log(`\nSaved ${successful.length}/${skus.length} records → product_data.csv`);
    }

    const failed = skus.length - successful.length;
    if (failed > 0) console.log(`${failed} SKU(s) failed — see errors.log`);

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
