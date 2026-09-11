/**
import '/common/design-system/app-skeleton/app-skeleton.js';
 * LLM router — routing configs (per-reasoning-tier model presets) and the
 * provider/model catalog.
 *
 * @element llm-router-page
 * @note Data sources (see /api/docs):
 *       `call('fetchLlmConfigs')`      → GET  /api/llm-configs
 *       `call('createLlmConfig', body)`  → POST /api/llm-configs
 *       `call('updateLlmConfig', id, body)` → PATCH /api/llm-configs/{id}
 *       `call('deleteLlmConfig', id)`    → DELETE /api/llm-configs/{id}
 *       `call('setDefaultLlmConfig', id)`→ POST /api/llm-configs/{id}/default
 *       `call('fetchLlmProviders')`    → GET  /api/llm-router/providers
 *       `call('fetchSecretsList')`         → GET  /api/secrets
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./llm-router-page.css', import.meta.url));
import { icons } from '../utils/icons.js';
import { showToast } from '../utils/toast.js';
import { confirmDialog } from '../design-system/app-modal/app-modal.js';
import '/common/design-system/app-menu/app-menu.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-card/app-card.js';
import '/common/design-system/app-checkbox/app-checkbox.js';
import '/common/design-system/app-input/app-input.js';
import '/common/design-system/app-radio/app-radio.js';
import '/common/design-system/app-select/app-select.js';
import '/common/design-system/app-stat-row/app-stat-row.js';
import { escAttr, escHtml } from '/common/utils/escape.js';
import { call } from '../core/data-sources.js';
import { setFieldError, clearFieldErrors } from '../utils/field-error.js';

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
  #customProviders = [];
  #view = 'list'; // 'list' | 'form' | 'custom-form'
  #editingConfig = null; // null = create, config object = edit
  #editingCustom = null; // null = create, provider object = edit

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.addEventListener('click', (e) => this.#onClick(e));
    this.addEventListener('change', (e) => this.#onChange(e));
    this.addEventListener('menu-select', (e) => this.#onMenuAction(e));
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
      const [configs, providers, secrets, custom] = await Promise.all([
        call('fetchLlmConfigs'),
        call('fetchLlmProviders'),
        call('fetchSecretsList'),
        // Custom providers are a bonus panel — a failure here (e.g. a transient
        // error) shouldn't blank the whole page, so swallow it to an empty list.
        call('fetchCustomProviders').catch(() => ({ data: [] })),
      ]);
      this.#configs = configs?.data ?? [];
      this.#providers = providers?.data ?? [];
      this.#secrets = Array.isArray(secrets) ? secrets : secrets?.data ?? [];
      this.#customProviders = custom?.data ?? [];
    } catch (e) {
      console.error('LLM router load failed:', e);
      this.innerHTML = `${this.#headHtml()}<p class="form-error">Failed to load router configuration</p>`;
      return;
    }
    this.#view = 'list';
    this.#render();
  }

  #render() {
    if (this.#view === 'form') {
      this.innerHTML = this.#formHtml();
    } else if (this.#view === 'custom-form') {
      this.innerHTML = this.#customFormHtml();
      this.querySelector('#custom-form')?.addEventListener('submit', (ev) => this.#saveCustom(ev));
    } else {
      this.innerHTML = this.#listHtml();
    }
  }

  /* ── List view ─────────────────────────────────────────────────────────── */

  #headHtml(withAction = false) {
    return `
      <header class="page-head">
        <div>
          <h1 class="title-page">LLM router</h1>
          <p class="page-sub">Connect providers, map a model to each reasoning level, and choose the config your agents follow by default.</p>
        </div>
        ${withAction ? '<app-button variant="primary" size="md" data-action="new-config">Setup new config</app-button>' : ''}
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
      ${this.#customSectionHtml()}
    `;
  }

  /* ── Custom providers (admin) ──────────────────────────────────────────── */

  #customSectionHtml() {
    return `
      <hr class="divider" />
      <div class="section-head">
        <h2 class="section-title">Custom providers</h2>
        <p class="section-sub">Register any OpenAI-compatible endpoint (LiteLLM, vLLM, Ollama, an internal gateway). Its models appear above for tier routing.</p>
        <app-button variant="secondary" size="md" data-action="new-custom-provider">Add custom provider</app-button>
      </div>
      ${this.#customProviders.length
        ? `<div class="config-list">${this.#customProviders.map((p) => this.#customCardHtml(p)).join('')}</div>`
        : '<p class="section-sub">No custom providers yet.</p>'}
    `;
  }

  #customCardHtml(p) {
    const menuItems = [
      { id: `custom-edit:${p.id}`, label: 'Edit' },
      { id: `custom-sync:${p.id}`, label: 'Sync models now' },
      { id: `custom-delete:${p.id}`, label: 'Delete' },
    ];
    const status = p.last_sync_status || 'pending';
    const statusClass = status === 'ok' ? 'badge--success'
      : status === 'unsupported' ? 'badge--muted' : 'badge--warning';
    const when = p.last_sync_at ? new Date(p.last_sync_at).toLocaleString() : 'never';
    return `
      <app-card card-title="${escAttr(p.display_name || p.label)}">
        <app-menu data-slot="actions" align="end" trigger-label="Provider actions" items='${JSON.stringify(menuItems).replace(/'/g, '&#39;')}'>
          ${icons.moreVertical?.('', 16) ?? `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`}
        </app-menu>
        <div data-slot="body">
          <div class="config-meta">
            <span class="badge ${statusClass}"><span class="badge__dot"></span>${escHtml(status)}</span>
            <span class="badge badge--muted is-mono">${escHtml(p.label)}</span>
            ${p.api_key_set ? '' : '<span class="badge badge--warning">No key</span>'}
          </div>
          <div class="tier-rows">
            <div class="tier-row"><span class="tier-label">Endpoint</span><span class="tier-model">${escHtml(p.base_url)}</span></div>
            <div class="tier-row"><span class="tier-label">Default model</span><span class="tier-model">${escHtml(p.default_model)}</span></div>
            <div class="tier-row"><span class="tier-label">Last sync</span><span class="tier-model">${escHtml(when)}</span></div>
          </div>
          ${p.last_sync_error ? `<p class="form-error">${escHtml(p.last_sync_error)}</p>` : ''}
        </div>
      </app-card>`;
  }

  #customFormHtml() {
    const c = this.#editingCustom;
    const isEdit = !!c;
    return `
      <div class="form-head">
        <app-button class="back-btn" variant="tertiary" icon-only size="sm"
          data-action="back" aria-label="Back">${icons.arrowLeft()}</app-button>
        <h1 class="title-page">${isEdit ? 'Edit custom provider' : 'Add custom provider'}</h1>
      </div>
      <form class="config-form" id="custom-form">
        <app-input id="cp-display" name="display_name" label="Display name"
          placeholder="e.g. Internal gateway" value="${escAttr(c?.display_name || '')}" required></app-input>
        <app-input id="cp-label" name="label" label="Provider id"
          placeholder="e.g. internal-gateway" value="${escAttr(c?.label || '')}"
          hint="Lowercase letters, digits, hyphens (2–40). Used everywhere this provider is referenced."
          ${isEdit ? 'disabled' : 'required'}></app-input>
        <app-input id="cp-base" name="base_url" label="Base URL"
          placeholder="https://gateway.internal/v1" value="${escAttr(c?.base_url || '')}"
          hint="OpenAI-compatible base URL (the part before /chat/completions)." required></app-input>
        <app-input id="cp-key" name="api_key" type="password" reveal
          label="API key" placeholder="${isEdit ? 'Leave blank to keep current key' : 'Paste the API key'}"
          autocomplete="off" hint="Stored encrypted; used to call the endpoint."></app-input>
        <app-input id="cp-default" name="default_model" label="Default model"
          placeholder="e.g. llama-3.1-8b" value="${escAttr(c?.default_model || '')}"
          hint="Last-resort model, used when no tier/config model is chosen. Must be one the endpoint serves." required></app-input>
        <app-input id="cp-models" name="models" label="Model names (optional)"
          placeholder="comma-separated, only if auto-listing is unsupported"
          hint="Leave blank when the endpoint answers GET /models. Otherwise list its models here."></app-input>
        <app-checkbox id="cp-sync" name="catalog_sync_enabled"
          label="Keep the model list fresh automatically" ${c ? (c.catalog_sync_enabled ? 'checked' : '') : 'checked'}></app-checkbox>
        <div class="form-error" id="custom-form-error" hidden></div>
        <div class="form-actions">
          <app-button variant="ghost" size="md" data-action="back">Cancel</app-button>
          <app-button variant="primary" size="md" type="submit">${isEdit ? 'Save changes' : 'Register provider'}</app-button>
        </div>
      </form>
    `;
  }

  #kpiHtml() {
    const providersInUse = new Set(this.#configs.map((c) => c.provider).filter(Boolean)).size;
    const defaultCfg = this.#configs.find((c) => c.is_default);
    // Built as an attribute rather than via the `items` setter: this strip is
    // part of one whole-page innerHTML write, so the element does not exist yet.
    const items = [
      { label: 'Router configs', value: this.#configs.length },
      { label: 'Providers connected', value: providersInUse },
      { label: 'Default config', value: defaultCfg?.name || 'None' },
    ];
    return `<app-stat-row items="${escAttr(JSON.stringify(items))}"></app-stat-row>`;
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
          <app-card card-title="${escAttr(c.name)}" role="button" tabindex="0"
            data-action="edit-config" data-id="${escAttr(c.id)}">
            <app-menu data-slot="actions" align="end" trigger-label="Config actions" items='${JSON.stringify(menuItems).replace(/'/g, '&#39;')}'>
              ${icons.moreVertical?.('', 16) ?? `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`}
            </app-menu>
            <div data-slot="body">
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
            </div>
          </app-card>`;
        }).join('')}
      </div>
    `;
  }

  #providerCardHtml(p) {
    const count = p.models?.length ?? 0;
    return `
      <app-card card-title="${escAttr(this.#cap(p.provider))}" role="button" tabindex="0"
        data-action="new-config" data-provider="${escAttr(p.provider)}">
        <span data-slot="leading" class="provider-glyph">${escHtml((p.provider || '?')[0])}</span>
        <span data-slot="actions" class="provider-add">${icons.plus('', 15)}</span>
        <div data-slot="body" class="provider-chips">
          <span class="badge badge--muted">Requires API key</span>
          <span class="badge badge--muted is-mono">${count} models</span>
        </div>
      </app-card>
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
        <app-button class="back-btn" variant="tertiary" icon-only size="sm"
          data-action="back" aria-label="Back">${icons.arrowLeft()}</app-button>
        <h1 class="title-page">${isEdit ? 'Edit config' : 'Configure router'}</h1>
      </div>
      <form class="config-form" id="config-form">
        <app-input id="cfg-name" name="name" label="Settings name"
          placeholder="Enter name" value="${escAttr(formName)}" required></app-input>
        <app-select id="cfg-provider" name="provider" label="Provider"
          placeholder="Choose Provider" required
          options="${escAttr(JSON.stringify(this.#providers.map((p) => ({
            value: p.provider, label: this.#cap(p.provider) }))))}"
          value="${escAttr(formProvider)}"></app-select>
        <div>
          <h3 class="group-title">Connect provider</h3>
          <p class="group-sub">${isEdit ? 'Update the provider secret or keep the current one.' : 'Connect provider by selecting an existing secret or adding a new one.'}</p>
          <div class="radio-group">
            <app-radio id="secret-saved" name="secret-mode" value="saved"
              label="Use saved secret" checked></app-radio>
            <app-radio id="secret-new" name="secret-mode" value="new"
              label="Add new secret"></app-radio>
          </div>
          <div id="saved-secret-field">
            <app-select id="cfg-secret" name="api_key_secret_name"
              label="Use saved secret" placeholder="Find secrets"
              hint="Select a secret already stored in your workspace."
              options="${escAttr(JSON.stringify(this.#secrets.map((sec) => {
                const name = sec.name ?? sec.key ?? '';
                return { value: name, label: name };
              })))}"
              value="${escAttr(formSecret)}"></app-select>
          </div>
          <div class="stacked-field" id="new-secret-field" hidden>
            <app-input id="cfg-secret-name" name="new_secret_name" label="Secret name"
              placeholder="e.g. OPENAI_API_KEY"></app-input>
            <app-input id="cfg-secret-value" name="secret_value" type="password" reveal
              label="Secret value" placeholder="Paste the API key" autocomplete="off"
              hint="Stored encrypted; only used to call the provider."></app-input>
          </div>
        </div>
        <div id="tier-section" ${formProvider ? '' : 'hidden'}>
          <h3 class="group-title">Reasoning levels</h3>
          <p class="group-sub">Assign a model for each reasoning level. The router automatically selects the appropriate model based on the request.</p>
          <div class="stacked-field">
            ${TIERS.map((t) => `
              <app-select id="cfg-${t.key}" name="${t.key}" data-tier-select
                label="${t.label}" hint="${escAttr(t.hint)}"
                options="${escAttr(JSON.stringify(this.#modelList(formProvider)))}"
                value="${escAttr(c?.[t.key] || '')}"></app-select>`).join('')}
          </div>
        </div>
        <app-checkbox id="cfg-default" name="is_default"
          label="Make this the default routing config" ${formDefault ? 'checked' : ''}></app-checkbox>
        <div class="form-error" id="form-error" hidden></div>
        <div class="form-actions">
          <app-button variant="ghost" size="md" data-action="back">Cancel</app-button>
          <app-button variant="primary" size="md" type="submit">${isEdit ? 'Save changes' : 'Save config'}</app-button>
        </div>
      </form>
    `;
  }

  /** Models a provider offers, as app-select's `options` JSON. The leading
   *  blank is a real choice, not a placeholder: a tier may be left unset.
   *  A model with no price row is labelled "cost not tracked" (its value — the
   *  model id — is unchanged, so routing works; only the cost is unknown). */
  #modelList(provider) {
    const entry = this.#providers.find((p) => p.provider === provider);
    return [{ value: '', label: 'Choose model' },
            ...(entry?.models ?? []).map((m) => ({
              value: m.model,
              label: m.pricing_available === false ? `${m.model} · cost not tracked` : m.model,
            }))];
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
    } else if (action === 'new-custom-provider') {
      this.#editingCustom = null;
      this.#view = 'custom-form';
      this.#render();
    } else if (action === 'back') {
      this.#editingConfig = null;
      this.#editingCustom = null;
      this.#view = 'list';
      this.#render();
    }
  }

  #onMenuAction(e) {
    const [action, id] = (e.detail?.id || '').split(':');
    if (!action || !id) return;
    if (action === 'custom-edit') {
      const cp = this.#customProviders.find((p) => p.id === id);
      if (!cp) return;
      this.#editingCustom = cp;
      this.#view = 'custom-form';
      this.#render();
      return;
    }
    if (action === 'custom-sync') {
      this.#syncCustom(id);
      return;
    }
    if (action === 'custom-delete') {
      this.#deleteCustom(id);
      return;
    }
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
    } else if (e.target.name === 'provider') {
      const provider = e.target.value;
      const tierSection = this.querySelector('#tier-section');
      if (tierSection) tierSection.hidden = !provider;
      // Retarget every tier through the `options` attribute — assigning
      // innerHTML would wipe the field app-select rendered.
      // setAttribute takes the raw JSON: escaping is for template
      // interpolation, and doing it here hands app-select `&quot;` to JSON.parse.
      const options = JSON.stringify(this.#modelList(provider));
      this.querySelectorAll('[data-tier-select]').forEach((sel) => {
        sel.setAttribute('options', options);
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
    const wantDefault = form.querySelector('#cfg-default').checked;
    if (!isEdit) {
      body.is_default = wantDefault;
    }
    const errEl = this.querySelector('#form-error');
    const nameField = form.querySelector('#cfg-name');
    const providerField = form.querySelector('#cfg-provider');
    // A fresh attempt clears the previous verdict on both fields, so a fixed
    // field stops showing red the moment the next one is flagged.
    clearFieldErrors(nameField, providerField);
    errEl.hidden = true;
    if (!body.name) {
      setFieldError(nameField, 'Settings name is required.');
      return;
    }
    if (!body.provider) {
      setFieldError(providerField, 'Choose a provider.');
      return;
    }
    // No single control owns "pick at least one model" — it spans three tier
    // selects, so it stays a form-level message.
    if (!body.tier1_model && !body.tier2_model && !body.tier3_model) {
      errEl.textContent = 'Choose a model for at least one reasoning level.';
      errEl.hidden = false;
      return;
    }
    try {
      if (isEdit) {
        await call('updateLlmConfig', this.#editingConfig.id, body);
        // PATCH ignores is_default by design — the flag moves through its own
        // endpoint, so only a *changed* checkbox costs a second request.
        if (wantDefault !== !!this.#editingConfig.is_default) {
          await call(wantDefault ? 'setDefaultLlmConfig' : 'clearDefaultLlmConfig',
                     this.#editingConfig.id);
        }
      } else {
        await call('createLlmConfig', body);
      }
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

  async #saveCustom(e) {
    e.preventDefault();
    const form = e.target;
    const isEdit = !!this.#editingCustom;
    const errEl = this.querySelector('#custom-form-error');
    errEl.hidden = true;
    const key = form.querySelector('#cp-key').value;
    const modelsRaw = form.querySelector('#cp-models').value.trim();
    const models = modelsRaw ? modelsRaw.split(',').map((m) => m.trim()).filter(Boolean) : [];
    const base = {
      display_name: form.querySelector('#cp-display').value.trim(),
      base_url: form.querySelector('#cp-base').value.trim(),
      default_model: form.querySelector('#cp-default').value.trim(),
      catalog_sync_enabled: form.querySelector('#cp-sync').checked,
    };
    try {
      if (isEdit) {
        // Omit the key unless a new one was typed (blank ⇒ keep the current key).
        await call('updateCustomProvider', this.#editingCustom.id, {
          ...base,
          ...(key ? { api_key: key } : {}),
        });
      } else {
        await call('createCustomProvider', {
          ...base,
          label: form.querySelector('#cp-label').value.trim(),
          api_key: key,
          models,
        });
      }
    } catch (err) {
      errEl.textContent = err?.message || 'Failed to save custom provider';
      errEl.hidden = false;
      return;
    }
    showToast(isEdit ? 'Custom provider updated' : 'Custom provider registered');
    this.#editingCustom = null;
    this.#load();
  }

  async #syncCustom(id) {
    try {
      const res = await call('syncCustomProvider', id);
      const n = res?.data?.discovered_models;
      showToast(typeof n === 'number' ? `Synced — ${n} models` : 'Sync complete');
    } catch (err) {
      showToast(err?.message || 'Failed to sync models');
      return;
    }
    this.#load();
  }

  async #deleteCustom(id) {
    const confirmed = await confirmDialog({
      title: 'Delete custom provider',
      message: 'This removes the provider and its discovered models. Configs that reference it must be repointed first.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await call('deleteCustomProvider', id);
    } catch (err) {
      showToast(err?.message || 'Failed to delete provider');
      return;
    }
    showToast('Custom provider deleted');
    this.#load();
  }

  #cap(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
  }

}

customElements.define('llm-router-page', LlmRouterPage);
