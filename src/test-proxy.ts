import 'dotenv/config';
import { chromium } from 'playwright';

const PROXY_URL   = process.env.PROXY_URL;
const TIMEOUT     = 20_000;
// Plain HTTP — avoids HTTPS CONNECT tunneling issues with port-80 proxies
const IP_CHECK = 'http://api.ipify.org?format=json';

async function getIP(proxyServer?: string): Promise<string> {
  const browser = await chromium.launch({
    headless: true,
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.goto(IP_CHECK, { timeout: TIMEOUT });
    const body = await page.evaluate(() => document.body.innerText.trim());
    try {
      return JSON.parse(body).ip;
    } catch {
      throw new Error(`Proxy returned unexpected response: "${body.slice(0, 80)}" — add your IP to the Webshare allowlist at webshare.io`);
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

  console.log(`Proxy:    ${PROXY_URL}\n`);

  let proxyIP: string;
  try {
    proxyIP = await getIP(PROXY_URL);
  } catch (err) {
    console.error('Proxy connection failed:', (err as Error).message);
    console.error('\nThings to check:');
    console.error('  1. Port — try 8080 instead of 80 (or vice versa) in PROXY_URL');
    console.error('  2. Credentials — verify username/password on webshare.io dashboard');
    console.error('  3. Allowlist — add your real IP to the proxy allowlist on webshare.io');
    process.exit(1);
  }

  console.log(`Proxy IP: ${proxyIP}`);

  if (realIP !== proxyIP) {
    console.log('\nProxy is working.');
  } else {
    console.log('\nIPs match — proxy is not routing traffic. Check your PROXY_URL.');
  }
}

main();
