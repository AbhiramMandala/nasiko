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
 * The list is the server's (`/api/weave/views`), not this browser's, so it is
 * fetched on every connect rather than read once: this is the page whose whole
 * job is to be current, and returning to it after saving something elsewhere
 * should show that something. Rename and delete go straight back to the same
 * API; nothing is mutated locally that the server has not already agreed to.
 *
 * @element custom-views-page
 */

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./custom-views-page.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

import { escAttr } from '/common/utils/escape.js';
import { timeAgo } from '/common/utils/date-utils.js';
import { toast } from '/common/utils/toast.js';
import {
  deleteView, ensureViews, listSavedViews, onViewsChange, refreshViews,
  renameView, viewsAvailable,
} from '/common/state/weave-views.js';
import { confirmDialog } from '/common/design-system/app-modal/app-modal.js';
import '/common/design-system/app-select/app-select.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-menu/app-menu.js';
import '/common/design-system/app-input/app-input.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-card/app-card.js';

/**
 * Both orders run on the server's own timestamps, so they mean the same thing
 * on every machine the user signs in from. (The "Most visited" sort that used
 * to head this list did not: it counted opens in one browser's localStorage,
 * which the API has nowhere to store and a second device could never agree
 * with.) `value` must be a key of the store's `SORTS`.
 */
const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'recent', label: 'Recently edited' },
];

const DEFAULT_SORT = 'newest';

/**
 * The two things a shelf is for besides opening: fixing a name the generator
 * guessed, and throwing something out. Duplicate is not here — the API has no
 * copy and doing it client-side would POST a second row the user did not ask
 * for, which is a different feature wearing a menu item's clothes.
 */
const CARD_ACTIONS = [
  { id: 'rename', label: 'Rename', icon: 'edit' },
  { id: 'delete', label: 'Delete', icon: 'trash', destructive: true },
];

class CustomViewsPage extends HTMLElement {
  #initialized = false;
  #sort = DEFAULT_SORT;
  #unsubscribe = null;
  /** False until a list call has answered, so "empty" and "not asked yet" differ. */
  #loaded = false;

  connectedCallback() {
    if (!this.#initialized) {
      this.#initialized = true;
      this.innerHTML = `
        <div class="page-head">
          <h1 class="title-page">Custom views</h1>
          <app-select id="sort" size="md" aria-label="Sort views"
            options='${JSON.stringify(SORT_OPTIONS)}' value="${DEFAULT_SORT}"></app-select>
        </div>
        <div class="grid" id="grid"></div>`;

      this.querySelector('#sort').addEventListener('change', (e) => {
        this.#sort = e.target.value;
        this.#paint();
      });
      // Delegated: `#paint` replaces the whole grid on every store change, so a
      // listener per card would be re-bound on every repaint and leaked on the
      // repaint after that.
      this.querySelector('#grid').addEventListener('menu-select', (e) => {
        const id = e.target.closest('.view-card')?.dataset.id;
        if (id) this.#act(e.detail.id, id);
      });
      this.#paint();
    }
    // On every connect: a delete from another tab, or from a card here, has to
    // repaint the shelf. Teardown runs on every disconnect.
    this.#unsubscribe = onViewsChange(() => this.#paint());
    // And on every connect, re-ask the server. This is the page whose whole job
    // is to be the current list, and it is reached by navigation — coming back
    // to it after saving something in another tab should show that something.
    // `ensureViews` covers the very first visit; after that this is a refetch.
    (this.#loaded ? refreshViews() : ensureViews()).catch(() => {}).then(() => {
      this.#loaded = true;
      this.#paint();
    });
  }

  disconnectedCallback() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /**
   * Run a card's menu action.
   *
   * Both arms let the store do the talking: it knows whether this view lives on
   * the server, and both `renameView` and `deleteView` refuse to drop the card
   * locally unless the server agreed. So the only thing left here is to ask, and
   * to say what happened.
   */
  async #act(action, id) {
    const view = listSavedViews().find((v) => v.id === id);
    if (!view) return;

    if (action === 'rename') {
      const next = await promptForTitle(view.title);
      if (next === null || next === view.title) return;
      try {
        await renameView(id, next);
        // The rail shows saved views by name, so it is stale the moment this
        // lands. `nav-refresh` is app-header's hook for exactly that.
        document.dispatchEvent(new CustomEvent('nav-refresh'));
      } catch (err) {
        toast.error(err?.message || 'Could not rename this view.');
      }
      return;
    }

    if (action !== 'delete') return;
    const ok = await confirmDialog({
      title: `Delete "${view.title}"?`,
      message: 'The dashboard and the prompt behind it go with it. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteView(id);
      document.dispatchEvent(new CustomEvent('nav-refresh'));
      toast.success('View deleted');
    } catch (err) {
      toast.error(err?.message || 'Could not delete this view.');
    }
  }

  #paint() {
    const grid = this.querySelector('#grid');
    const views = listSavedViews({ sort: this.#sort });
    if (!views.length) {
      // Three different nothings, and saying the wrong one is worse than saying
      // nothing: a list still loading is not an empty shelf, and an OSS build
      // has no shelf at all — telling that user to press Save view would be
      // pointing at a button they will never see.
      if (!this.#loaded) {
        grid.innerHTML = '<app-empty-state heading="Loading your views…"></app-empty-state>';
      } else if (viewsAvailable() === false) {
        grid.innerHTML = `
          <app-empty-state heading="Saved views aren't available on this deployment"
            description="Weave can still build screens on request; keeping them needs the enterprise build."
          ></app-empty-state>`;
      } else {
        grid.innerHTML = `
          <app-empty-state heading="No saved views yet"
            description="Ask Weave for a screen, then press Save view on it to keep it here."
          ></app-empty-state>`;
      }
      return;
    }
    grid.innerHTML = views.map((v) => cardHtml(v)).join('');
  }
}

