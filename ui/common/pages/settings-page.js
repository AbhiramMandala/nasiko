import { showToast } from '/common/utils/toast.js';
import { withLoading } from '/common/utils/async-button.js';
import { initialView, syncView } from '/common/utils/module-view.js';

import styles from './settings-page.css' with { type: 'css' };
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

// Every field below must exist in the server's `SettingsUpdate`
// (oss/server/src/settings.rs). Serde drops unknown keys silently, so a field
// the server doesn't know still returns 200 and still toasts "saved" while
// persisting nothing — this page previously shipped seven such fields
// (instance_name, default_model, max_tokens, anthropic_api_key, openai_api_key,
// registry_username, registry_password) and hid four that the server does
// support. Adding a control here means adding it there too.
const TABS = [
  { key: 'general', label: 'General', sub: 'Routing defaults and platform behaviour.' },
  { key: 'limits', label: 'Flow limits', sub: 'Cascade guards applied to every inter-agent call.' },
  { key: 'registry', label: 'Registry', sub: 'External OCI registry used for agent images.' },
  { key: 'sso', label: 'Single sign-on', sub: 'Configure your identity provider for SSO, SCIM, and directory sync.' },
];

// The key web/settings.html gives this element as a `data-view` of the Settings
// module-shell. The shell selects between *views* (this page and Secrets); the
// four sections above are a finer level inside this one view, which is why they
// are not view keys and why this element is the shell's `default-view` — a
// `?view=limits` link means "Settings, Flow limits section", and only the
// fallback-to-default keeps the shell showing this page for it.
const VIEW = 'settings';

class SettingsPage extends HTMLElement {
  #initialized = false;
  #settings = {};
  /** The section on screen — one of TABS' keys. */
  #section = TABS[0].key;
  /** Where the nav's bubbling events are listened for (see connectedCallback). */
  #navRoot = null;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    // Deep links name a section, not a view: `?view=limits` opens this page on
    // Flow limits. Same param and same validator as the shell's, so the two
    // levels cannot disagree about how a view is spelled — an unknown value
    // falls back to General rather than rendering four hidden panels.
    this.#section = initialView(TABS.map(t => t.key), TABS[0].key);

