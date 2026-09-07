/**
 * `<custom-views-page>` — the views the user chose to keep.
 *
 * Only saved views appear here. A generated view that was never saved stays
 * reachable at its URL and nowhere else, which is what keeps this list the
 * user's own shelf rather than a log of everything they ever asked for.
 *
 * The rail entry that leads here is created by the first save
 * (`ui/oss/navigation.js` reads `hasSavedViews()`), so an empty shelf is only
 * ever reached by URL — hence the empty state still says something useful.
 *
 * @element custom-views-page
 */

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./custom-views-page.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

import { escHtml, escAttr } from '/common/utils/escape.js';
import { timeAgo } from '/common/utils/date-utils.js';
import { listSavedViews, onViewsChange } from '/common/state/weave-views.js';
import '/common/design-system/app-select/app-select.js';
import '/common/design-system/app-empty-state/app-empty-state.js';

const SORTS = [
  { value: 'visits', label: 'Most visited' },
  { value: 'recent', label: 'Recently edited' },
];

class CustomViewsPage extends HTMLElement {
  #initialized = false;
  #sort = 'visits';
  #unsubscribe = null;

  connectedCallback() {
    if (!this.#initialized) {
      this.#initialized = true;
      this.innerHTML = `
        <div class="page-head">
          <h1 class="title-page">Custom views</h1>
          <app-select id="sort" size="md" aria-label="Sort views"
            options='${JSON.stringify(SORTS)}' value="visits"></app-select>
        </div>
        <div class="grid" id="grid"></div>`;

      this.querySelector('#sort').addEventListener('change', (e) => {
        this.#sort = e.target.value;
        this.#paint();
      });
      this.#paint();
    }
    // On every connect: a delete from another tab, or from a card here, has to
    // repaint the shelf. Teardown runs on every disconnect.
    this.#unsubscribe = onViewsChange(() => this.#paint());
  }

  disconnectedCallback() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #paint() {
    const grid = this.querySelector('#grid');
    const views = listSavedViews({ sort: this.#sort });
    if (!views.length) {
      grid.innerHTML = `
        <app-empty-state heading="No saved views yet"
          description="Ask Weave for a screen, then press Save view on it to keep it here."
        ></app-empty-state>`;
      return;
    }
    // ponytail: no per-card menu. Rename, duplicate and delete are all real
    // wants, and none of them was asked for — the shelf's job is to list and
    // open. `deleteView()` exists in the store for whichever one lands first.
    grid.innerHTML = views.map((v) => `
      <a class="view-card" href="/view?id=${escAttr(encodeURIComponent(v.id))}">
        <h2 class="view-card__title">${escHtml(v.title)}</h2>
        <p class="view-card__meta">Edited ${escHtml(timeAgo(Math.floor(v.updatedAt / 1000)))}</p>
      </a>`).join('');
  }
}

customElements.define('custom-views-page', CustomViewsPage);
