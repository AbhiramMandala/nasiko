/**
 * `NasikoElement` — the base class for new components.
 *
 * It exists to make the codebase's four recurring bug classes *structurally
 * impossible* rather than "documented in AGENTS.md and usually remembered":
 *
 *   1. **Un-escaped interpolation.** 318 `innerHTML` writes were guarded by 38
 *      private escape helpers in four incompatible families, two of which were
 *      used in attribute position where they don't escape quotes. Lit's `html`
 *      templates escape every interpolation by construction, so the whole class
 *      disappears for anything written on this base.
 *   2. **Leaked listeners and timers.** Three confirmed leaks existed
 *      (`app-nav-search`'s window `resize` on all 37 pages, `autocomplete`'s
 *      anonymous document `click` — un-removable, not merely un-removed — and
 *      `mcp-page`'s 500 ms interval with no `disconnectedCallback`). Here
 *      `listen()`, `interval()` and `timeout()` are torn down automatically.
 *   3. **Uncancellable requests.** There was no `AbortController` anywhere in
 *      the UI, and the A2A stream reader kept pulling into detached DOM after
 *      navigation. Every element now owns a `signal` that aborts on disconnect;
 *      pass it to every fetch.
 *   4. **Hidden dependencies.** Components imported `fetchApi` by path, so
 *      nothing could be substituted without a global override in the preview
 *      tool. `static inject` declares dependencies at the top of the file and
 *      `withOverrides()` swaps them in tests.
 *
 * Styling follows the existing house rules exactly — light DOM, `@scope`,
 * `document.adoptedStyleSheets` — so a `NasikoElement` and a hand-written custom
 * element look identical from the outside and can sit in the same page.
 */

import { LitElement, html, nothing } from '../vendor/lit-all.esm.js';
import { injectOptional, keys, resolveAll } from './container.js';
import { shouldReport, userMessage, isAbort } from './errors.js';
import { computed as makeComputed, effect as runEffect } from '../state/signal.js';

/** Tracks which classes have already pushed their sheet onto the document. */
const adopted = new WeakSet();

export class NasikoElement extends LitElement {
  /**
   * Declare dependencies: `static inject = { api: keys.api, store: keys.store }`.
   * Resolved once, before the first render, onto `this.api` / `this.store`.
   * @type {Record<string, import('./container.js').InjectionKey>}
   */
  static inject = {};

  /**
   * Component CSS as a string. Wrapped in `@scope (<tag>) { … }` automatically
   * when it doesn't already open with `@scope`, then adopted onto the document
   * once per class — the same mechanism the existing 28 inline-sheet components
   * use, just without each one retyping it.
   *
   * Use canonical design tokens only (`--bg-* --fg-* --border-* --s-* --r-*`).
   * Never a hex value or a raw px size.
   * @type {string|null}
   */
  static styleText = null;

  /**
   * Elements with layout footprint must also have a `:not(:defined)` rule in
   * `styles/not-defined.css` reserving the same geometry — a component's own
   * sheet is adopted by its module and therefore does not exist at first paint.
   * Set this to `false` for overlays with no flow footprint (modals, toasts,
   * menus) so the Phase 6 lint knows the omission is intentional.
   */
  static needsUpgradeReservation = true;

  /** @type {AbortController} */
  #abort = new AbortController();
  /** @type {Array<() => void>} */
  #teardown = [];
  #firstConnected = false;

  constructor() {
    super();
    const deps = resolveAll(/** @type {any} */ (this.constructor).inject || {});
    Object.assign(this, deps);
  }

  /**
   * Light DOM. The house rule is no `attachShadow()` anywhere — style isolation
   * comes from CSS `@scope`, which keeps page CSS able to reach in when it
   * legitimately must and avoids the slotting ceremony. 69 of 69 existing
   * components honour this; so does every new one.
   */
  createRenderRoot() {
    /** @type {any} */ (this.constructor).adoptStyles();
    return this;
  }

  /** Adopt this class's scoped sheet onto the document, once. */
  static adoptStyles() {
    if (!this.styleText || adopted.has(this)) return;
    const tag = this.tagName || elementTagOf(this);
    const text = this.styleText.trimStart().startsWith('@scope')
      ? this.styleText
      : `@scope (${tag}) {\n${this.styleText}\n}`;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    adopted.add(this);
  }

  /** AbortSignal for this element's lifetime. Pass it to every request. */
  get signal() {
    return this.#abort.signal;
  }

