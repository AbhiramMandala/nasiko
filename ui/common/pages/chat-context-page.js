import { showToast } from '/common/utils/toast.js';
import { withLoading } from '/common/utils/async-button.js';
import { call } from '../core/data-sources.js';
import '/common/features/app-module-nav.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-select/app-select.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./chat-context-page.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

// Per-user preferences behind GET/PATCH /api/me/context-strategy and
// /api/me/pacms-budget (oss/server/src/context_selection.rs) — every
// authenticated user owns their own, so unlike settings-page this page
// carries no admin gate. A sibling route to /secrets, not a panel of
// /settings, for the same reason: docs/PACMS_CONTROL_FLOW.md.
const STRATEGY_OPTIONS = [
  { value: 'pacms', label: 'PACMS (budget-aware, recommended)' },
  { value: 'topk', label: 'Top-K (relevance ranked)' },
  { value: 'lastk', label: 'Last-K (most recent)' },
];

const BUDGET_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

class ChatContextPage extends HTMLElement {
  #initialized = false;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.innerHTML = `
      <app-module-nav module="settings"></app-module-nav>
      <header class="page-head">
        <h1 class="title-page">Chat context</h1>
        <p class="page-sub">How much of your conversation history is carried into each request, and which algorithm picks it. Applies to every chat you send, across all agents.</p>
      </header>
      <div class="setting-row">
        <div class="setting-info">
          <label for="cc-strategy">Context strategy</label>
          <div class="hint">Which algorithm selects prior messages to carry into a new request.</div>
        </div>
        <div class="setting-control">
          <app-select id="cc-strategy" aria-label="Context strategy">
            ${STRATEGY_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
          </app-select>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-info">
          <label for="cc-budget">History budget</label>
          <div class="hint">How much history the strategy may keep — a token budget under PACMS, an item count under Top-K/Last-K.</div>
        </div>
        <div class="setting-control">
          <app-select id="cc-budget" aria-label="History budget">
            ${BUDGET_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
          </app-select>
        </div>
      </div>
      <div class="save-bar">
        <app-button size="md" id="btn-save">Save changes</app-button>
      </div>
    `;

    this.querySelector('#btn-save').addEventListener('click', () => this.#save());
    this.#load();
  }

  async #load() {
    let strategyRes, budgetRes;
    try {
      [strategyRes, budgetRes] = await Promise.all([
        call('fetchContextStrategy'),
        call('fetchPacmsBudget'),
      ]);
    } catch (e) {
      console.error('ChatContextPage: failed to load preferences:', e);
      showToast('Failed to load chat context settings. Please refresh and try again.');
      return;
    }
    if (strategyRes?.strategy) this.querySelector('#cc-strategy').value = strategyRes.strategy;
    if (budgetRes?.level) this.querySelector('#cc-budget').value = budgetRes.level;
  }

  #save() {
    const btn = this.querySelector('#btn-save');
    withLoading(btn, 'Saving…', async () => {
      const strategy = this.querySelector('#cc-strategy').value;
      const level = this.querySelector('#cc-budget').value;
      try {
        await Promise.all([
          call('saveContextStrategy', strategy),
          call('savePacmsBudget', level),
        ]);
        showToast('Chat context settings saved');
      } catch (err) {
        showToast(err.message || 'Failed to save chat context settings');
      }
    })();
  }
}

customElements.define('chat-context-page', ChatContextPage);
