/**
 * `<app-card>` — THE card component. There is deliberately only one.
 *
 * Its design and implementation come from the card agents-page used to build
 * inline in `#agents-grid` — that is the card the design system standardises on.
 * An earlier, separate card component (a `NasikoCard` port with a left accent bar
 * and its own error/setting-up variants) was replaced by this one, and its single
 * consumer, your-agents-page, moved over: that accent bar became this card's
 * status dot. Two card components meant two designs drifting apart; there is now
 * one, and every card in the application should use it.
 *
 * The host element IS the card: its surface (border, radius, brand wash,
 * shadow, hover lift) comes from the shared `.card` rules in
 * `common/styles/surface.css`, which lists `app-card` by name — the same
 * way every other card in the product draws its surface. Only this card's
 * layout lives in the sibling sheet. Tag chips are `<app-tag size="sm">`
 * instances; the card's own fill for them is set once as `--tag-bg` on
 * `.card-tags` in the sibling sheet.
 *
 * Presentational only: it takes attributes and emits navigation. It fetches
 * nothing and knows no services, so it stays inside the design-system layer.
 *
 * @element app-card
 * @attr {string} agent-id - Agent UUID. Drives the default hrefs and is echoed on the host.
 * @attr {string} name - Display name (required). `card-title` is accepted as an
 *   alias, because `title` is a reserved global attribute and the replaced
 *   card used that spelling — kept so call sites did not all have to change.
 * @attr {string} card-title - Alias for `name`, kept for the replaced card's call sites.
 * @attr {string} version - Rendered after the name; a leading "v" is added if absent
 * @attr {string} status - `running` | `error`/`failed` | `deploying`/`starting` | anything else → stopped
 * @attr {string} description - Body copy, clamped to exactly two lines
 * @attr {string} tags - JSON array, either of strings (`["a","b"]`) or of
 *   `{ label }` objects, which is the form the replaced card took.
 * @attr {string} href - Where the whole card navigates. Defaults to the details href.
 * @attr {string} error-title - Shown in place of the description when status is error/failed
 * @attr {string} error-body - Supporting line for the error state
 * @attr {string} deploy-label - Overrides the deploying headline (default "Agent is being deployed...")
 * @attr {string} deploy-hint - Overrides the deploying hint line
 * @attr {number} max-visible-tags - Chips shown before the "+N" overflow chip (default 2)
 * @attr {string} details-href - Overrides the default `/agent-card?id=…`
 * @attr {string} chat-href - Overrides the default `/chat?agent_id=…&agent_name=…`
 * @attr {boolean} loading - Renders the shimmer placeholder instead of content. The
 *   skeleton lives here, not in the consuming page, so the card's geometry has exactly
 *   one definition and the loading and loaded states cannot drift apart.
 * (The attribute below was added after the catalog first shipped and sits last
 *  on purpose: the DSL passes attributes positionally in @attr order, so a new
 *  one must append — see catalog-compat.mjs.)
 * @attr {string} error - *We* could not load this card's data — distinct from
 *   `status="error"`, which means the agent itself is unhealthy and the card
 *   loaded fine. Two different facts that happened to want a similar look, and
 *   only the second was expressible. Present (bare, or with a message
 *   overriding the default copy) replaces the whole card body with the shared
 *   failure block — icon, one line, Retry. `loading` wins over it.
 * @slot [data-slot="leading"] - A media box (an avatar, a provider glyph) at the leading edge
 *   of the title row, before the status dot.
 * @slot [data-slot="actions"] - Header controls (an action menu, an icon button) pinned to the
 *   trailing edge of the title row.
 * @slot [data-slot="body"] - Replaces the description/error/deploying body with the consumer's
 *   own content, for cards whose middle is not a paragraph (the LLM-router
 *   config card's tier rows, say).
 * @slot [data-slot="footer"] - Replaces the default Details/Chat pair (two `<app-button>`s) with the consumer's own
 *   actions (lifecycle buttons, a logs link). Captured once and cached: render()
 *   relocates these nodes and then rewrites innerHTML, so re-querying for them
 *   on a later render would find nothing and silently destroy them.
 *   Slotted nodes are captured once and cached: render() relocates them and then
 *   rewrites innerHTML, so re-querying on a later render would find nothing.
 * @fires card-retry - Retry pressed on the `error` state — bubbles. The card is
 *          handed its data, so the owner refetches.
 * @fires — none otherwise. A card with an href navigates to it on click or Enter; the two
 *          footer buttons keep their own hrefs and are not intercepted (each
 *          renders an inner `<a href>`, which the activation guard skips). A card
 *          without one only needs `role`/`tabindex` from the consumer, and Enter
 *          is forwarded as a click so a delegated handler sees it.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-card.css', import.meta.url));
import '../app-tag/app-tag.js';
import '../app-button/app-button.js';
import { icons } from '../../utils/icons.js';
import { escHtml, escAttr } from '../../utils/escape.js';
import { navigate as routerNavigate } from '../../core/router.js';
import { errorStateHtml, bindRetry } from '../app-empty-state/error-state.js';
import '../app-empty-state/app-empty-state.js';

import { warnOnce } from '../../utils/deprecate.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/** Status → dot modifier. Lifted unchanged from agents-page.js. */
function statusClass(status) {
  if (status === 'running') return 'is-running';
  if (status === 'error' || status === 'failed') return 'is-error';
  if (status === 'deploying' || status === 'starting') return 'is-pending';
  return 'is-stopped';
}