  connectedCallback() {
    super.connectedCallback();
    // Re-attach after a disconnect needs a live controller again; the old one
    // is already aborted.
    if (this.#abort.signal.aborted) this.#abort = new AbortController();
    if (!this.#firstConnected) {
      this.#firstConnected = true;
      try {
        this.firstConnected();
      } catch (err) {
        this.report(err);
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort.abort();
    const fns = this.#teardown;
    this.#teardown = [];
    for (const fn of fns) {
      try {
        fn();
      } catch (err) {
        console.error('[NasikoElement] teardown failed', this.localName, err);
      }
    }
  }

  /**
   * One-time setup, after the element is in the document. Prefer this to
   * `connectedCallback` — it runs exactly once even if the element is moved,
   * which is what the hand-written `#initialized` guard was doing in 37
   * components (and forgetting in 24 others).
   */
  firstConnected() {}

  /** Register arbitrary cleanup to run on disconnect. */
  onTeardown(fn) {
    if (typeof fn === 'function') this.#teardown.push(fn);
    return fn;
  }

  /**
   * Add an event listener that is removed automatically on disconnect.
   * Use this for anything on `window`, `document`, or another element.
   *
   * @param {EventTarget} target
   * @param {string} type
   * @param {EventListenerOrEventListenerObject} handler
   * @param {AddEventListenerOptions} [options]
   */
  listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this.onTeardown(() => target.removeEventListener(type, handler, options));
    return handler;
  }

  /**
   * `setInterval` that is cleared on disconnect and — by default — paused while
   * the tab is hidden.
   *
   * The pause matters: `visibilitychange` appeared zero times in the UI, and two
   * unbounded 5-second pollers kept hitting admin-only endpoints ~720 times an
   * hour in a background tab.
   *
   * @param {() => void} fn
   * @param {number} ms
   * @param {{ pauseWhenHidden?: boolean, runImmediately?: boolean }} [opts]
   */
  interval(fn, ms, { pauseWhenHidden = true, runImmediately = false } = {}) {
    let id = null;
    const start = () => {
      if (id === null) id = setInterval(fn, ms);
    };
    const stop = () => {
      if (id !== null) clearInterval(id);
      id = null;
    };
    if (runImmediately) fn();
    if (pauseWhenHidden && typeof document !== 'undefined') {
      this.listen(document, 'visibilitychange', () => (document.hidden ? stop() : (fn(), start())));
      if (!document.hidden) start();
    } else {
      start();
    }
    this.onTeardown(stop);
    return { stop };
  }

  /** `setTimeout` cleared on disconnect. */
  timeout(fn, ms) {
    const id = setTimeout(fn, ms);
    this.onTeardown(() => clearTimeout(id));
    return id;
  }

  /**
   * Run a reactive effect bound to this element's lifetime, and re-render when
   * the signals it reads change. This is the bridge between the store and Lit.
   *
   * ```js
   * firstConnected() {
   *   this.watch(() => { this.user = this.store.currentUser.data.get(); });
   *   this.store.currentUser.load();
   * }
   * ```
   */
  watch(fn) {
    const dispose = runEffect(() => {
      fn();
      this.requestUpdate();
    });
    this.onTeardown(dispose);
    return dispose;
  }

  /**
   * Create a derived value bound to this element's lifetime.
   *
   * Always prefer this to a bare `computed()` inside a component: a computed
   * stays attached to its source signals until disposed, and its closure
   * captures `this`, so an undisposed one keeps the component alive after
   * removal from the DOM.
   *
   * @template T
   * @param {() => T} fn
   * @param {string} [name]
   */
  compute(fn, name) {
    const c = makeComputed(fn, name);
    this.onTeardown(() => c.dispose());
    return c;
  }

  /**
   * Bind a `resource()` to this element: loads it, re-renders on change, and
   * returns the resource so `state`/`error` can drive the template.
   * @template T
   * @param {ReturnType<import('../state/store.js').resource>} res
   */
  useResource(res) {
    this.watch(() => {
      res.data.get();
      res.state.get();
      res.error.get();
    });
    // Fire-and-forget: the template renders from `state`, and a rejection is
    // already recorded on the resource, so a floating rejection here would be
    // double reporting.
    res.load().catch(() => {});
    return res;
  }

  /**
   * Report an error to the user, unless it's a cancellation or a session
   * expiry (both invisible by design — one is us, the other is a navigation
   * already in progress).
   */
  report(err, fallback) {
    if (!shouldReport(err)) return;
    console.error(`[${this.localName}]`, err);
    const notifier = /** @type {any} */ (this).notifier || injectOptional(keys.notifier);
    notifier?.error?.(userMessage(err, fallback));
  }

  /**
   * Run an async action with the element's signal attached, reporting failures
   * and swallowing cancellations. The common "click a button, call the API,
   * refresh a table" shape.
   *
   * @template T
   * @param {(ctx: { signal: AbortSignal }) => Promise<T>} fn
   * @param {{ fallback?: string }} [opts]
   */
  async run(fn, { fallback } = {}) {
    try {
      return await fn({ signal: this.signal });
    } catch (err) {
      if (isAbort(err)) return undefined;
      this.report(err, fallback);
      return undefined;
    }
  }

  /** Dispatch a bubbling CustomEvent — the house convention for component output. */
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: false }));
  }
}

/**
 * Define a custom element idempotently, adopting its styles.
 *
 * Idempotence matters because pages load module graphs by `<script type="module">`
 * in a fixed order and a duplicated import used to throw
 * `NotSupportedError: name already used`, taking the whole page's JS down.
 *
 * @param {string} tag
 * @param {typeof HTMLElement} cls
 */
export function defineElement(tag, cls) {
  if (customElements.get(tag)) return customElements.get(tag);
  /** @type {any} */ (cls).tagName = tag;
  if (/** @type {any} */ (cls).adoptStyles) /** @type {any} */ (cls).adoptStyles();
  customElements.define(tag, cls);
  return cls;
}

/**
 * The tag a class is registered under. `defineElement` sets `static tagName`;
 * this only runs when someone called `customElements.define` directly, in which
 * case we cannot know the tag and the `@scope` wrapper would be silently wrong —
 * so fail loudly instead of shipping unscoped CSS.
 */
function elementTagOf(cls) {
  throw new Error(
    `Cannot determine a tag name for ${cls?.name || 'this component'}. ` +
      `Register it with defineElement('my-tag', MyClass) instead of ` +
      `customElements.define, so its @scope wrapper matches the element.`,
  );
}

export { html, nothing };