    this.innerHTML = `
      <div class="content">
        ${TABS.map(t => `
          <div class="panel-head${t.key === this.#section ? ' is-active' : ''}" data-panel-head="${t.key}">
            <h1 class="title-page">${t.label}</h1>
            <p class="page-sub">${t.sub}</p>
          </div>
        `).join('')}

        <div class="panel${this.#section === 'general' ? ' is-active' : ''}" data-panel="general">
          <div class="setting-row">
            <div class="setting-info">
              <label for="s-router-model">Router model</label>
              <div class="hint">Model the routing engine uses to pick an agent for each query (<code>ROUTER_MODEL</code>).</div>
            </div>
            <div class="setting-control">
              <input type="text" id="s-router-model" data-field="router_model" placeholder="e.g. gpt-4o" />
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <label for="s-default-provider">Default provider</label>
              <div class="hint">Provider used when an agent has no LLM config of its own.</div>
            </div>
            <div class="setting-control">
              <select id="s-default-provider" data-field="default_provider">
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Gemini</option>
              </select>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <label for="s-catalog-tabs">Agent catalog tabs</label>
              <div class="hint">Comma-separated agent tags pinned as the catalog's filter tabs. Leave empty to derive tabs from the most common tags across agents.</div>
            </div>
            <div class="setting-control">
              <input type="text" id="s-catalog-tabs" data-field="catalog_tabs" data-allow-empty placeholder="e.g. devops, finance, support" />
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <label>Provider API keys</label>
              <div class="hint">Keys aren't stored here — each routing config references one of your
                encrypted secrets. Manage them on the
                <a href="/llm-router.html">LLM router</a> and
                <a href="/settings.html?view=secrets">Secrets</a> pages.</div>
            </div>
            <div class="setting-control"></div>
          </div>
        </div>

        <div class="panel${this.#section === 'limits' ? ' is-active' : ''}" data-panel="limits">
          <div class="setting-row">
            <div class="setting-info">
              <label for="s-flow-depth">Max call depth</label>
              <div class="hint">How many agent-to-agent hops one flow may chain before it's rejected.</div>
            </div>
            <div class="setting-control">
              <input type="number" id="s-flow-depth" data-field="max_flow_depth" min="1" />
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <label for="s-flow-fanout">Max fan-out</label>
              <div class="hint">Maximum agents a single flow may call in total.</div>
            </div>
            <div class="setting-control">
              <input type="number" id="s-flow-fanout" data-field="max_flow_fan_out" min="1" />
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <label for="s-flow-tokens">Token budget per flow</label>
              <div class="hint">Combined prompt + completion tokens a flow may spend.</div>
            </div>
            <div class="setting-control">
              <input type="number" id="s-flow-tokens" data-field="max_flow_tokens" min="1" />
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <label for="s-flow-timeout">Flow timeout (seconds)</label>
              <div class="hint">Wall-clock limit for a whole flow.</div>
            </div>
            <div class="setting-control">
              <input type="number" id="s-flow-timeout" data-field="flow_timeout_secs" min="1" />
            </div>
          </div>
        </div>

        <div class="panel${this.#section === 'registry' ? ' is-active' : ''}" data-panel="registry">
          <div class="setting-row">
            <div class="setting-info">
              <label for="s-registry-url">OCI registry URL</label>
              <div class="hint">Where imported agent images are pulled from.</div>
            </div>
            <div class="setting-control">
              <input type="url" id="s-registry-url" data-field="registry_url" data-allow-empty placeholder="https://registry.example.com" />
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <label>Registry credentials</label>
              <div class="hint">Per-agent pull credentials are issued by the platform, and the
                cluster-wide build credential comes from <code>BUILD_PUSH_TOKEN</code> — neither is
                configured from this page.</div>
            </div>
            <div class="setting-control"></div>
          </div>
        </div>

        <div class="panel${this.#section === 'sso' ? ' is-active' : ''}" data-panel="sso">
          <div class="setting-row">
            <div class="setting-info">
              <label for="s-idp-kind">Identity provider</label>
              <div class="hint">Select your enterprise IdP. SCIM provisioning is auto-enabled when SSO is configured. Directory sync is available for Microsoft Entra.</div>
            </div>
            <div class="setting-control">
              <select id="s-idp-kind">
                <option value="">Not configured</option>
                <option value="entra">Microsoft Entra ID</option>
                <option value="okta">Okta</option>
              </select>
            </div>
          </div>
          <div id="sso-fields" style="display:none">
            <div class="setting-row">
              <div class="setting-info">
                <label for="s-oidc-issuer">Issuer URL</label>
                <div class="hint" id="s-issuer-hint"></div>
              </div>
              <div class="setting-control">
                <input type="url" id="s-oidc-issuer" data-field="oidc_issuer_url" data-allow-empty />
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <label for="s-oidc-client-id">Client ID</label>
                <div class="hint" id="s-client-id-hint"></div>
              </div>
              <div class="setting-control">
                <input type="text" id="s-oidc-client-id" data-field="oidc_client_id" data-allow-empty />
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <label for="s-oidc-client-secret">Client secret</label>
                <div class="hint" id="s-oidc-secret-state">Write-only — leave blank to keep the stored secret.</div>
              </div>
              <div class="setting-control">
                <input type="password" id="s-oidc-client-secret" data-field="oidc_client_secret" placeholder="unchanged" />
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <label for="s-oidc-redirect">Redirect URI</label>
                <div class="hint">Must match the URI registered in your IdP app. Copy this value into your IdP's allowed redirect URIs.</div>
              </div>
              <div class="setting-control">
                <input type="url" id="s-oidc-redirect" data-field="oidc_redirect_uri" data-allow-empty placeholder="${window.location.origin}/api/auth/oidc/callback" />
              </div>
            </div>
          </div>

          <div id="sso-status" style="display:none">
            <div class="setting-row">
              <div class="setting-info">
                <label>Status</label>
              </div>
              <div class="setting-control" id="s-sso-status-badges"></div>
            </div>
          </div>

          <div id="scim-section" style="display:none">
            <div style="margin-top:1.5rem;margin-bottom:0.5rem;font-weight:600;font-size:0.95rem;color:var(--text-primary, #1a1a1a)">SCIM provisioning</div>
            <div class="setting-row">
              <div class="setting-info">
                <label>Tenant URL</label>
                <div class="hint">Copy this URL into your IdP's SCIM provisioning "Tenant URL" field.</div>
              </div>
              <div class="setting-control">
                <div style="display:flex;align-items:center;gap:0.5rem">
                  <code id="s-scim-endpoint" style="padding:0.5rem 0.75rem;background:var(--sand-100, #f5f5f0);border-radius:var(--r-8);font-size:0.85rem;user-select:all">${window.location.origin}/scim/v2</code>
                  <button type="button" id="btn-copy-scim-url" style="padding:0.35rem 0.75rem;font-size:0.8rem;cursor:pointer;border-radius:var(--r-8)">Copy</button>
                </div>
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <label>Secret Token</label>
                <div class="hint">Generate a bearer token and paste it into your IdP's SCIM "Secret Token" field. The token is shown only once — copy it immediately.</div>
              </div>
              <div class="setting-control">
                <button type="button" id="btn-generate-scim-token" style="width:auto;padding:0.5rem 1.25rem;font-size:0.9rem;cursor:pointer;border:1px solid var(--border-default, #ccc);border-radius:var(--r-8, 6px);background:var(--color-bg-surface, #fff)">Generate new token</button>
                <div id="s-scim-token-display" style="display:none;margin-top:0.75rem;padding:0.75rem;background:var(--color-success-bg, #e6f4ea);border:1px solid var(--color-success, #1e7e34);border-radius:var(--r-8);word-break:break-all;font-size:0.85rem;font-family:monospace"></div>
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <label>Active tokens</label>
              </div>
              <div class="setting-control">
                <div id="s-scim-token-list" style="font-size:0.9rem"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="save-bar">
          <button class="save-btn" id="btn-save">Save changes</button>
        </div>
      </div>
    `;