export class AppCard extends HTMLElement {
  static get observedAttributes() {
    return ['agent-id', 'name', 'card-title', 'version', 'status', 'description',
            'tags', 'max-visible-tags', 'details-href', 'chat-href', 'href',
            'error-title', 'error-body', 'deploy-label', 'deploy-hint', 'loading',
            'error'];
  }

  #initialized = false;
  /** Slotted children by slot name, captured on first render. See the slot notes. */
  #slots = new Map();

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    bindRetry(this, 'card-retry');
    this.render();

    // Own the navigation the page used to do by event delegation. Explicit
    // links inside the footer are left alone so they keep their own hrefs.
    this.addEventListener('click', this.#onActivate);
    this.addEventListener('keydown', this.#onKeydown);
  }

  attributeChangedCallback() {
    if (this.isConnected && this.#initialized) this.render();
  }

  #onActivate = (e) => {
    // A failed card navigates nowhere: the href is built from data we never
    // received, and the only thing to click is Retry.
    if (this.hasAttribute('error')) return;
    if (e.target.closest('a[href], button')) return;
    const href = this.#cardHref();
    if (href) routerNavigate(href);
  };

  #onKeydown = (e) => {
    if (this.hasAttribute('error')) return;
    if (e.key !== 'Enter' || e.target.closest('a[href], button')) return;
    const href = this.#cardHref();
    if (href) routerNavigate(href);
    // No href: the consumer owns activation (delegated click on a data-action).
    // A role means the card is interactive, so Enter must reach that handler —
    // a div with role="button" gets no synthetic click from the browser.
    else if (this.hasAttribute('role')) this.click();
  };

  #id() { return this.getAttribute('agent-id') || ''; }
  #name() { return this.getAttribute('name') || this.getAttribute('card-title') || ''; }

  #detailsHref() {
    return this.getAttribute('details-href')
      || (this.#id() ? `/agent-card?id=${encodeURIComponent(this.#id())}` : '');
  }

  /** Whole-card navigation target. `href` wins; otherwise the details href. */
  #cardHref() { return this.getAttribute('href') || this.#detailsHref(); }

