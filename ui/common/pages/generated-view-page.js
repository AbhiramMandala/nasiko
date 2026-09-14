/**
 * `<generated-view-page>` — a screen Weave built, at its own URL.
 *
 * Generation opens a route rather than replacing the current screen: the user
 * asked for this from somewhere, and that somewhere is still where they were.
 * The view is addressable (`/view?id=…`), so it can be linked, reloaded and
 * re-opened from the dock's artifact card long after the conversation moved on.
 *
 * A generated view is ephemeral until saved. **Save view** is the only thing
 * that promotes it into the sidebar and onto `/custom-views`; everything else
 * here is the frame around whatever was generated.
 *
 * The body is whatever Weave generated, rendered from the DSL stored on the
 * view. Not a second generation: `surface.show()` draws a finished spec with no
 * request, so reopening a view costs nothing and returns the same screen rather
 * than a new interpretation of the same prompt.
 *
 * A view with no `dsl` yet is still generating — the dock writes it when the
 * turn lands, and `VIEWS_CHANGED` is what tells this page to draw.
 *
 * @element generated-view-page
 */

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./generated-view-page.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

import { escHtml } from '/common/utils/escape.js';
import { icons } from '/common/utils/icons.js';
import { toast } from '/common/utils/toast.js';
import { navigate } from '/common/core/router.js';
import {
  ensureViews, getView, saveView, touchView, onViewsChange, viewsAvailable,
} from '/common/state/weave-views.js';
import '/common/features/weave-surface/weave-surface.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-menu/app-menu.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-alert/app-alert.js';

const COPY_ACTIONS = [
  { id: 'link', label: 'Copy link' },
  { id: 'json', label: 'Copy as JSON' },
  { id: 'image', label: 'Copy as image' },
];

class GeneratedViewPage extends HTMLElement {
  #initialized = false;
  #view = null;
  #offViewsChange = null;
  /** The DSL currently on screen, so a store change redraws only real changes. */
  #drawn = null;
  /** A save in flight, so a double-click cannot POST the same view twice. */
  #saving = false;
  /** Diagnostics already on screen, so a repaint does not stack duplicates. */
  #seenDiagnostics = new Set();

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    // Asking Weave for a second screen while looking at the first is `/view?id=A`
    // → `?id=B`: the same route pattern, which the router serves by updating the
    // mounted page instead of remounting it. Without this the second view would
    // never draw — the URL would change and the first dashboard would stay put.
    this.addEventListener('route-update', () => this.#load());
    // The dock generates after routing here, so the DSL arrives while this page
    // is already on screen. Without this the view would sit on its working
    // state until a reload.
    this.#offViewsChange = onViewsChange(() => this.#drawSurface());
    this.#load();
  }

  disconnectedCallback() {
    this.#offViewsChange?.();
    this.#offViewsChange = null;
  }

  /**
   * Resolve the id in the URL to a view, and draw whatever that turns out to be.
   *
   * The lookup has to wait for `ensureViews()` because a saved view lives on the
   * server: a link pasted into a fresh tab hits this page before any list call
   * has run, and answering from the empty cache would tell the user their view
   * is gone. A view the dock just created is local and resolves immediately —
   * so the common path pays nothing, since `ensureViews` has already settled by
   * the time anyone has generated anything.
   */
  async #load() {
    this.classList.remove('is-expanded');
    this.#drawn = null;
    const id = new URLSearchParams(location.search).get('id') || '';
    this.#view = getView(id);
    if (!this.#view) {
      await ensureViews();
      // Another `?id=` may have been routed to while that was in flight.
      if ((new URLSearchParams(location.search).get('id') || '') !== id) return;
      this.#view = getView(id);
    }
    if (!this.#view) {
      this.#renderMissing();
      return;
    }
    // A link made before this view was saved carries the id it had then; the
    // store follows the swap, and the URL is corrected to match so that the
    // next Copy link hands out one that will still resolve on its own.
    if (this.#view.id !== id) {
      history.replaceState(history.state, '', `/view?id=${encodeURIComponent(this.#view.id)}`);
    }
    touchView(this.#view.id);
    document.title = `Nasiko — ${this.#view.title}`;
    this.#render();
    this.#drawSurface();
  }