/**
 * One card — the same tile the orchestrator's agent suggestions use.
 *
 * `<app-card>` with a name and a one-line description, which is all those are
 * (`orchestrator-page.js#L282`). A view had a composition summary and
 * data-source chips here, both read off the DSL; they went because a shelf of
 * tiles is scanned, not read, and the title is what the user is scanning for.
 * `view-summary.js` went with them.
 *
 * No corner arrow: the whole card is the link (`href`), so the glyph restated
 * what the cursor and the hover lift already say. The actions slot carries the
 * menu alone, revealed on hover.
 */
function cardHtml(v) {
  return `
    <app-card class="view-card" data-id="${escAttr(v.id)}"
      name="${escAttr(v.title)}"
      description="Edited ${escAttr(timeAgo(Math.floor(v.updatedAt / 1000)))}"
      tags='${escAttr(JSON.stringify(v.ownerName ? [`Owner: ${v.ownerName}`] : []))}'
      href="/view?id=${escAttr(encodeURIComponent(v.id))}"
      aria-label="Open ${escAttr(v.title)}">
      <app-menu data-slot="actions" class="view-card__menu" align="end"
        label="Actions for ${escAttr(v.title)}" trigger-label="View actions"
        items='${escAttr(JSON.stringify(CARD_ACTIONS))}'></app-menu>
    </app-card>`;
}

/**
 * Ask for a new title, resolving to the string or to `null` if the user backed out.
 *
 * `confirmDialog` is the yes/no form of the same component and there is no
 * text-entry form, so this is one — deliberately alongside it rather than
 * inside app-modal, because one caller is not yet a pattern. If a second page
 * needs to ask for a string, that is the moment to move it.
 */
function promptForTitle(current) {
  return new Promise((resolve) => {
    const modal = document.createElement('app-modal');
    modal.setAttribute('heading', 'Rename view');
    modal.innerHTML = `
      <app-input id="title" label="Name" value="${escAttr(current)}" maxlength="120"></app-input>
      <div data-slot="footer" style="display:contents">
        <app-button variant="tertiary" size="md" data-role="cancel">Cancel</app-button>
        <app-button variant="primary" size="md" data-role="save">Save</app-button>
      </div>`;
    document.body.append(modal);

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      modal.close();
      modal.remove();
      resolve(result);
    };
    const commit = () => {
      const next = String(modal.querySelector('#title').value ?? '').trim();
      // An empty box is a mistake, not an instruction — the store would throw
      // and the modal would already be gone, so hold it open instead.
      if (next) finish(next);
    };

    modal.querySelector('[data-role="cancel"]').addEventListener('click', () => finish(null));
    modal.querySelector('[data-role="save"]').addEventListener('click', commit);
    // Enter in the field is what most people will press, and a rename dialog
    // that ignores it feels broken.
    modal.querySelector('#title').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
    });
    modal.querySelector('dialog')?.addEventListener('close', () => finish(null));

    modal.open();
    // Selected, not just focused: the box arrives holding the current name, and
    // renaming almost always means replacing it rather than editing it.
    modal.querySelector('#title')?.input?.select();
  });
}

customElements.define('custom-views-page', CustomViewsPage);
