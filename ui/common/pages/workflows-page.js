/**
 * Workflow library — one component, two routes:
 *   <workflows-page>        /workflows        Deployed (the section's landing page)
 *   <workflow-drafts-page>  /workflow-drafts  Drafts
 *
 * Data: GET /api/maf/workflows via window.fetchWorkflows; last-run status is
 * joined client-side from GET /api/maf/executions (the list API carries no
 * last-run info, only execution_count).
 *
 * @element workflows-page
 * @element workflow-drafts-page
 */
import { icons } from '/common/utils/icons.js';
import { showToast } from '/common/utils/toast.js';
import { confirmDialog } from '/common/design-system/app-modal/app-modal.js';
import { timeAgo, formatDisplay } from '/common/utils/date-utils.js';
import '/common/design-system/app-menu/app-menu.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-card/app-card.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-search/app-search.js';
import '/common/design-system/app-select/app-select.js';
import '/common/design-system/app-tag/app-tag.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./workflows-page.css', import.meta.url));
import { escAttr, escHtml } from '/common/utils/escape.js';
import { call } from '../core/data-sources.js';
import { navigate as routerNavigate } from '../core/router.js';
// The page mounts an <app-module-nav>, and page-layout.css reserves the desktop
// gutter it pins into. Nothing imported it, so under the client router the
// gutter was reserved and the nav never upgraded.
import '/common/features/app-module-nav.js';


document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

// A draft has never run, so "Run now" would be a control with nothing behind it.
const MENU_DEPLOYED = JSON.stringify([
  { id: 'open', label: 'Open workflow' },
  { id: 'run', label: 'Run now' },
  { id: 'delete', label: 'Delete workflow' },
]);
const MENU_DRAFT = JSON.stringify([
  { id: 'open', label: 'Open workflow' },
  { id: 'delete', label: 'Delete workflow' },
]);

// ponytail: the deployed/draft flag lands with the backend branch (`mafs` has
// only active/deleted today). Until it does, every saved workflow reads as
// deployed and Drafts shows its empty screen.
const isDeployed = (wf) => wf.deployed ?? true;

/** Per-mode copy and artwork — the only thing the two routes disagree on. */
const MODES = {
  deployed: {
    title: 'Deployed workflows',
    searchLabel: 'Search deployed workflows',
    menu: MENU_DEPLOYED,
    art: '/common/images/deployed_empty.svg',
    heading: 'Deploy your first workflow',
    description: 'Turn a tested workflow into a reusable pipeline that you can run whenever you need it.',
    secondary: { label: 'View drafts', href: '/workflow-drafts' },
  },
  drafts: {
    title: 'Draft workflows',
    searchLabel: 'Search draft workflows',
    menu: MENU_DRAFT,
    art: '/common/images/drafts_empty.svg',
    heading: 'No workflows saved yet',
    description: 'Create a multi-agent workflow, test how the steps work together, and refine it before deploying.',
    secondary: { label: 'View deployed', href: '/workflows' },
  },
};

const FILTERS = JSON.stringify([
  { value: 'all', label: 'All' },
  { value: 'success', label: 'Last run succeeded' },
  { value: 'failed', label: 'Last run failed' },
  { value: 'idle', label: 'Never run' },
]);

class WorkflowsPage extends HTMLElement {
  /** Overridden by the drafts element below; `deployed` for /workflows. */
  mode = 'deployed';
  #initialized = false;
  #workflows = [];
  #lastRun = new Map(); // maf_id → latest execution row
  #query = '';
  #filter = 'all';

  get #copy() { return MODES[this.mode]; }

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    const copy = this.#copy;

    this.innerHTML = `
      <app-module-nav module="orchestrator"></app-module-nav>
      <h1 class="title-page page-title">${escHtml(copy.title)}</h1>
      <div class="toolbar">
        <app-search id="wf-search" size="sm" class="wf-search"
          placeholder="Search" aria-label="${escAttr(copy.searchLabel)}"></app-search>
        <app-select id="wf-filter" size="sm" fit-content aria-label="Filter workflows"
          options='${FILTERS}' value="all"></app-select>
        <app-button class="toolbar-cta" variant="primary" size="md" href="/workflow-new">${icons.plus()} Create workflow</app-button>
      </div>
      <div class="grid" id="wf-grid">${this.#skeletonCards()}</div>
    `;

