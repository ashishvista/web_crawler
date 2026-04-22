import 'dotenv/config';
import { chromium } from 'playwright';

const PROXY_URL = process.env.PROXY_URL;
const TIMEOUT   = 20_000;
const IP_CHECK  = 'http://api.ipify.org?format=json';

function parseProxyUrl(raw: string) {
  const url = new URL(raw);
  return {
    server:   `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

async function getIP(proxyRaw?: string): Promise<string> {
  const proxy = proxyRaw ? parseProxyUrl(proxyRaw) : undefined;
  const browser = await chromium.launch({
    headless: true,
    ...(proxy ? { proxy } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.goto(IP_CHECK, { timeout: TIMEOUT });
    const body = await page.evaluate(() => document.body.innerText.trim());
    try {
      return JSON.parse(body).ip;
    } catch {
      throw new Error(`Unexpected response: "${body.slice(0, 80)}"`);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('--- Proxy Test ---\n');

  const realIP = await getIP().catch(err => {
    console.error('Failed to get real IP:', err.message);
    process.exit(1);
  });
  console.log(`Real IP:  ${realIP}`);

  if (!PROXY_URL) {
    console.log('\nPROXY_URL not set in .env — skipping proxy check.');
    return;
  }

  const { server, username } = parseProxyUrl(PROXY_URL);
  console.log(`Proxy:    ${server} (user: ${username})\n`);

  let proxyIP: string;
  try {
    proxyIP = await getIP(PROXY_URL);
  } catch (err) {
    console.error('Proxy failed:', (err as Error).message);
    console.error('\nThings to check:');
    console.error('  1. IP allowlist — add', realIP, 'at webshare.io → Proxy → IP Allowlist');
    console.error('  2. Credentials — verify username/password on webshare.io dashboard');
    console.error('  3. Port — confirm correct port in PROXY_URL');
    process.exit(1);
  }

  console.log(`Proxy IP: ${proxyIP}`);
  console.log(realIP !== proxyIP ? '\nProxy is working.' : '\nIPs match — proxy not routing traffic.');
}

main();
