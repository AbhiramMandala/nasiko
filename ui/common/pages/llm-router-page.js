/**
import '/common/design-system/app-skeleton/app-skeleton.js';
 * LLM router — routing configs (per-reasoning-tier model presets) and the
 * provider/model catalog.
 *
 * @element llm-router-page
 * @note Data sources (see /api/docs):
 *       `call('fetchLlmConfigs')`      → GET  /api/llm-configs
 *       `call('createLlmConfig', body)`  → POST /api/llm-configs
 *       `call('deleteLlmConfig', id)`    → DELETE /api/llm-configs/{id}
 *       `call('setDefaultLlmConfig', id)`→ POST /api/llm-configs/{id}/default
 *       `call('fetchLlmProviders')`    → GET  /api/llm-router/providers
 *       `call('fetchSecretsList')`         → GET  /api/secrets
 */
import styles from './llm-router-page.css' with { type: 'css' };
import { icons } from '../utils/icons.js';
import { showToast } from '../utils/toast.js';
import { confirmDialog } from '../design-system/app-modal/app-modal.js';
import '/common/design-system/app-button/app-button.js';
import { escHtml } from '/common/utils/escape.js';
import { call } from '../core/data-sources.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const TIERS = [
  { key: 'tier1_model', label: 'Advanced reasoning', hint: 'For coding, planning, and complex analysis.' },
  { key: 'tier2_model', label: 'Balanced', hint: 'For most everyday requests.' },
  { key: 'tier3_model', label: 'Fast responses', hint: 'For quick, simple lookups and formatting.' },
];

const IC_STAR = (cls = '') =>
  `<svg class="${cls}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2.5 15 8.8 21.8 9.7 16.9 14.4 18.1 21.2 12 18 5.9 21.2 7.1 14.4 2.2 9.7 9 8.8 12 2.5"/></svg>`;

class LlmRouterPage extends HTMLElement {
  #initialized = false;
  #configs = [];
  #providers = [];
  #secrets = [];
  #view = 'list'; // 'list' | 'form'
  #editingConfig = null; // null = create, config object = edit

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.addEventListener('click', (e) => this.#onClick(e));
    this.addEventListener('change', (e) => this.#onChange(e));
    this.addEventListener('action-select', (e) => this.#onMenuAction(e));
    this.#load();
  }

  async #load() {
    this.innerHTML = `${this.#headHtml()}
      <div style="display:grid;gap:var(--s-16)" aria-busy="true">
        <app-skeleton height="72px" radius="md"></app-skeleton>
        <app-skeleton height="72px" radius="md"></app-skeleton>
        <app-skeleton height="72px" radius="md"></app-skeleton>
      </div>`;
    try {
      const [configs, providers, secrets] = await Promise.all([
        call('fetchLlmConfigs'),
        call('fetchLlmProviders'),
        call('fetchSecretsList'),
      ]);
      this.#configs = configs?.data ?? [];
      this.#providers = providers?.data ?? [];
      this.#secrets = Array.isArray(secrets) ? secrets : secrets?.data ?? [];
    } catch (e) {
      console.error('LLM router load failed:', e);
      this.innerHTML = `${this.#headHtml()}<p class="form-error">Failed to load router configuration</p>`;
      return;
    }
    this.#view = 'list';
    this.#render();
  }

  #render() {
    this.innerHTML = this.#view === 'form' ? this.#formHtml() : this.#listHtml();
  }

  /* ── List view ─────────────────────────────────────────────────────────── */

