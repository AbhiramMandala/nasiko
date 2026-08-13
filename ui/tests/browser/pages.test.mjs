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
  // login.html must be exercised SIGNED OUT — see the route stub below.
  const signedOut = file === 'login.html';
  const errors = [];
  const consoleErrors = [];
  const missing = [];

  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // The signed-out stub returns 401 deliberately, and the browser logs every
    // failed fetch as a console error. Filtering it keeps this suite at a real
    // pass/fail — a page parked permanently on `warn` is a page whose output
    // people stop reading.
    if (signedOut && /\b401\b/.test(text)) return;
    consoleErrors.push(text.slice(0, 300));
  });
  page.on('requestfailed', (r) => missing.push(`${r.method()} ${r.url().replace(base, '')} (${r.failure()?.errorText})`));
  page.on('response', (r) => { if (r.status() === 404 && !r.url().includes('/api/')) missing.push(`404 ${r.url().replace(base, '')}`); });

  // Stub every API call: the goal is catching JS runtime failures, not data.
  //
  // login.html is the one page that must be stubbed as SIGNED OUT. It probes
  // /api/me and, on a JSON 200, correctly does location.replace('/') — so under a
  // blanket signed-in stub the suite navigated to the orchestrator and "tested"
  // that instead, reporting app-header and orchestrator-page as never upgraded on
  // a page that does not contain them. The login page was effectively uncovered.
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (signedOut && /\/api\/me\b/.test(url)) {
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: '{"error":"unauthorized"}',
      });
    }
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
    // Wait for every custom element in the document to be DEFINED, rather than a
    // fixed sleep. A flat timeout made this suite flaky in the worst way: the
    // heaviest page (runtime.html, 10 modules) intermittently reported three
    // elements as "never upgraded" when they were merely still loading. A test
    // that cries wolf gets ignored, which costs more than the bug it was
    // pretending to find.
    await page.evaluate(async () => {
      const tags = [...new Set([...document.querySelectorAll('*')]
        .map((el) => el.tagName.toLowerCase())
        .filter((t) => t.includes('-')))];
      // 5s ceiling per page: anything slower than that is a real problem, and we
      // still want the report rather than a hung run.
      await Promise.race([
        Promise.all(tags.map((t) => customElements.whenDefined(t).catch(() => {}))),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    });
    await page.waitForTimeout(300); // let first fetches settle and render
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

  // If the page navigated elsewhere, everything above measured the wrong
  // document. Report that rather than publishing confusing element results.
  const landedOn = new URL(page.url()).pathname.replace(/^\//, '') || 'index.html';
  const navigatedAway = landedOn !== file;

  results.push({
    file,
    errors,
    consoleErrors,
    missing: [...new Set(missing)],
    undefinedEls: navigatedAway ? [] : undefinedEls,
    navigatedAway: navigatedAway ? landedOn : null,
  });
  await ctx.close();
}

await browser.close();
server.close();

let hardFails = 0;
for (const r of results) {
  const hard = r.errors.length + r.missing.length;
  if (hard) hardFails++;
  const mark = hard
    ? 'FAIL'
    : r.consoleErrors.length || r.undefinedEls.length || r.navigatedAway
      ? 'warn'
      : ' ok ';
  console.log(`[${mark}] ${r.file}`);
  for (const e of r.errors) console.log(`         pageerror: ${e}`);
  for (const m of r.missing) console.log(`         missing:   ${m}`);
  for (const c of r.consoleErrors.slice(0, 3)) console.log(`         console:   ${c}`);
  if (r.navigatedAway) console.log(`         navigated to ${r.navigatedAway} — element checks skipped`);
  if (r.undefinedEls.length) console.log(`         never upgraded: ${r.undefinedEls.join(', ')}`);
}
console.log(`\n${unique.length} pages · ${hardFails} with uncaught errors or missing modules`);
process.exit(hardFails ? 1 : 0);