  /** One slot's children, captured once — never re-queried, because render()
   *  rewrites innerHTML and a later query would find nothing. */
  #slotted(name) {
    if (!this.#slots.has(name)) {
      // `data-slot` is the marker (CONVENTIONS.md §3); `slot=` still works for
      // one release. Both are collected so a page mid-migration renders whole.
      const nodes = [...this.querySelectorAll(`:scope > [data-slot="${name}"], :scope > [slot="${name}"]`)];
      if (nodes.some((n) => n.hasAttribute('slot') && !n.dataset.slot)) {
        warnOnce(`app-card.slot=${name}`, `<app-card> child with slot="${name}" — use data-slot="${name}" (light DOM has no slot attribute).`);
      }
      this.#slots.set(name, nodes);
    }
    return this.#slots.get(name);
  }

  #chatHref() {
    if (this.hasAttribute('chat-href')) return this.getAttribute('chat-href');
    if (!this.#id()) return '';
    return `/chat?agent_id=${encodeURIComponent(this.#id())}`
      + `&agent_name=${encodeURIComponent(this.#name())}`;
  }

  /** @returns {string[]} */
  #tags() {
    const raw = this.getAttribute('tags');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Strings, or the { label } objects the replaced card took.
      return parsed
        .map((t) => (typeof t === 'string' ? t : t && typeof t.label === 'string' ? t.label : null))
        .filter((t) => t !== null);
    } catch {
      return [];
    }
  }

  render() {
    // Captured before any innerHTML write below can destroy them.
    const leadingNodes = this.#slotted('leading');
    const actionNodes = this.#slotted('actions');
    const bodyNodes = this.#slotted('body');
    const footerNodes = this.#slotted('footer');

    if (this.hasAttribute('loading')) {
      this.removeAttribute('role');
      this.removeAttribute('tabindex');
      this.removeAttribute('aria-label');
      this.setAttribute('aria-busy', 'true');
      this.innerHTML = `
        <div class="skel-line skel-line--name"></div>
        <div class="skel-tags">
          <div class="skel-tag"></div>
          <div class="skel-tag"></div>
        </div>
        <div class="skel-line skel-line--desc1"></div>
        <div class="skel-line skel-line--desc2"></div>`;
      return;
    }
    this.removeAttribute('aria-busy');

    // Nothing about this card was fetched, so there is no name, no status and
    // no href to honour — and a card that navigates somewhere on the strength
    // of data it never received is worse than one that does not.
    if (this.hasAttribute('error')) {
      this.removeAttribute('role');
      this.removeAttribute('tabindex');
      this.innerHTML = errorStateHtml(this.getAttribute('error') || "Couldn't load this card");
      return;
    }

    // A loaded card that navigates is a link target in its own right, matching
    // what agents-page put on the div it used to build. A card with no href
    // isn't one — it keeps whatever role the consumer set (or none).
    if (this.#cardHref() && !this.hasAttribute('role')) {
      this.setAttribute('role', 'link');
    }
    if (this.hasAttribute('role') && !this.hasAttribute('tabindex')) {
      this.setAttribute('tabindex', '0');
    }

    const name = this.#name();
    const status = this.getAttribute('status') || '';
    const description = this.getAttribute('description') || '';
    const rawVersion = this.getAttribute('version') || '';
    const version = rawVersion ? `v${String(rawVersion).replace(/^v/, '')}` : '';

    // Read presence first: Number(null) is 0, not NaN, so testing the parsed
    // value alone made an absent attribute mean "show no tags" and pushed every
    // chip into the "+N" overflow.
    const maxAttr = this.getAttribute('max-visible-tags');
    const max = maxAttr === null ? NaN : Number(maxAttr);
    const limit = Number.isInteger(max) && max >= 0 ? max : 2;
    const all = this.#tags();
    const shown = all.slice(0, limit);
    const extra = all.length - shown.length;
    // Display tags: no `selectable`/`removable`, so they carry no hover or
    // focus affordance — the card itself is the click target.
    const tags = shown.map((t) => `<app-tag size="sm">${escHtml(t)}</app-tag>`).join('')
      + (extra > 0 ? `<app-tag size="sm">+${extra}</app-tag>` : '');

    const detailsHref = this.#detailsHref();
    const chatHref = this.#chatHref();
    const isError = status === 'error' || status === 'failed';
    const isPending = status === 'deploying' || status === 'starting';
    const errorTitle = this.getAttribute('error-title') || '';
    const errorBody = this.getAttribute('error-body') || '';

    // Fallback only. A card whose href goes somewhere other than the agent's
    // details page (the orchestrator's suggestion cards navigate to chat) says
    // so itself, and clobbering that label announced the wrong destination.
    if (this.#cardHref() && !this.hasAttribute('aria-label')) {
      this.setAttribute('aria-label', `Open ${name} details`);
    }

    let body;
    // A slotted body wins over every attribute-driven state: the consumer has
    // supplied the whole middle of the card.
    if (bodyNodes.length) {
      body = '<div class="card-body"></div>';
    } else if (isError && (errorTitle || errorBody)) {
      body = `${errorTitle ? `<p class="card-state-title is-error">${escHtml(errorTitle)}</p>` : ''}
         <div class="card-desc">${escHtml(errorBody)}</div>`;
    } else if (isPending) {
      // Spinner + brand-info label + muted hint, per the setting-up styling that
      // your-agents-page.css has always carried. Deliberately NOT a progress bar:
      // a deploy has no honest percentage, and the spinner is what conveys
      // "working, for an unknown duration".
      const label = this.getAttribute('deploy-label') || 'Agent is being deployed...';
      const hint = this.getAttribute('deploy-hint')
        || 'This may take a few minutes. Status updates automatically.';
      body = `
        <div class="card-setup">
          <div class="card-setup-row" role="status">
            <span class="card-spinner" aria-hidden="true"></span>
            <span class="card-setup-label">${escHtml(label)}</span>
          </div>
          <p class="card-setup-hint">${escHtml(hint)}</p>
        </div>`;
    } else {
      body = `<div class="card-desc">${escHtml(description)}</div>`;
    }

    // A consumer-supplied footer wins over the default Details/Chat pair.
    // Both are <app-button>: the pair used to be two hand-rolled anchor classes
    // that re-implemented the tertiary and primary button, and drifted from it.
    const defaultFoot = `
      ${detailsHref ? `<app-button variant="tertiary" size="sm" href="${escAttr(detailsHref)}">Details</app-button>` : ''}
      ${chatHref ? `<app-button variant="primary" size="sm" href="${escAttr(chatHref)}">Chat ${icons.arrowUpRight()}</app-button>` : ''}`;

    this.innerHTML = `
      <div class="card-top">
        ${leadingNodes.length ? '<span class="card-leading"></span>' : ''}
        ${status ? `<span class="status-dot ${statusClass(status)}" title="${escAttr(status)}"></span>` : ''}
        <span class="card-name">${escHtml(name)}</span>
        ${version ? `<span class="card-version">${escHtml(version)}</span>` : ''}
        ${actionNodes.length ? '<div class="card-actions"></div>' : ''}
      </div>
      ${tags ? `<div class="card-tags">${tags}</div>` : ''}
      ${body}
      ${footerNodes.length || defaultFoot.trim()
        ? `<div class="card-foot">${footerNodes.length ? '' : defaultFoot}</div>`
        : ''}`;

    // Slotted nodes move into the freshly written markup. An empty footer would
    // still paint its hairline top border, so that row is omitted entirely when
    // there is neither a slotted action nor a default link.
    for (const [sel, nodes] of [['.card-leading', leadingNodes],
                                ['.card-actions', actionNodes],
                                ['.card-body', bodyNodes],
                                ['.card-foot', footerNodes]]) {
      const host = nodes.length ? this.querySelector(sel) : null;
      if (host) nodes.forEach((n) => host.appendChild(n));
    }
  }
}

customElements.define('app-card', AppCard);