    // The nav is the shell's child, not this element's (see web/settings.html),
    // so its bubbling `module-nav-select` goes past this element rather than
    // through it — listen on the shell. Standalone hosts (an element created in
    // JS, or a page that still renders its own nav inside) keep the old target.
    this.#navRoot = this.closest('module-shell') ?? this;
    this.#navRoot.addEventListener('module-nav-select', this.#onNavSelect);

    // Only meaningful for the shell's own view keys, and the shell resolves
    // those itself; here it is the section level that has to reach the nav.
    if (this.#isActiveView()) this.#highlightNav(this.#section);

    this.querySelector('#btn-save').addEventListener('click', () => this.#save());

    // IdP picker drives field visibility + hints
    const idpSelect = this.querySelector('#s-idp-kind');
    idpSelect?.addEventListener('change', () => this.#updateIdpFields(idpSelect.value));

    // SCIM token generation + copy URL
    this.querySelector('#btn-generate-scim-token')?.addEventListener('click', () => this.#generateScimToken());
    this.querySelector('#btn-copy-scim-url')?.addEventListener('click', () => {
      const url = this.querySelector('#s-scim-endpoint')?.textContent;
      if (url) { navigator.clipboard.writeText(url); showToast('SCIM URL copied'); }
    });

    this.#load();
  }

  disconnectedCallback() {
    this.#navRoot?.removeEventListener('module-nav-select', this.#onNavSelect);
  }

  /** True when the shell is showing this view (or there is no shell). */
  #isActiveView() {
    const shell = this.closest('module-shell');
    return !shell || shell.activeView === VIEW;
  }

  /** The nav lives beside this element now, and only this element knows which
   *  section is up, so the highlight at that granularity is ours to set. */
  #highlightNav(key) {
    (this.closest('module-shell') ?? this)
      .querySelector('app-module-nav')
      ?.setAttribute('active-section', key);
  }

  /**
   * One event, two granularities. The shell answers it for its view keys and
   * ignores everything else, and these four section keys are exactly that
   * "everything else" — so a workspace row never moves the shell, and this
   * element owns the switch.
   */
  #onNavSelect = (e) => {
    const key = e.detail?.section;
    if (!TABS.some(t => t.key === key)) return;
    this.#section = key;
    this.querySelectorAll('.panel').forEach(p =>
      p.classList.toggle('is-active', p.dataset.panel === key));
    this.querySelectorAll('.panel-head').forEach(h =>
      h.classList.toggle('is-active', h.dataset.panelHead === key));

    // Arriving from a sibling view (Secrets): the shell is still showing that
    // one, since the key it just saw is not one of its own, so ask it for this
    // view. `show()` then names *its* coarser key in the URL and on the nav, so
    // put the section the user actually clicked back into both.
    const shell = this.closest('module-shell');
    if (shell && shell.activeView !== VIEW) {
      shell.show(VIEW);
      syncView(key);
      this.#highlightNav(key);
    }
  };

