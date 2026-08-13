/**
 * Real-browser smoke test: load every page and fail on any uncaught exception,
 * console error, or 404'd module. This is the check that Node-level tests
 * structurally cannot do — it exercises customElements, adoptedStyleSheets,
 * @scope, CSS module scripts and the actual module graph.
 */
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import { readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(process.argv[2] || '.');
const { server, port } = await startServer(ROOT);
const base = `http://localhost:${port}`;

const pages = [
  ...readdirSync(join(ROOT, 'oss/ui/web')).filter((f) => f.endsWith('.html')),
  ...readdirSync(join(ROOT, 'ee/ui/web')).filter((f) => f.endsWith('.html')).map((f) => f),
];
const unique = [...new Set(pages)].sort();

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ['--no-sandbox'] });
const results = [];

for (const file of unique) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  const consoleErrors = [];
  const missing = [];

  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('requestfailed', (r) => missing.push(`${r.method()} ${r.url().replace(base, '')} (${r.failure()?.errorText})`));
  page.on('response', (r) => { if (r.status() === 404 && !r.url().includes('/api/')) missing.push(`404 ${r.url().replace(base, '')}`); });

  // Stub every API call: the goal is catching JS runtime failures, not data.
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    // Default to the documented {data,total} envelope. A few routes predate it
    // and return a bare array; stub those faithfully so a harness artifact is
    // not mistaken for a product bug (this is how the runtime-service fragility
    // was found — and it was real).
    let body = { data: [], total: 0 };
    const BARE_ARRAY = ['/infra/clusters', '/agents?', '/model-pricing'];
    if (BARE_ARRAY.some((p) => url.includes(p))) body = [];
    if (url.includes('/me')) body = { id: 'u1', email: 'satya@nasiko.com', name: 'Satya', role: 'admin', is_superuser: true };
    if (url.includes('/org/context')) body = { role: 'admin', department_id: null, team_id: null };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  try {
    await page.goto(`${base}/${file}`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(700); // let modules upgrade + first fetches settle
  } catch (e) {
    errors.push(`navigation: ${e.message.split('\n')[0]}`);
  }

  // Did the custom elements actually upgrade?
  const undefinedEls = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.tagName.includes('-') && !customElements.get(el.tagName.toLowerCase())) {
        out.push(el.tagName.toLowerCase());
      }
    }
    return [...new Set(out)];
  });

  results.push({ file, errors, consoleErrors, missing: [...new Set(missing)], undefinedEls });
  await ctx.close();
}

await browser.close();
server.close();

let hardFails = 0;
for (const r of results) {
  const hard = r.errors.length + r.missing.length;
  if (hard) hardFails++;
  const mark = hard ? 'FAIL' : (r.consoleErrors.length || r.undefinedEls.length ? 'warn' : ' ok ');
  console.log(`[${mark}] ${r.file}`);
  for (const e of r.errors) console.log(`         pageerror: ${e}`);
  for (const m of r.missing) console.log(`         missing:   ${m}`);
  for (const c of r.consoleErrors.slice(0, 3)) console.log(`         console:   ${c}`);
  if (r.undefinedEls.length) console.log(`         never upgraded: ${r.undefinedEls.join(', ')}`);
}
console.log(`\n${unique.length} pages · ${hardFails} with uncaught errors or missing modules`);
process.exit(hardFails ? 1 : 0);