    // No delegated click handler: <app-card href> navigates itself, on click and
    // on Enter, and leaves the action menu's own button alone.
    this.querySelector('#wf-grid').addEventListener('menu-select', (e) => {
      const card = e.target.closest('app-card[data-id]');
      if (card) this.#onAction(e.detail.id, card.dataset.id);
    });
    // `input` covers typing and <app-search>'s own clear button, which re-fires it.
    this.querySelector('#wf-search').addEventListener('input', (e) => {
      this.#query = e.target.value.trim().toLowerCase();
      this.#renderGrid();
    });
    this.querySelector('#wf-filter').addEventListener('change', (e) => {
      this.#filter = e.target.value;
      this.#renderGrid();
    });

    this.#load();
  }

  async #load() {
    try {
      const [workflows, executions] = await Promise.all([
        call('fetchWorkflows'),
        call('fetchAllExecutions').catch(() => []),
      ]);
      // Executions come newest-first; keep the first row seen per workflow.
      this.#lastRun = new Map();
      for (const exec of executions) {
        if (!this.#lastRun.has(exec.maf_id)) this.#lastRun.set(exec.maf_id, exec);
      }
      this.#workflows = workflows.filter((wf) =>
        this.mode === 'drafts' ? !isDeployed(wf) : isDeployed(wf));
      this.#renderGrid();
    } catch (err) {
      // Was a bare line of text where the grid should be — the page's tabs and
      // layout survived, but nothing said this was retryable or looked like
      // anything else in the product. The raw message moves into the
      // description so the detail is not lost.
      const grid = this.querySelector('#wf-grid');
      grid.className = 'empty-wrap';
      grid.innerHTML = `
        <app-empty-state variant="error"
          heading="Couldn't load workflows"
          description="${escAttr(err?.message || 'The request failed.')}">
          <app-button id="wf-retry" variant="tertiary">Retry</app-button>
        </app-empty-state>`;
      grid.querySelector('#wf-retry')?.addEventListener('click', () => this.#load());
    }
  }

  /** Name/description search plus the last-run filter, both client-side —
   *  the list endpoint has no query parameters for either. */
  #visible() {
    return this.#workflows.filter((wf) => {
      if (this.#filter !== 'all' && this.#statusLine(wf).key !== this.#filter) return false;
      if (!this.#query) return true;
      const haystack = `${wf.name} ${wf.description || wf.maf_json?.description || ''}`.toLowerCase();
      return haystack.includes(this.#query);
    });
  }

  async #onAction(action, id) {
    if (action === 'open') {
      routerNavigate(`/workflow?id=${encodeURIComponent(id)}`);
    } else if (action === 'run') {
      try {
        const run = await call('runWorkflow', id);
        routerNavigate(`/workflow?id=${encodeURIComponent(id)}&exec=${encodeURIComponent(run.execution_id)}`);
      } catch (err) {
        showToast(`Run failed: ${err.message}`);
      }
    } else if (action === 'delete') {
      const wf = this.#workflows.find((w) => w.id === id);
      const confirmed = await confirmDialog({
        title: `Delete ${wf?.name || 'workflow'}`,
        message: 'Its execution history goes with it. This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await call('deleteWorkflow', id);
        this.#workflows = this.#workflows.filter((w) => w.id !== id);
        this.#renderGrid();
        showToast('Workflow deleted');
      } catch (err) {
        showToast(`Delete failed: ${err.message}`);
      }
    }
  }

  #statusLine(wf) {
    const last = this.#lastRun.get(wf.id);
    if (!last || wf.execution_count === 0) {
      return { key: 'idle', cls: 'is-idle', text: 'Not run yet' };
    }
    const when = timeAgo(last.completed_at || last.created_at);
    if (last.status === 'success') return { key: 'success', cls: 'is-success', text: `Last run succeeded ${when}` };
    if (last.status === 'failed') return { key: 'failed', cls: 'is-failed', text: `Last run failed ${when}` };
    return { key: 'running', cls: 'is-running', text: 'Running now' };
  }

  /** A workflow is an entity, so it gets the one card component. The meta pills
   *  are the card's `tags` (<app-tag> chips), the description its two-line clamp;
   *  the footer keeps what the card has no notion of — which agents the sequence
   *  runs and how the last run went. */
  #card(wf) {
    const steps = wf.maf_json?.steps || [];
    const agents = [...new Set(steps.map((s) => s.agent_name).filter(Boolean))];
    const description = wf.description || wf.maf_json?.description || '';
    const status = this.#statusLine(wf);
    const tags = [
      steps.length === 1 ? '1 step' : `${steps.length} steps`,
      wf.execution_count === 1 ? '1 run' : `${wf.execution_count} runs`,
    ];
    if (wf.created_at) tags.push(`Created ${formatDisplay(new Date(wf.created_at))}`);
    return `
      <app-card
        data-id="${escAttr(wf.id)}"
        name="${escAttr(wf.name)}"
        ${description ? `description="${escAttr(description)}"` : ''}
        tags="${escAttr(JSON.stringify(tags))}"
        max-visible-tags="3"
        href="/workflow?id=${encodeURIComponent(wf.id)}"
        aria-label="Open ${escAttr(wf.name)}">
        <app-menu data-slot="actions" align="end" trigger-label="Workflow actions" items='${this.#copy.menu}'>
          ${icons.moreVertical('', 16)}
        </app-menu>
        ${agents.length ? `<span data-slot="footer" class="wf-agents">${escHtml(agents.join(' · '))}</span>` : ''}
        <span data-slot="footer" class="wf-status ${status.cls}">
          <span class="wf-dot"></span>
          <span class="wf-status-text">${escHtml(status.text)}</span>
        </span>
      </app-card>`;
  }

  #renderGrid() {
    const grid = this.querySelector('#wf-grid');
    const rows = this.#visible();
    // Nothing to search or filter: the controls go inert rather than away, so
    // the toolbar does not appear and disappear as the first workflow lands.
    // Only when the list itself is empty — on a no-match the query is the way
    // out, and disabling the box would strand the user in it.
    const inert = !this.#workflows.length;
    this.querySelector('#wf-search').toggleAttribute('disabled', inert);
    this.querySelector('#wf-filter').toggleAttribute('disabled', inert);
    if (!rows.length) {
      grid.className = 'wf-empty';
      grid.innerHTML = this.#workflows.length ? this.#noMatchHtml() : this.#emptyHtml();
      return;
    }
    grid.className = 'grid';
    grid.innerHTML = rows.map((wf) => this.#card(wf)).join('');
  }

  #emptyHtml() {
    const copy = this.#copy;
    return `
      <app-empty-state plain heading="${escAttr(copy.heading)}"
        description="${escAttr(copy.description)}">
        <img data-slot="icon" class="wf-art" src="${escAttr(copy.art)}" alt="" width="286" height="164" />
        <app-button size="md" variant="tertiary" href="${escAttr(copy.secondary.href)}">${escHtml(copy.secondary.label)}</app-button>
        <app-button size="md" variant="secondary" href="/workflow-new">Create workflow</app-button>
      </app-empty-state>`;
  }

  #noMatchHtml() {
    return `
      <app-empty-state heading="No workflows match"
        description="Try a different search term or clear the filter."
        icon='${icons.search('', 40)}'></app-empty-state>`;
  }

  /** The card owns its own shimmer, so the loading grid is the same element as
   *  the loaded one and the two cannot drift apart. */
  #skeletonCards() {
    return '<app-card loading></app-card>'.repeat(3);
  }

}

customElements.define('workflows-page', WorkflowsPage);

/** /workflow-drafts — same list, same controls, draft copy. */
class WorkflowDraftsPage extends WorkflowsPage {
  mode = 'drafts';
}
customElements.define('workflow-drafts-page', WorkflowDraftsPage);