  async #load() {
    const s = await window.fetchSettings();
    if (!s) return;
    this.#settings = s;
    this.querySelectorAll('[data-field]').forEach(el => {
      if (s[el.dataset.field] != null) el.value = s[el.dataset.field];
    });

    // Secret state indicator
    const secretState = this.querySelector('#s-oidc-secret-state');
    if (secretState) {
      secretState.textContent = s.oidc_client_secret_configured
        ? 'A secret is stored. Leave blank to keep it, or enter a new one to replace it.'
        : 'No secret stored yet — SSO stays disabled until one is set.';
    }

    // Set the IdP picker from the derived provider_kind
    const idpSelect = this.querySelector('#s-idp-kind');
    if (idpSelect && s.provider_kind) {
      const kind = s.provider_kind === 'microsoft' ? 'entra' : s.provider_kind;
      if ([...idpSelect.options].some(o => o.value === kind)) {
        idpSelect.value = kind;
      }
    }
    this.#updateIdpFields(idpSelect?.value || '');

    // Show status badges if configured
    if (s.oidc_configured) {
      const statusEl = this.querySelector('#sso-status');
      const badges = this.querySelector('#s-sso-status-badges');
      if (statusEl && badges) {
        statusEl.style.display = '';
        const providerName = s.provider_kind === 'microsoft' ? 'Entra' : (s.provider_kind || 'OIDC');
        badges.innerHTML = `
          <span style="display:inline-block;padding:0.25rem 0.75rem;border-radius:var(--r-8);background:var(--color-success-bg, #e6f4ea);color:var(--color-success, #1e7e34);font-weight:500;margin-right:0.5rem">SSO active (${providerName})</span>
          <span style="display:inline-block;padding:0.25rem 0.75rem;border-radius:var(--r-8);background:var(--color-success-bg, #e6f4ea);color:var(--color-success, #1e7e34);font-weight:500;margin-right:0.5rem">SCIM enabled</span>
          ${s.directory_sync_enabled ? '<span style="display:inline-block;padding:0.25rem 0.75rem;border-radius:var(--r-8);background:var(--color-success-bg, #e6f4ea);color:var(--color-success, #1e7e34);font-weight:500">Directory sync</span>' : ''}
        `;
      }
    }

