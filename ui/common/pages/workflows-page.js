/**
 * Workflows library — reusable multi-agent sequences (MAF workflows).
 *
 * Data: GET /api/maf/workflows via window.fetchWorkflows; last-run status is
 * joined client-side from GET /api/maf/executions (the list API carries no
 * last-run info, only execution_count).
 *
 * @element workflows-page
 */
import { icons } from '/common/utils/icons.js';
import { showToast } from '/common/utils/toast.js';
import { confirmDialog } from '/common/design-system/app-modal/app-modal.js';
import { timeAgo, formatDisplay } from '/common/utils/date-utils.js';
import '/common/design-system/app-menu/app-menu.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-card/app-card.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
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

const MENU_ITEMS = JSON.stringify([
  { id: 'open', label: 'Open workflow' },
  { id: 'run', label: 'Run now' },
  { id: 'delete', label: 'Delete workflow' },
]);

class WorkflowsPage extends HTMLElement {
  #initialized = false;
  #workflows = [];
  #lastRun = new Map(); // maf_id → latest execution row

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.innerHTML = `
      <app-module-nav module="orchestrator"></app-module-nav>
      <header class="page-head">
        <div class="page-head-text">
          <h1 class="title-page">Workflows</h1>
          <p class="page-sub">Reusable multi-agent sequences you can run on demand.</p>
        </div>
        <app-button variant="primary" size="md" id="btn-new-wf" href="/workflow-new">Create workflow ${icons.plus()}</app-button>
      </header>
      <div class="grid" id="wf-grid">${this.#skeletonCards()}</div>
    `;

    // No delegated click handler: <app-card href> navigates itself, on click and
    // on Enter, and leaves the action menu's own button alone.
    this.querySelector('#wf-grid').addEventListener('menu-select', (e) => {
      const card = e.target.closest('app-card[data-id]');
      if (card) this.#onAction(e.detail.id, card.dataset.id);
    });

    this.#load();
  }

  async #load() {
    try {
      const [workflows, executions] = await Promise.all([
        call('fetchWorkflows'),
        call('fetchAllExecutions').catch(() => []),
      ]);
      this.#workflows = workflows;
      // Executions come newest-first; keep the first row seen per workflow.
      this.#lastRun = new Map();
      for (const exec of executions) {
        if (!this.#lastRun.has(exec.maf_id)) this.#lastRun.set(exec.maf_id, exec);
      }
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
      return { cls: 'is-idle', text: 'Not run yet' };
    }
    const when = timeAgo(last.completed_at || last.created_at);
    if (last.status === 'success') return { cls: 'is-success', text: `Last run succeeded ${when}` };
    if (last.status === 'failed') return { cls: 'is-failed', text: `Last run failed ${when}` };
    return { cls: 'is-running', text: 'Running now' };
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
        <app-menu data-slot="actions" align="end" trigger-label="Workflow actions" items='${MENU_ITEMS}'>
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
    // The empty state carries the same CTA, so the header one would be a duplicate.
    this.querySelector('#btn-new-wf')?.toggleAttribute('hidden', !this.#workflows.length);
    if (!this.#workflows.length) {
      grid.className = 'empty-wrap';
      grid.innerHTML = `
        <app-empty-state
          heading="No workflows yet"
          description="Chain agents into a repeatable sequence. Describe what you want to automate and Nasiko drafts the steps for you."
          icon='${icons.workflow('', 40)}'>
          <div class="empty-pills">
            <app-tag size="sm">${icons.editThin('', 12)} Describe</app-tag>
            ${icons.chevronRight('empty-arrow', 12)}
            <app-tag size="sm">${icons.checkCircle('', 12)} Review steps</app-tag>
            ${icons.chevronRight('empty-arrow', 12)}
            <app-tag size="sm">${icons.play('', 12)} Run</app-tag>
          </div>
          <app-button variant="primary" href="/workflow-new">Create workflow ${icons.plus()}</app-button>
        </app-empty-state>`;
      return;
    }
    grid.className = 'grid';
    grid.innerHTML = this.#workflows.map((wf) => this.#card(wf)).join('');
  }

  /** The card owns its own shimmer, so the loading grid is the same element as
   *  the loaded one and the two cannot drift apart. */
  #skeletonCards() {
    return '<app-card loading></app-card>'.repeat(3);
  }

}

customElements.define('workflows-page', WorkflowsPage);
