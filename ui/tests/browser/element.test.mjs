/**
 * Real-browser tests for NasikoElement. These cannot run in Node: they need
 * customElements, CSSStyleSheet, document.adoptedStyleSheets, @scope and CSS
 * module scripts. Until now the Lit base class had never been instantiated.
 */
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import { resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '.');
const { server, port } = await startServer(ROOT);
const base = `http://localhost:${port}`;

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

await page.goto(`${base}/login.html`, { waitUntil: 'load' });

const results = await page.evaluate(async (origin) => {
  const out = [];
  const ok = (name, cond, detail = '') => out.push({ name, pass: !!cond, detail: String(detail) });

  const { NasikoElement, defineElement, html } = await import(`${origin}/common/core/element.js`);
  const { keys, register, withOverrides } = await import(`${origin}/common/core/container.js`);
  await import(`${origin}/common/core/bootstrap.js`);
  const { signal } = await import(`${origin}/common/state/signal.js`);

  // ── A component using every facility the base class offers ────────────────
  const fakeApi = { get: async () => ({ data: [{ id: 1 }], total: 1 }) };
  register(keys.api, fakeApi);

  let teardownRan = 0;
  const tick = signal(0, 'tick');

  class TestThing extends NasikoElement {
    static inject = { api: keys.api };
    static styleText = `:scope { display: block; color: var(--fg-primary); }`;
    static properties = { label: { type: String } };

    constructor() { super(); this.label = 'initial'; this.renders = 0; this.intervalFires = 0; }

    firstConnected() {
      this.firstConnectedCalls = (this.firstConnectedCalls || 0) + 1;
    }

    // Subscriptions belong here: teardown runs on every disconnect, so anything
    // registered once in firstConnected would be lost the first time the element
    // is moved and never restored.
    connected() {
      this.connectedCalls = (this.connectedCalls || 0) + 1;
      this.watch(() => { this.tickValue = tick.get(); });
      this.listen(window, 'resize', () => { this.sawResize = true; });
      this.interval(() => this.intervalFires++, 20, { pauseWhenHidden: false });
      this.onTeardown(() => teardownRan++);
      this.derived = this.compute(() => tick.get() * 2, 'doubled');
    }

    render() { this.renders++; return html`<span class="v">${this.label}</span>`; }
  }
  defineElement('test-thing', TestThing);

  const el = document.createElement('test-thing');
  document.body.append(el);
  await el.updateComplete;

  // 1. Dependency injection resolved onto the instance.
  ok('DI: static inject resolved', el.api === fakeApi);

  // 2. LIGHT DOM — the house rule. No shadow root, content is in the element.
  ok('light DOM: no shadowRoot', el.shadowRoot === null, `shadowRoot=${el.shadowRoot}`);
  ok('light DOM: rendered into the element itself',
     el.querySelector('.v')?.textContent === 'initial',
     el.innerHTML.slice(0, 80));

  // 3. Styles adopted onto the DOCUMENT, wrapped in @scope for this tag.
  const sheets = [...document.adoptedStyleSheets];
  const scoped = sheets.some((s) =>
    [...s.cssRules].some((r) => (r.cssText || '').includes('@scope') && (r.cssText || '').includes('test-thing')));
  ok('styles: adopted onto document and @scope-wrapped', scoped,
     `${sheets.length} adopted sheets`);
  ok('styles: actually applied', getComputedStyle(el).display === 'block',
     getComputedStyle(el).display);

  // 4. Lit escapes interpolations — the reason the 38 escape helpers can go.
  el.label = '<img src=x onerror="window.__XSS=1">';
  await el.updateComplete;
  ok('escaping: markup in a property is not parsed as HTML',
     !el.querySelector('img') && window.__XSS === undefined,
     el.querySelector('.v')?.textContent?.slice(0, 40));

  // 6. Reactive: a signal write re-renders.
  const before = el.renders;
  tick.set(5);
  await el.updateComplete;
  ok('reactivity: signal write triggers re-render', el.renders > before, `${before} -> ${el.renders}`);
  ok('reactivity: watch saw the value', el.tickValue === 5, el.tickValue);
  ok('reactivity: compute() derived correctly', el.derived.get() === 10, el.derived.get());

  // 7. Timers fire.
  await new Promise((r) => setTimeout(r, 70));
  ok('interval: fired while attached', el.intervalFires >= 2, el.intervalFires);

  // 8. A move tears everything down and re-establishes it — the asymmetry bug.
  const parent = el.parentNode;
  el.remove();
  parent.append(el);
  await el.updateComplete;
  ok('move: firstConnected still ran only once', el.firstConnectedCalls === 1, el.firstConnectedCalls);
  ok('move: connected ran again', el.connectedCalls === 2, el.connectedCalls);
  tick.set(6);
  await el.updateComplete;
  ok('move: reactive binding re-established', el.tickValue === 6, el.tickValue);
  const firesAfterMove = el.intervalFires;
  await new Promise((r) => setTimeout(r, 70));
  ok('move: interval re-established', el.intervalFires > firesAfterMove,
     `${firesAfterMove} -> ${el.intervalFires}`);
  window.dispatchEvent(new Event('resize'));
  ok('move: window listener re-established', el.sawResize === true);
  el.sawResize = false;

  // 9. Teardown: abort signal, listeners, timers, computeds — all released.
  const firesAtRemoval = el.intervalFires;
  const derivedSignal = el.derived;
  el.remove();
  ok('teardown: onTeardown ran on each disconnect', teardownRan === 2, teardownRan);
  ok('teardown: signal aborted', el.signal.aborted === true);
  await new Promise((r) => setTimeout(r, 70));
  ok('teardown: interval stopped', el.intervalFires === firesAtRemoval,
     `${firesAtRemoval} -> ${el.intervalFires}`);
  window.dispatchEvent(new Event('resize'));
  ok('teardown: window listener removed', el.sawResize !== true);
  const observersBefore = tick.observerCount;
  tick.set(9);
  ok('teardown: watch detached from the signal', tick.observerCount === 0,
     `observerCount=${observersBefore}`);
  ok('teardown: computed disposed (value frozen at last compute)',
     derivedSignal.get() === 12, derivedSignal.get());

  // 9. defineElement is idempotent (a duplicated import used to throw and take
  //    down the whole page's module graph).
  let threw = false;
  try { defineElement('test-thing', TestThing); } catch { threw = true; }
  ok('defineElement: idempotent', !threw);

  // 10. Container override works in the browser too.
  let injected = null;
  const other = { get: async () => 'other' };
  await withOverrides([[keys.api, other]], async () => {
    class Probe extends NasikoElement { static inject = { api: keys.api }; }
    defineElement('probe-thing', Probe);
    const p = document.createElement('probe-thing');
    document.body.append(p);
    injected = p.api;
    p.remove();
  });
  ok('DI: withOverrides applies to new components', injected === other);

  return out;
}, base);

await browser.close();
server.close();

let fails = 0;
for (const r of results) {
  if (!r.pass) fails++;
  console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.pass ? '' : '   [' + r.detail + ']'}`);
}
for (const e of pageErrors) { fails++; console.log(`  FAIL pageerror: ${e}`); }
console.log(`\nNasikoElement: ${results.length - (fails - pageErrors.length)}/${results.length} passed`);
process.exit(fails ? 1 : 0);