  #headHtml(withAction = false) {
    return `
      <header class="page-head">
        <div>
          <h1 class="title-page">LLM Router</h1>
          <p class="page-sub">Connect providers, map a model to each reasoning level, and choose the config your agents follow by default.</p>
        </div>
        ${withAction ? '<app-button variant="primary" data-action="new-config">Setup new config</app-button>' : ''}
      </header>
    `;
  }

  #listHtml() {
    return `
      ${this.#headHtml(this.#configs.length > 0)}
      ${this.#kpiHtml()}
      <div class="section-head">
        <h2 class="section-title">Your configs</h2>
        <p class="section-sub">Each config maps one model to every reasoning level. Agents follow the default unless they pin a model.</p>
      </div>
      ${this.#configs.length ? this.#configCardsHtml() : this.#emptyHtml()}
      <hr class="divider" />
      <div class="section-head">
        <h2 class="section-title">Available providers</h2>
        <p class="section-sub">Pick a provider to start a new config from its model catalog.</p>
      </div>
      <div class="provider-grid">
        ${this.#providers.map((p) => this.#providerCardHtml(p)).join('')}
      </div>
    `;
  }

  #kpiHtml() {
    const providersInUse = new Set(this.#configs.map((c) => c.provider).filter(Boolean)).size;
    const defaultCfg = this.#configs.find((c) => c.is_default);
    return `
      <div class="kpi-strip">
        <div class="kpi">
          <div class="kpi-label">Router configs</div>
          <div class="kpi-value is-mono">${this.#configs.length}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Providers connected</div>
          <div class="kpi-value is-mono">${providersInUse}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Default config</div>
          <div class="kpi-value is-mono">${defaultCfg ? escHtml(defaultCfg.name) : '—'}</div>
        </div>
      </div>
    `;
  }

  #emptyHtml() {
    return `
      <div class="empty-state">
        <div class="empty-tile">${icons.activity('', 20)}</div>
        <div class="empty-title">No configs yet</div>
        <p class="empty-sub">Connect a provider to start configuring.</p>
        <app-button variant="primary" data-action="new-config">Setup new config</app-button>
      </div>
    `;
  }

  #configCardsHtml() {
    return `
      <div class="config-list">
        ${this.#configs.map((c) => {
          const menuItems = [
            { id: `edit:${c.id}`, label: 'Edit' },
            ...(c.is_default
              ? [{ id: `clear-default:${c.id}`, label: 'Remove default' }]
              : [{ id: `set-default:${c.id}`, label: 'Set default' }]),
            { id: `delete:${c.id}`, label: 'Delete' },
          ];
          return `
          <div class="config-card" data-action="edit-config" data-id="${c.id}" role="button" tabindex="0">
            <div class="config-head">
              <div class="config-name">${escHtml(c.name)}</div>
              <div class="config-tools">
                <app-action-menu trigger-title="Config actions" items='${JSON.stringify(menuItems).replace(/'/g, '&#39;')}'>
                  ${icons.moreVertical?.('', 16) ?? `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`}
                </app-action-menu>
              </div>
            </div>
            <div class="config-meta">
              ${c.is_default
                ? '<span class="badge badge--brand"><span class="badge__dot"></span>Default</span>'
                : '<span class="badge badge--success"><span class="badge__dot"></span>Active</span>'}
              <span class="badge badge--muted">${escHtml(this.#cap(c.provider))}</span>
            </div>
            <div class="tier-rows">
              ${TIERS.map((t) => `
                <div class="tier-row">
                  <span class="tier-label">${t.label}</span>
                  <span class="tier-model">${escHtml(c[t.key] || c.model || '—')}</span>
                </div>`).join('')}
            </div>
            ${c.api_key_secret_name ? `
              <div class="secret-row">
                <span class="tier-label">Secret</span>
                <span class="secret-name">${escHtml(c.api_key_secret_name)}</span>
              </div>` : ''}
          </div>`;
        }).join('')}
      </div>
    `;
  }

  #providerCardHtml(p) {
    const count = p.models?.length ?? 0;
    return `
      <div class="provider-card" data-action="new-config" data-provider="${escHtml(p.provider)}"
        role="button" tabindex="0">
        <div class="provider-head">
          <span class="provider-glyph">${escHtml((p.provider || '?')[0])}</span>
          <span class="provider-name">${escHtml(p.provider)}</span>
          <span class="provider-add">${icons.plus('', 15)}</span>
        </div>
        <div class="provider-chips">
          <span class="badge badge--muted">Requires API key</span>
          <span class="badge badge--muted is-mono">${count} models</span>
        </div>
      </div>
    `;
  }

  /* ── Configure form view ───────────────────────────────────────────────── */

  #formHtml(provider = '') {
    const c = this.#editingConfig;
    const isEdit = !!c;
    const formProvider = c?.provider || provider;
    const formName = c?.name || '';
    const formSecret = c?.api_key_secret_name || '';
    const formDefault = c ? c.is_default : !this.#configs.length;
    return `
      <div class="form-head">
        <button class="back-btn" data-action="back" type="button" aria-label="Back">${icons.arrowLeft('', 16)}</button>
        <h1 class="title-page">${isEdit ? 'Edit config' : 'Configure router'}</h1>
      </div>
      <form class="config-form" id="config-form">
        <div class="field">
          <label for="cfg-name">Settings name</label>
          <input type="text" id="cfg-name" name="name" placeholder="Enter name" value="${escHtml(formName)}" required />
        </div>
        <div class="field">
          <label for="cfg-provider">Provider</label>
          <select id="cfg-provider" name="provider" required>
            <option value="" disabled ${formProvider ? '' : 'selected'}>Choose Provider</option>
            ${this.#providers.map((p) => `
              <option value="${escHtml(p.provider)}" ${p.provider === formProvider ? 'selected' : ''}>
                ${escHtml(this.#cap(p.provider))}
              </option>`).join('')}
          </select>
        </div>
        <div>
          <h3 class="group-title">Connect provider</h3>
          <p class="group-sub">${isEdit ? 'Update the provider secret or keep the current one.' : 'Connect provider by selecting an existing secret or adding a new one.'}</p>
          <div class="radio-row">
            <input type="radio" id="secret-saved" name="secret-mode" value="saved" checked />
            <label for="secret-saved">Use saved secret</label>
          </div>
          <div class="radio-row">
            <input type="radio" id="secret-new" name="secret-mode" value="new" />
            <label for="secret-new">Add new secret</label>
          </div>
          <div class="field" id="saved-secret-field">
            <label for="cfg-secret">Use saved secret</label>
            <select id="cfg-secret" name="api_key_secret_name">
              <option value="" disabled ${formSecret ? '' : 'selected'}>Find secrets</option>
              ${this.#secrets.map((s) => {
                const name = s.name ?? s.key ?? '';
                return `<option value="${escHtml(name)}" ${name === formSecret ? 'selected' : ''}>${escHtml(name)}</option>`;
              }).join('')}
            </select>
            <div class="hint">Select a secret already stored in your workspace.</div>
          </div>
          <div class="field" id="new-secret-field" hidden>
            <label for="cfg-secret-name">Secret name</label>
            <input type="text" id="cfg-secret-name" name="new_secret_name" placeholder="e.g. OPENAI_API_KEY" />
            <label for="cfg-secret-value" style="margin-top: var(--s-12)">Secret value</label>
            <input type="password" id="cfg-secret-value" name="secret_value" placeholder="Paste the API key" autocomplete="off" />
            <div class="hint">Stored encrypted; only used to call the provider.</div>
          </div>
        </div>
        <div id="tier-section" ${formProvider ? '' : 'hidden'}>
          <h3 class="group-title">Reasoning levels</h3>
          <p class="group-sub">Assign a model for each reasoning level. The router automatically selects the appropriate model based on the request.</p>
          ${TIERS.map((t) => {
            const tierVal = c?.[t.key] || '';
            return `
            <div class="field" style="margin-bottom: var(--s-16)">
              <label for="cfg-${t.key}">${t.label}</label>
              <select id="cfg-${t.key}" name="${t.key}" data-tier-select>
                <option value="" ${tierVal ? '' : 'selected'}>Choose model</option>
                ${this.#modelOptions(formProvider, tierVal)}
              </select>
              <div class="hint">${t.hint}</div>
            </div>`;
          }).join('')}
        </div>
        <div class="checkbox-row">
          <input type="checkbox" id="cfg-default" name="is_default" ${formDefault ? 'checked' : ''} />
          <label for="cfg-default">Make this the default routing config</label>
        </div>
        <div class="form-error" id="form-error" hidden></div>
        <div class="form-actions">
          <app-button variant="primary" type="submit">${isEdit ? 'Save changes' : 'Save config'}</app-button>
          <button class="link-btn" data-action="back" type="button">Cancel</button>
        </div>
      </form>
    `;
  }

  #modelOptions(provider, selected = '') {
    const entry = this.#providers.find((p) => p.provider === provider);
    return (entry?.models ?? [])
      .map((m) => `<option value="${escHtml(m.model)}" ${m.model === selected ? 'selected' : ''}>${escHtml(m.model)}</option>`)
      .join('');
  }

  /* ── Events ────────────────────────────────────────────────────────────── */

  #onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'new-config') {
      this.#editingConfig = null;
      this.#view = 'form';
      this.innerHTML = this.#formHtml(el.dataset.provider || '');
      this.querySelector('#config-form').addEventListener('submit', (ev) => this.#save(ev));
    } else if (action === 'edit-config') {
      const cfg = this.#configs.find((c) => c.id === el.dataset.id);
      if (!cfg) return;
      this.#editingConfig = cfg;
      this.#view = 'form';
      this.innerHTML = this.#formHtml();
      this.querySelector('#config-form').addEventListener('submit', (ev) => this.#save(ev));
    } else if (action === 'back') {
      this.#editingConfig = null;
      this.#view = 'list';
      this.#render();
    }
  }

  #onMenuAction(e) {
    const [action, id] = (e.detail?.id || '').split(':');
    if (!action || !id) return;
    if (action === 'edit') {
      const cfg = this.#configs.find((c) => c.id === id);
      if (!cfg) return;
      this.#editingConfig = cfg;
      this.#view = 'form';
      this.innerHTML = this.#formHtml();
      this.querySelector('#config-form').addEventListener('submit', (ev) => this.#save(ev));
    } else if (action === 'set-default') {
      this.#setDefault(id);
    } else if (action === 'clear-default') {
      this.#clearDefault(id);
    } else if (action === 'delete') {
      this.#deleteConfig(id);
    }
  }

  #onChange(e) {
    if (e.target.name === 'secret-mode') {
      const useNew = e.target.value === 'new';
      this.querySelector('#saved-secret-field').hidden = useNew;
      this.querySelector('#new-secret-field').hidden = !useNew;
    } else if (e.target.id === 'cfg-provider') {
      const provider = e.target.value;
      const tierSection = this.querySelector('#tier-section');
      if (tierSection) tierSection.hidden = !provider;
      const options = this.#modelOptions(provider);
      this.querySelectorAll('[data-tier-select]').forEach((sel) => {
        sel.innerHTML = `<option value="" selected>Choose model</option>${options}`;
      });
    }
  }

  async #save(e) {
    e.preventDefault();
    const form = e.target;
    const isEdit = !!this.#editingConfig;
    const useNew = form.querySelector('#secret-new').checked;
    const body = {
      name: form.querySelector('#cfg-name').value.trim(),
      provider: form.querySelector('#cfg-provider').value,
      tier1_model: form.querySelector('#cfg-tier1_model').value || null,
      tier2_model: form.querySelector('#cfg-tier2_model').value || null,
      tier3_model: form.querySelector('#cfg-tier3_model').value || null,
      api_key_secret_name: useNew
        ? form.querySelector('#cfg-secret-name').value.trim() || null
        : form.querySelector('#cfg-secret').value || null,
      secret_value: useNew ? form.querySelector('#cfg-secret-value').value || null : null,
    };
    if (!isEdit) {
      body.is_default = form.querySelector('#cfg-default').checked;
    }
    const errEl = this.querySelector('#form-error');
    if (!body.name) {
      errEl.textContent = 'Settings name is required.';
      errEl.hidden = false;
      return;
    }
    if (!body.provider) {
      errEl.textContent = 'Choose a provider.';
      errEl.hidden = false;
      return;
    }
    if (!body.tier1_model && !body.tier2_model && !body.tier3_model) {
      errEl.textContent = 'Choose a model for at least one reasoning level.';
      errEl.hidden = false;
      return;
    }
    try {
      await call('createLlmConfig', body);
    } catch (err) {
      errEl.textContent = err?.message || 'Failed to save config';
      errEl.hidden = false;
      return;
    }
    showToast(isEdit ? 'Changes saved' : 'Router config saved');
    this.#editingConfig = null;
    this.#load();
  }

  async #deleteConfig(id) {
    const confirmed = await confirmDialog({
      title: 'Delete routing config',
      message: 'This will permanently remove the routing configuration. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await call('deleteLlmConfig', id);
    } catch (err) {
      showToast(err?.message || 'Failed to delete config');
      return;
    }
    this.#load();
  }

  async #setDefault(id) {
    try {
      await call('setDefaultLlmConfig', id);
    } catch (err) {
      showToast(err?.message || 'Failed to set default');
      return;
    }
    this.#load();
  }

  /// The star is a toggle, not a one-way switch. Previously the default config's
  /// star was rendered `disabled`, so the flag could only ever be moved to
  /// another config — with one config there was no way to unset it at all.
  async #clearDefault(id) {
    try {
      await call('clearDefaultLlmConfig', id);
    } catch (err) {
      showToast(err?.message || 'Failed to remove default');
      return;
    }
    showToast('Default cleared — agents now fall back to the platform key');
    this.#load();
  }

  #cap(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
  }

}

customElements.define('llm-router-page', LlmRouterPage);