  #renderMissing() {
    // Unsaved views really are browser-local, so that half of the sentence is
    // still true — but a saved one could equally have been deleted from another
    // tab, and the page cannot tell which happened (a view that is not yours
    // answers 404 exactly like one that never existed, doc §2).
    this.innerHTML = `
      <app-empty-state heading="That view is gone"
        description="It may have been deleted, or it was never saved — unsaved views live only in the browser that made them. Ask Weave for it again, or open one from Custom views."
      ></app-empty-state>`;
  }

  #render() {
    this.innerHTML = `
      <header class="view-bar">
        <h1 class="title-page">${escHtml(this.#view.title)}</h1>
        <div class="view-bar__actions">
          <app-button id="save" variant="primary" size="sm"></app-button>
          <app-menu id="copy" label="Copy view" align="end"
            items='${JSON.stringify(COPY_ACTIONS)}'>
            <app-button variant="ghost" size="sm">Copy ${icons.chevronDownSmall('', 14, 1.25)}</app-button>
          </app-menu>
          <button class="icon-btn" id="expand" type="button" aria-label="Expand"
            >${icons.externalLink('', 16, 1.25)}</button>
          <button class="icon-btn" id="close" type="button" aria-label="Close view"
            >${icons.x('', 16, 1.25)}</button>
        </div>
      </header>

      <div class="diagnostics" id="diagnostics"></div>

      <div class="canvas" id="canvas">
        <div class="generating">
          <p class="generating__head">Generating your dashboard…</p>
          <p>Analyzing your request and assembling the best sequence of steps.</p>
          <ul class="generating__steps">
            <li>Understanding your goal</li>
            <li>Selecting relevant steps</li>
            <li>Structuring the workflow</li>
            <li>Defining triggers and outputs</li>
          </ul>
          <p>This usually takes a few seconds.</p>
        </div>
      </div>`;

    this.#syncSave();
    this.querySelector('#save').addEventListener('click', () => this.#save());
    this.querySelector('#close').addEventListener('click', () => this.#close());
    this.querySelector('#expand').addEventListener('click',
      () => this.classList.toggle('is-expanded'));
    this.querySelector('#copy').addEventListener('menu-select', (e) => {
      if (e.detail.id === 'link') navigator.clipboard?.writeText(location.href);
      toast.success('Copied');
    });
  }

  /**
   * Put the Save button in the state the view is actually in.
   *
   * Three states, not two. "Saved" is the obvious one; the third is a view
   * whose generation has not landed yet — saving that would send an empty
   * `catalog_version`, which the API rejects (doc §7.1), so the button waits
   * rather than offering something that cannot work. `#drawSurface` calls this
   * again when the DSL arrives, which is what re-enables it.
   *
   * On the OSS build there is nowhere to save to, so the button is not there.
   */
  #syncSave() {
    const button = this.querySelector('#save');
    if (!button) return;
    button.hidden = viewsAvailable() === false;
    // `label`, not `textContent` — app-button says so in as many words: assigning
    // textContent wipes the rendered `<button>` wrapper and leaves a bare text
    // node that keeps its box and loses every style.
    button.label = this.#view.saved ? 'Saved' : 'Save view';
    button.disabled = this.#view.saved || !this.#view.dsl || this.#saving;
  }

  /**
   * Keep this view.
   *
   * The first save gives it a server id, so the URL has to follow: `replace`
   * rather than `navigate`, because the id changed but the screen did not, and
   * a Back that returns to a `?id=` nothing resolves any more is a dead end.
   */
  async #save() {
    if (this.#saving) return;
    this.#saving = true;
    this.#syncSave();
    try {
      const row = await saveView(this.#view.id);
      if (!row) return;
      this.#view = row;
      history.replaceState(history.state, '', `/view?id=${encodeURIComponent(row.id)}`);
      // The rail caches its items per tab, so it has to be told. `nav-refresh`
      // is app-header's own hook — the alternative was reaching into its cache
      // from here, which is not this page's business.
      document.dispatchEvent(new CustomEvent('nav-refresh'));
      toast.success('Saved to Custom views');
    } catch (err) {
      // `message` on an ApiError is written to be shown to a user (doc §5), and
      // ViewNotReadyError says the one thing the user can act on.
      toast.error(err?.message || 'Could not save this view.');
    } finally {
      this.#saving = false;
      this.#syncSave();
    }
  }

  /** Back to wherever this was generated from; the app root if there is no history. */
  #close() {
    if (history.length > 1) history.back();
    else navigate('/');
  }

  /**
   * Show what the runtime could not do, instead of leaving a gap on the page.
   *
   * This is the difference between "the dashboard is wrong" and "the dashboard
   * says why it is wrong". A generated surface fails silently by construction:
   * a statement the model built but never placed produces a page that is simply
   * missing it, while the assistant's own closing sentence says it is there.
   * The runtime already detects that and calls it fatal — nothing was showing it.
   *
   * Fatal and runtime only. Fatal means the surface is not what was asked for;
   * runtime means something the surface needed did not arrive. Advisory is a
   * nudge aimed at the generator, not at the person reading the screen, and
   * putting it here would train everyone to ignore the strip.
   *
   * Keyed by code+message so a re-render of the same turn does not stack
   * duplicates, and cleared per draw because the state each one describes
   * belongs to the surface currently on screen.
   */
  #showDiagnostics(diagnostics) {
    const host = this.querySelector('#diagnostics');
    if (!host) return;
    for (const d of diagnostics ?? []) {
      if (d.severity !== 'fatal' && d.severity !== 'runtime') continue;
      const key = `${d.code}/${d.message}`;
      if (this.#seenDiagnostics.has(key)) continue;
      this.#seenDiagnostics.add(key);

      const alert = document.createElement('app-alert');
      alert.setAttribute('variant', d.severity === 'fatal' ? 'destructive' : 'warning');
      // `why` is written for a person; `message` names statements and dot-paths
      // and is written for whoever is debugging the generator. Lead with the
      // first and keep the second, because the person reporting this is often
      // the one who then has to fix it.
      alert.setAttribute('heading', d.why || 'This dashboard did not render as intended');
      alert.setAttribute('description', d.message || '');
      alert.setAttribute('dismissible', '');
      host.append(alert);
    }
  }

  /**
   * Draw the generated surface, or leave the working state up.
   *
   * Called on load and again on every store change, because the DSL usually
   * lands after this page is already on screen — the dock routes here the
   * instant the user presses send and the model answers seconds later.
   *
   * `show()` renders a finished spec with no request. Reopening a saved view
   * must not re-generate it: that would cost tokens, take seconds, and return
   * a different dashboard from the one the user saved.
   */
  async #drawSurface() {
    const canvas = this.querySelector('#canvas');
    if (!canvas) return;

    // Re-read: this fires on any store change, including one for another view.
    const id = new URLSearchParams(location.search).get('id') || '';
    const view = getView(id);
    if (!view || view.id !== this.#view?.id) return;
    this.#view = view;
    this.#syncSave(); // the DSL landing is what makes this view savable

    // The title can change after the initial render — Weave's real title
    // lands a moment after the fallback one this page was first drawn with
    // (`weave-dock.js`'s `#retitle`) — so the header and tab title have to
    // stay bound to the store here too, not just the canvas below.
    const heading = this.querySelector('.title-page');
    if (heading && heading.textContent !== view.title) {
      heading.textContent = view.title;
      document.title = `Nasiko — ${view.title}`;
    }

    if (!view.dsl) return; // still generating; the working state stays
    if (this.#drawn === view.dsl) return; // nothing new to draw

    canvas.classList.add('is-ready');
    let surface = canvas.querySelector('weave-surface');
    if (!surface) {
      canvas.replaceChildren();
      surface = document.createElement('weave-surface');
      // Bound before show(): the catalog-version check and the materializer's
      // own diagnostics both fire during the first draw, so a listener added
      // afterwards would miss the turn it is there to report on.
      surface.addEventListener('weave-diagnostics',
        (e) => this.#showDiagnostics(e.detail.diagnostics));
      canvas.append(surface);
    }
    // A new DSL is a new surface, so last draw's complaints no longer apply.
    this.querySelector('#diagnostics')?.replaceChildren();
    this.#seenDiagnostics.clear();
    // Marked before awaiting: show() is async (the element loads the catalog
    // once), and a second store change arriving mid-await would otherwise
    // start a duplicate draw of the same DSL.
    this.#drawn = view.dsl;
    await surface.show(view.dsl, { catalogVersion: view.catalogVersion });
  }
}

customElements.define('generated-view-page', GeneratedViewPage);
