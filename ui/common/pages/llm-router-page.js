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
import '/common/design-system/app-alert/app-alert.js';
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
  #customKind = 'openai'; // endpoint dialect for the add-custom-provider form

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.addEventListener('click', (e) => this.#onClick(e));
    this.addEventListener('change', (e) => this.#onChange(e));
    this.addEventListener('input', (e) => this.#onInput(e));
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
        <app-button variant="secondary" size="md" data-action="new-custom-provider" class="custom-provider-btn">Add custom provider</app-button>
      </div>
      ${this.#customProviders.length
        ? `<div class="config-list">${this.#customProviders.map((p) => this.#customCardHtml(p)).join('')}</div>`
        : ''}
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
            ${p.kind === 'azure-openai' ? `<div class="tier-row"><span class="tier-label">Type</span><span class="tier-model">Azure OpenAI (api-version ${escHtml(p.api_version || '—')})</span></div>` : ''}
            ${p.default_model ? `<div class="tier-row"><span class="tier-label">${p.kind === 'azure-openai' ? 'Default deployment' : 'Default model'}</span><span class="tier-model">${escHtml(p.default_model)}</span></div>` : ''}
            <div class="tier-row"><span class="tier-label">Last sync</span><span class="tier-model">${escHtml(when)}</span></div>
          </div>
          ${p.last_sync_error ? `<p class="form-error">${escHtml(p.last_sync_error)}</p>` : ''}
        </div>
      </app-card>`;
  }

  #customFormHtml() {
    const c = this.#editingCustom;
    const isEdit = !!c;
    // Azure needs an api-version and speaks in deployment names, so the labels,
    // hints and placeholders around it change with the endpoint type. On a new
    // provider this is the initial state; #onChange re-renders it on switch.
    const isAzure = (c?.kind || this.#customKind) === 'azure-openai';
    return `
      <div class="form-head">
        <app-button class="back-btn" variant="tertiary" icon-only size="sm"
          data-action="back" aria-label="Back">${icons.arrowLeft()}</app-button>
        <h1 class="title-page">${isEdit ? 'Edit custom provider' : 'Add custom provider'}</h1>
      </div>
      <form class="config-form" id="custom-form">
        <app-input id="cp-display" name="display_name" label="Name"
          placeholder="e.g. Internal gateway" value="${escAttr(c?.display_name || '')}" required></app-input>
        <app-select id="cp-kind" name="kind" label="Endpoint type"
          options='[{"value":"openai","label":"OpenAI-compatible"},{"value":"azure-openai","label":"Azure OpenAI"}]'
          value="${escAttr(c?.kind || 'openai')}"
          hint="Azure routes by deployment name and authenticates differently, so it needs its own setting."
          ${isEdit ? 'disabled' : ''}></app-select>
        <app-input id="cp-base" name="base_url" label="Base URL"
          placeholder="${isAzure ? 'https://my-resource.openai.azure.com' : 'https://gateway.internal/v1'}"
          value="${escAttr(c?.base_url || '')}"
          hint="${isAzure
            ? 'Your Azure OpenAI resource URL — the platform appends /openai/deployments/… itself.'
            : 'OpenAI-compatible base URL (the part before /chat/completions).'}" required></app-input>
        <div id="cp-api-version-field" ${isAzure ? '' : 'hidden'}>
          <app-input id="cp-api-version" name="api_version" label="API version"
            placeholder="e.g. 2024-10-21" value="${escAttr(c?.api_version || '')}"
            hint="Azure requires an api-version on every call. Use one your deployments support."></app-input>
        </div>
        <app-input id="cp-key" name="api_key" type="password" reveal
          label="API key" placeholder="${isEdit ? 'Leave blank to keep current key' : 'Paste the API key'}"
          autocomplete="off" hint="Stored encrypted; used to call the endpoint."
          ${isEdit ? '' : 'required'}></app-input>
        <div id="test-result" hidden></div>
        <app-alert id="custom-form-alert" variant="destructive" hidden></app-alert>
        <div class="form-actions">
          <app-button variant="ghost" size="md" data-action="back">Cancel</app-button>
          <app-button variant="secondary" size="md" data-action="test-connection">Test connection</app-button>
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
                <span class="badge badge--muted">${escHtml(this.#providerLabel(c.provider))}</span>
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
    const name = p.display_name || this.#cap(p.provider);
    return `
      <app-card card-title="${escAttr(name)}" role="button" tabindex="0"
        data-action="new-config" data-provider="${escAttr(this.#providerValue(p))}">
        <span data-slot="leading" class="provider-glyph">${escHtml((name || '?')[0])}</span>
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
          options="${escAttr(JSON.stringify([
            ...this.#providers.map((p) => ({
              value: this.#providerValue(p),
              label: p.display_name || this.#cap(p.provider),
            })),
          ]))}"
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

  /** The value a provider is identified by in a config — the UUID for a custom
   *  provider, the name for a built-in one. The provider card, the select
   *  options and the saved config must all agree or nothing pre-selects. */
  #providerValue(p) { return p.provider_id || p.provider; }

  #findProvider(value) {
    if (!value) return undefined;
    return this.#providers.find((p) => p.provider === value || p.provider_id === value);
  }

  /** Display name for a stored provider value (a name, or a custom-provider UUID). */
  #providerLabel(value) {
    const entry = this.#findProvider(value);
    return entry?.display_name || this.#cap(entry?.provider || value);
  }

  /** Models a provider offers, as app-select's `options` JSON. The leading
   *  blank is a real choice, not a placeholder: a tier may be left unset.
   *  A model with no price row is labelled "cost not tracked" (its value — the
   *  model id — is unchanged, so routing works; only the cost is unknown). */
  #modelList(provider) {
    const entry = this.#findProvider(provider);
    return [{ value: '', label: 'Choose model' },
            ...(entry?.models ?? []).map((m) => ({
              value: m.model, label: m.model,
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
    } else if (action === 'test-connection') {
      this.#testConnection();
    } else if (action === 'new-custom-provider') {
      this.#editingCustom = null;
      // A fresh form starts on the default endpoint type, not whatever the last one used.
      this.#customKind = 'openai';
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
    if (e.target.name === 'kind') {
      // Re-render so every Azure-specific label, hint and field follows the choice.
      this.#customKind = e.target.value;
      this.#render();
      return;
    }
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

  /** Editing the endpoint or the key invalidates the last probe: the verdict
   *  goes and the Test button comes back. */
  #onInput(e) {
    if (!e.target.closest('#cp-base, #cp-key')) return;
    const resultEl = this.querySelector('#test-result');
    if (resultEl) resultEl.hidden = true;
    this.#customError(null);
    const btn = this.querySelector('[data-action="test-connection"]');
    if (btn) btn.hidden = false;
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

  /** The custom-provider form's error line. `null` hides it. */
  #customError(message) {
    const el = this.querySelector('#custom-form-alert');
    if (!el) return;
    if (message) el.setAttribute('heading', message);
    el.hidden = !message;
  }

  async #saveCustom(e) {
    e.preventDefault();
    const form = e.target;
    const isEdit = !!this.#editingCustom;
    this.#customError(null);
    const key = form.querySelector('#cp-key').value;
    const kind = form.querySelector('#cp-kind')?.value || 'openai';
    const apiVersion = form.querySelector('#cp-api-version')?.value.trim() || '';
    const base = {
      display_name: form.querySelector('#cp-display').value.trim(),
      base_url: form.querySelector('#cp-base').value.trim(),
      // Only Azure carries an api-version; sending an empty one would blank a stored value.
      ...(apiVersion ? { api_version: apiVersion } : {}),
    };
    let result;
    try {
      if (isEdit) {
        // `kind` is immutable, so it is not sent on edit; blank key ⇒ keep current key.
        await call('updateCustomProvider', this.#editingCustom.id, {
          ...base,
          ...(key ? { api_key: key } : {}),
        });
      } else {
        result = await call('createCustomProvider', { ...base, kind, api_key: key });
      }
    } catch (err) {
      this.#customError(err?.message || 'Failed to save custom provider');
      return;
    }
    showToast(isEdit ? 'Custom provider updated' : 'Custom provider registered');
    this.#editingCustom = null;

    if (isEdit) {
      this.#load();
      return;
    }
    // New registration: reload the catalog so the new provider's models are
    // available, then open the config form pre-selected with this provider.
    const providerId = result?.data?.id;
    try {
      const [configs, providers, secrets, custom] = await Promise.all([
        call('fetchLlmConfigs'),
        call('fetchLlmProviders'),
        call('fetchSecretsList'),
        call('fetchCustomProviders').catch(() => ({ data: [] })),
      ]);
      this.#configs = configs?.data ?? [];
      this.#providers = providers?.data ?? [];
      this.#secrets = Array.isArray(secrets) ? secrets : secrets?.data ?? [];
      this.#customProviders = custom?.data ?? [];
    } catch { /* fall through to list */ }

    // Find the provider value to pre-select (UUID for custom providers).
    const match = this.#providers.find((p) => p.provider_id === providerId);
    const preselect = match ? this.#providerValue(match) : '';
    this.#editingConfig = null;
    this.#view = 'form';
    this.innerHTML = this.#formHtml(preselect);
    this.querySelector('#config-form')?.addEventListener('submit', (ev) => this.#save(ev));
    showToast('Now configure the routing — pick models for each reasoning level.');
  }

  async #testConnection() {
    const form = this.querySelector('#custom-form');
    if (!form) return;
    const base_url = form.querySelector('#cp-base').value.trim();
    const api_key = form.querySelector('#cp-key').value;
    const kind = form.querySelector('#cp-kind')?.value || 'openai';
    const apiVersion = form.querySelector('#cp-api-version')?.value.trim() || '';
    const resultEl = this.querySelector('#test-result');
    this.#customError(null);
    if (resultEl) resultEl.hidden = true;
    if (!base_url || !api_key) {
      this.#customError('Base URL and API key are required to test.');
      return;
    }
    const btn = this.querySelector('[data-action="test-connection"]');
    if (btn) btn.setAttribute('loading', '');
    try {
      const res = await call('testCustomProvider', {
        base_url,
        api_key,
        kind,
        ...(apiVersion ? { api_version: apiVersion } : {}),
      });
      const models = (res?.data ?? res ?? {}).models ?? [];
      resultEl.innerHTML = `
        <div class="test-result-box">
          <p><strong>Models discovered: ${models.length}</strong></p>
          ${models.length ? `<div class="test-models">${models.map((m) => `<span class="badge badge--muted is-mono">${escHtml(m)}</span>`).join(' ')}</div>` : '<p class="section-sub">No models returned — the endpoint may not support GET /models.</p>'}
        </div>`;
      resultEl.hidden = false;
      // Nothing left to retest — until the URL or key is edited (#onInput).
      if (btn) btn.hidden = true;
    } catch (err) {
      this.#customError(err?.message || 'Connection test failed');
    } finally {
      btn?.removeAttribute('loading');
    }
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