    // Load SCIM tokens whenever the section is visible
    this.#loadScimTokens();
  }

  #updateIdpFields(kind) {
    const fields = this.querySelector('#sso-fields');
    const scim = this.querySelector('#scim-section');
    const issuerHint = this.querySelector('#s-issuer-hint');
    const clientHint = this.querySelector('#s-client-id-hint');

    if (!kind) {
      if (fields) fields.style.display = 'none';
      if (scim) scim.style.display = 'none';
      return;
    }

    if (fields) fields.style.display = '';
    if (scim) scim.style.display = '';

    if (kind === 'entra') {
      if (issuerHint) issuerHint.innerHTML = 'Azure Portal → App registrations → Endpoints → <code>https://login.microsoftonline.com/&lt;tenant-id&gt;/v2.0</code>';
      if (clientHint) clientHint.textContent = 'Azure Portal → App registrations → Application (client) ID';
    } else if (kind === 'okta') {
      if (issuerHint) issuerHint.innerHTML = 'Okta Admin → Applications → your app → <code>https://&lt;org&gt;.okta.com/oauth2/default</code>';
      if (clientHint) clientHint.textContent = 'Okta Admin → Applications → your app → Client ID';
    }
  }

  async #generateScimToken() {
    const btn = this.querySelector('#btn-generate-scim-token');
    const display = this.querySelector('#s-scim-token-display');
    if (!btn) return;

    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      // Derive provider from current IdP selection
      const kind = this.querySelector('#s-idp-kind')?.value || 'default';
      const provider = kind === 'entra' ? 'entra' : kind === 'okta' ? 'okta' : 'default';

      const res = await fetch('/api/settings/scim/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ provider, description: `Generated from settings page` }),
      });
      if (!res.ok) throw new Error('Failed to generate token');
      const data = await res.json();
      if (display) {
        display.style.display = '';
        display.innerHTML = `<strong>Token (copy now — shown only once):</strong><br/>${data.token}<br/><button type="button" id="btn-copy-scim-token" style="margin-top:0.5rem;padding:0.25rem 0.75rem;font-size:0.8rem;cursor:pointer;border-radius:var(--r-8)">Copy token</button>`;
        display.querySelector('#btn-copy-scim-token')?.addEventListener('click', () => {
          navigator.clipboard.writeText(data.token);
          showToast('Token copied to clipboard');
        });
      }
      showToast('SCIM token generated — copy it now, it won\'t be shown again');
      this.#loadScimTokens();
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate token';
    }
  }

  async #loadScimTokens() {
    const list = this.querySelector('#s-scim-token-list');
    if (!list) return;
    try {
      const res = await fetch('/api/settings/scim/tokens', { credentials: 'same-origin' });
      if (!res.ok) {
        if (res.status === 404) {
          list.innerHTML = '<span style="color:var(--text-muted, #888)">No tokens found. Generate one above to enable SCIM provisioning.</span>';
        } else if (res.status === 401 || res.status === 403) {
          list.textContent = '';
        } else {
          list.textContent = 'Failed to load tokens';
        }
        return;
      }
      const data = await res.json();
      const tokens = (data.tokens || []).filter(t => !t.revoked_at);
      if (tokens.length === 0) {
        list.innerHTML = '<span style="color:var(--text-muted, #888)">No active tokens. Generate one to enable SCIM provisioning.</span>';
        return;
      }
      list.innerHTML = tokens.map(t => {
        const created = new Date(t.created_at).toLocaleDateString();
        const lastUsed = t.last_used_at ? new Date(t.last_used_at).toLocaleDateString() : 'never';
        const revoked = t.revoked_at ? ' (revoked)' : '';
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid var(--border-subtle, #e5e5e5)">
          <div>
            <strong>${t.description || 'Unnamed'}</strong>${revoked}<br/>
            <small>Created ${created} · Last used ${lastUsed} · Provider: ${t.provider}</small>
          </div>
          ${!t.revoked_at ? `<button type="button" class="btn-revoke-token" data-token-id="${t.id}" style="padding:0.25rem 0.75rem;font-size:0.85rem;cursor:pointer">Revoke</button>` : ''}
        </div>`;
      }).join('');
      // Attach revoke handlers
      list.querySelectorAll('.btn-revoke-token').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.tokenId;
          await fetch(`/api/settings/scim/tokens/${id}`, { method: 'DELETE', credentials: 'same-origin' });
          showToast('Token revoked');
          this.#loadScimTokens();
        });
      });
    } catch {
      list.textContent = 'Failed to load tokens';
    }
  }

  #save() {
    const btn = this.querySelector('#btn-save');
    withLoading(btn, 'Saving…', async () => {
      const updated = { ...this.#settings };
      // Read-only / derived fields — don't send back
      delete updated.oidc_client_secret_configured;
      delete updated.provider_kind;
      delete updated.oidc_configured;
      delete updated.scim_enabled;
      delete updated.directory_sync_enabled;
      this.querySelectorAll('[data-field]').forEach(el => {
        const v = el.value.trim();
        if (v || el.hasAttribute('data-allow-empty')) {
          updated[el.dataset.field] = el.type === 'number' ? Number(v) : v;
        }
      });
      await window.saveSettings(updated);
      showToast('Settings saved');
      // Reload to update derived status
      this.#load();
    })();
  }
}

customElements.define('settings-page', SettingsPage);
