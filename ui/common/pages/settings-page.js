import { showToast } from '/common/utils/toast.js';
import { withLoading } from '/common/utils/async-button.js';
import { initialView, syncView } from '/common/utils/module-view.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./settings-page.css', import.meta.url));
import { call, callOptional } from '../core/data-sources.js';
import { fetchApi, postJson, deleteJson } from '/common/services/api.js';
import { authService } from '/common/services/auth-service.js';
// The page mounts an <app-module-nav>, and page-layout.css reserves the desktop
// gutter it pins into. Nothing imported it, so under the client router the
// gutter was reserved and the nav never upgraded.
import '/common/features/app-module-nav.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-input/app-input.js';
import '/common/design-system/app-select/app-select.js';
import '/common/design-system/app-badge/app-badge.js';

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

// The IdP picker is presentation only: the real provider is derived
// server-side from the issuer URL (nasiko_identity_ee::detect), and
// OidcSettingsUpdate has no field for it. Picking a kind here only switches
// which per-field hints are shown; it never round-trips to the server.
const IDP_HINTS = {
  entra: {
    issuer: 'Azure Portal → App registrations → Endpoints → <code>https://login.microsoftonline.com/&lt;tenant-id&gt;/v2.0</code>',
    clientId: 'Azure Portal → App registrations → Application (client) ID',
  },
  okta: {
    issuer: 'Okta Admin → Applications → your app → <code>https://&lt;org&gt;.okta.com/oauth2/default</code>',
    clientId: 'Okta Admin → Applications → your app → Client ID',
  },
};

// Display names for every `provider_kind` the server can report — including
// the ones the picker has no option for, which a deployment can still reach
// through `OIDC_PROVIDER_LABEL` or a pre-picker configuration.
const IDP_LABELS = {
  entra: 'Microsoft Entra ID',
  okta: 'Okta',
  google: 'Google',
  keycloak: 'Keycloak',
  aws_iam_ic: 'AWS IAM Identity Center',
  generic: 'OIDC',
};

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
  /** True once the server reports a complete OIDC configuration. */
  #ssoConfigured = false;
  /** True once a provider is stored — the IdP picker is one-way from then on. */
  #idpLocked = false;

  async connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    // Ensure user info is loaded before checking role.
    await authService.fetchCurrentUser();
    const isAdmin = authService.isSuperuser();

    // Non-admin users see only their secrets — admin-level platform settings
    // (General, Flow limits, Registry, SSO) are superuser-gated on the API.
    if (!isAdmin) {
      await import('/common/features/secrets-manager.js');
      await import('/common/features/app-module-nav.js');
      this.innerHTML = `
        <app-module-nav module="settings"></app-module-nav>
        <div class="content">
          <div class="panel-head is-active">
            <h1 class="title-page">Secrets</h1>
            <p class="page-sub">Your API keys and credentials. Agents and router configs reference these by name.</p>
          </div>
          <secrets-manager scope="user"></secrets-manager>
        </div>
      `;
      return;
    }

    // Deep links name a section, not a view: `?view=limits` opens this page on
    // Flow limits. Same param and same validator as the shell's, so the two
    // levels cannot disagree about how a view is spelled — an unknown value
    // falls back to General rather than rendering four hidden panels.
    this.#section = initialView(TABS.map(t => t.key), TABS[0].key);

    this.innerHTML = `
      <app-module-nav module="settings"></app-module-nav>
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
              <app-input type="text" id="s-router-model" data-field="router_model" placeholder="e.g. gpt-4o" aria-label="Router model"></app-input>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <label for="s-default-provider">Default provider</label>
              <div class="hint">Provider used when an agent has no LLM config of its own.</div>
            </div>
            <div class="setting-control">
              <app-select id="s-default-provider" data-field="default_provider" aria-label="Default provider">
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Gemini</option>
              </app-select>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <label for="s-catalog-tabs">Agent catalog tabs</label>
              <div class="hint">Comma-separated agent tags pinned as the catalog's filter tabs. Leave empty to derive tabs from the most common tags across agents.</div>
            </div>
            <div class="setting-control">
              <app-input type="text" id="s-catalog-tabs" data-field="catalog_tabs" data-allow-empty placeholder="e.g. devops, finance, support" aria-label="Agent catalog tabs"></app-input>
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
              <app-input type="number" id="s-flow-depth" data-field="max_flow_depth" min="1" aria-label="Max call depth"></app-input>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <label for="s-flow-fanout">Max fan-out</label>
              <div class="hint">Maximum agents a single flow may call in total.</div>
            </div>
            <div class="setting-control">
              <app-input type="number" id="s-flow-fanout" data-field="max_flow_fan_out" min="1" aria-label="Max fan-out"></app-input>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <label for="s-flow-tokens">Token budget per flow</label>
              <div class="hint">Combined prompt + completion tokens a flow may spend.</div>
            </div>
            <div class="setting-control">
              <app-input type="number" id="s-flow-tokens" data-field="max_flow_tokens" min="1" aria-label="Token budget per flow"></app-input>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <label for="s-flow-timeout">Flow timeout (seconds)</label>
              <div class="hint">Wall-clock limit for a whole flow.</div>
            </div>
            <div class="setting-control">
              <app-input type="number" id="s-flow-timeout" data-field="flow_timeout_secs" min="1" aria-label="Flow timeout (seconds)"></app-input>
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
              <app-input type="url" id="s-registry-url" data-field="registry_url" data-allow-empty placeholder="https://registry.example.com" aria-label="OCI registry URL"></app-input>
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
              <div class="hint" id="s-idp-kind-hint">Select your enterprise IdP. SCIM provisioning is available once SSO is configured; directory sync is available for Microsoft Entra.</div>
            </div>
            <div class="setting-control">
              <app-select id="s-idp-kind" aria-label="Identity provider">
                <option value="">Not configured</option>
                <option value="entra">Microsoft Entra ID</option>
                <option value="okta">Okta</option>
              </app-select>
            </div>
          </div>
          <div id="sso-fields" hidden>
            <div class="setting-row">
              <div class="setting-info">
                <label for="s-oidc-issuer">Issuer URL</label>
                <div class="hint" id="s-issuer-hint">Your IdP's discovery base URL.</div>
              </div>
              <div class="setting-control">
                <app-input type="url" id="s-oidc-issuer" data-field="oidc_issuer_url" data-allow-empty aria-label="Issuer URL"></app-input>
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <label for="s-oidc-client-id">Client ID</label>
                <div class="hint" id="s-client-id-hint"></div>
              </div>
              <div class="setting-control">
                <app-input type="text" id="s-oidc-client-id" data-field="oidc_client_id" data-allow-empty aria-label="Client ID"></app-input>
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <label for="s-oidc-client-secret">Client secret</label>
                <!-- No data-allow-empty: the server treats an empty string as
                     "clear the secret" and an absent field as "leave it alone",
                     so a blank box must not be submitted. -->
                <div class="hint" id="s-oidc-secret-state">Write-only — leave blank to keep the stored secret.</div>
              </div>
              <div class="setting-control">
                <app-input type="password" reveal id="s-oidc-client-secret" data-field="oidc_client_secret" placeholder="unchanged" aria-label="Client secret"></app-input>
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <label for="s-oidc-redirect">Redirect URI</label>
                <div class="hint">Must match the URI registered in your IdP app exactly.</div>
              </div>
              <div class="setting-control">
                <app-input type="url" id="s-oidc-redirect" data-field="oidc_redirect_uri" data-allow-empty placeholder="${window.location.origin}/api/auth/oidc/callback" aria-label="Redirect URI"></app-input>
              </div>
            </div>
          </div>

          <div id="sso-status" hidden>
            <div class="setting-row">
              <div class="setting-info">
                <label>Status</label>
              </div>
              <div class="setting-control" id="s-sso-status-badges"></div>
            </div>
          </div>

          <div id="scim-section" hidden>
            <div class="scim-heading">SCIM provisioning</div>
            <div class="setting-row">
              <div class="setting-info">
                <label>Tenant URL</label>
                <div class="hint">Copy this URL into your IdP's SCIM provisioning "Tenant URL" field.</div>
              </div>
              <div class="setting-control">
                <div class="scim-endpoint-row">
                  <code id="s-scim-endpoint" class="scim-endpoint">${window.location.origin}/scim/v2</code>
                  <app-button id="btn-copy-scim-url" type="button" variant="tertiary" size="sm">Copy</app-button>
                </div>
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <label>Secret token</label>
                <div class="hint">Generate a bearer token and paste it into your IdP's SCIM "Secret Token" field. The token is shown only once — copy it immediately.</div>
              </div>
              <div class="setting-control">
                <app-button id="btn-generate-scim-token" type="button" variant="secondary" size="sm">Generate new token</app-button>
                <div id="s-scim-token-display" class="scim-token-display" hidden></div>
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <label>Active tokens</label>
              </div>
              <div class="setting-control">
                <div id="s-scim-token-list"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="save-bar">
       <app-button size="md" id="btn-save">Save changes</app-button>
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

    // The picker carries no `data-field` — #save reads it directly and sends
    // it as `provider_kind`, because it names the provider itself rather than
    // one of the `oidc_*` columns. See IDP_HINTS's comment.
    const idpSelect = this.querySelector('#s-idp-kind');
    idpSelect.addEventListener('change', () => this.#updateIdpFields(idpSelect.value));

    this.querySelector('#btn-generate-scim-token').addEventListener('click', () => this.#generateScimToken());
    this.querySelector('#btn-copy-scim-url').addEventListener('click', () => {
      navigator.clipboard.writeText(this.querySelector('#s-scim-endpoint').textContent);
      showToast('SCIM URL copied');
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
    // Two routes, two structs: general settings (oss/server/src/settings.rs)
    // and SSO (ee/server/src/sso_settings.rs) are unrelated on the wire, so
    // this page — which shows both in one form — has to fetch both. OSS has
    // no OIDC login route, hence no /settings/oidc to fetch; skip it there
    // rather than throwing and blanking the whole page. `oidc` additionally
    // carries the SSO tab's derived, read-only status fields (provider_kind,
    // oidc_configured, scim_enabled, directory_sync_enabled — see
    // sso_settings.rs's get_oidc_settings).
    const [s, oidc] = await Promise.all([
      call('fetchSettings'),
      callOptional('fetchOidcSettings'),
    ]);
    if (!s) return;
    this.#settings = { ...s, ...(oidc ?? {}) };
    this.querySelectorAll('[data-field]').forEach(el => {
      if (this.#settings[el.dataset.field] != null) el.value = this.#settings[el.dataset.field];
    });

    // The secret itself is never returned — only whether one is stored.
    const secretState = this.querySelector('#s-oidc-secret-state');
    secretState.textContent = oidc?.oidc_client_secret_configured
      ? 'A secret is stored. Leave blank to keep it, or enter a new one to replace it.'
      : 'No secret stored yet. SSO stays disabled until one is set.';

    // Pre-select the IdP picker from the stored provider_kind. The server now
    // sends ProviderKind::as_str (`"entra"`), matching this picker's own option
    // values; `"microsoft"` is only what the older, issuer-derived response
    // said, kept here so a UI built after the server is still correct against
    // one built before it.
    const idpSelect = this.querySelector('#s-idp-kind');
    const kind = oidc?.provider_kind === 'microsoft' ? 'entra' : oidc?.provider_kind;
    if (kind) {
      // <app-select> wraps a native <select> internally — .select gives
      // the inner element. Set value via the host's proxy setter; it works
      // regardless of whether the option exists (silently no-ops if not).
      idpSelect.value = kind;
    }
    this.#idpLocked = Boolean(oidc?.provider_locked);
    idpSelect.toggleAttribute('disabled', this.#idpLocked);
    if (this.#idpLocked) {
      this.querySelector('#s-idp-kind-hint').textContent =
        'Locked — the identity provider is set for this deployment. '
        + 'Changing it would strand every user and org unit already synced from '
        + `${IDP_LABELS[kind] ?? kind}. Credentials below can still be rotated.`;
    }
    // SSO fields must be visible whenever the server has a configuration
    // (oidc_configured), even if the provider_kind doesn't match one of the
    // picker's named options (e.g. "generic", "keycloak", "google"). The IdP
    // picker only switches hint text; it must not gate field visibility when
    // the server already has real values.
    this.#ssoConfigured = Boolean(oidc?.oidc_configured);
    this.#updateIdpFields(idpSelect.value);

    const statusEl = this.querySelector('#sso-status');
    const badges = this.querySelector('#s-sso-status-badges');
    statusEl.hidden = !this.#ssoConfigured;
    if (this.#ssoConfigured) {
      const providerName = IDP_LABELS[kind] ?? (kind || 'OIDC');
      badges.innerHTML = `
        <app-badge variant="success">SSO active (${providerName})</app-badge>
        ${oidc.scim_enabled ? '<app-badge variant="success">SCIM enabled</app-badge>' : ''}
        ${oidc.directory_sync_enabled ? '<app-badge variant="success">Directory sync</app-badge>' : ''}
      `;
    }

    // SCIM provisioning is available once SSO is configured — show it
    // regardless of which IdP was picked.
    this.querySelector('#scim-section').hidden = !this.#ssoConfigured;
    this.#loadScimTokens();
  }

  /** The IdP picker never writes a field (see IDP_HINTS) — it only toggles
   *  which hint text the fields show. Fields are visible when a provider is
   *  selected in the picker OR when the server reports SSO is already
   *  configured (so a "generic"/"keycloak" provider whose kind has no picker
   *  option still shows its stored values). SCIM visibility is driven
   *  separately by #load based on oidc_configured. */
  #updateIdpFields(kind) {
    this.querySelector('#sso-fields').hidden = !kind && !this.#ssoConfigured;

    const hints = IDP_HINTS[kind];
    this.querySelector('#s-issuer-hint').innerHTML = hints
      ? hints.issuer
      : "Your IdP's discovery base URL, e.g. <code>https://login.microsoftonline.com/&lt;tenant&gt;/v2.0</code>.";
    this.querySelector('#s-client-id-hint').textContent = hints?.clientId ?? '';
  }

  #generateScimToken() {
    const btn = this.querySelector('#btn-generate-scim-token');
    const display = this.querySelector('#s-scim-token-display');
    withLoading(btn, 'Generating…', async () => {
      try {
        const kind = this.querySelector('#s-idp-kind').value || 'default';
        const data = await postJson('/settings/scim/tokens', {
          provider: kind,
          description: 'Generated from settings page',
        });
        display.hidden = false;
        display.textContent = '';
        const label = document.createElement('strong');
        label.textContent = 'Token (copy now — shown only once):';
        const tokenLine = document.createElement('div');
        tokenLine.textContent = data.token;
        const copyBtn = document.createElement('app-button');
        copyBtn.setAttribute('type', 'button');
        copyBtn.setAttribute('variant', 'secondary');
        copyBtn.setAttribute('size', 'sm');
        copyBtn.textContent = 'Copy token';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(data.token);
          showToast('Token copied to clipboard');
        });
        display.append(label, tokenLine, copyBtn);
        showToast("SCIM token generated — copy it now, it won't be shown again");
        this.#loadScimTokens();
      } catch (err) {
        showToast(err.message || 'Failed to generate token');
      }
    })();
  }

  async #loadScimTokens() {
    const list = this.querySelector('#s-scim-token-list');
    let tokens;
    try {
      const data = await fetchApi('/settings/scim/tokens');
      tokens = (data.tokens || []).filter(t => !t.revoked_at);
    } catch {
      list.textContent = 'Failed to load tokens';
      return;
    }
    if (tokens.length === 0) {
      list.innerHTML = '<span class="scim-empty">No active tokens. Generate one above to enable SCIM provisioning.</span>';
      return;
    }
    list.innerHTML = tokens.map(t => {
      const created = new Date(t.created_at).toLocaleDateString();
      const lastUsed = t.last_used_at ? new Date(t.last_used_at).toLocaleDateString() : 'never';
      return `
        <div class="scim-token-row">
          <div>
            <strong>${t.description || 'Unnamed'}</strong>
            <div class="scim-token-meta">Created ${created} · Last used ${lastUsed} · Provider: ${t.provider}</div>
          </div>
          <app-button class="btn-revoke-token" type="button" variant="danger-secondary" size="sm" data-token-id="${t.id}">Revoke</app-button>
        </div>
      `;
    }).join('');
    list.querySelectorAll('.btn-revoke-token').forEach(btn => {
      btn.addEventListener('click', async () => {
        await deleteJson(`/settings/scim/tokens/${btn.dataset.tokenId}`);
        showToast('Token revoked');
        this.#loadScimTokens();
      });
    });
  }

  #save() {
    const btn = this.querySelector('#btn-save');
    withLoading(btn, 'Saving…', async () => {
      // Every control on this page maps to one of two unrelated structs on
      // the wire (see #load) — split by the oidc_ prefix and PUT each to its
      // own route, or a field silently lands nowhere (see the comment atop
      // this file: the server drops unknown keys and still reports success).
      const general = { ...this.#settings };
      const oidc = {};
      // Read-only / derived — GET-only fields the server has no PUT field for.
      delete general.oidc_client_secret_configured;
      delete general.provider_kind;
      delete general.provider_locked;
      delete general.oidc_configured;
      delete general.scim_enabled;
      delete general.directory_sync_enabled;
      this.querySelectorAll('[data-field]').forEach(el => {
        const v = el.value.trim();
        const target = el.dataset.field.startsWith('oidc_') ? oidc : general;
        // data-allow-empty fields round-trip '' so they can be cleared.
        if (v || el.hasAttribute('data-allow-empty')) {
          // <app-input> doesn't reflect `type` as a DOM property (only
          // `.value` proxies to its internal <input>), so the native-input
          // check `el.type === 'number'` never matched — every numeric field
          // round-tripped as a string, which the server's typed struct
          // (oss/server/src/settings.rs's SettingsUpdate) rejects with a 422.
          target[el.dataset.field] = el.getAttribute('type') === 'number' ? Number(v) : v;
        } else if (target === general) {
          delete general[el.dataset.field];
        }
      });
      for (const key of Object.keys(general)) {
        if (key.startsWith('oidc_')) delete general[key];
      }
      const idpKind = this.querySelector('#s-idp-kind').value;
      if (idpKind) oidc.provider_kind = idpKind;

      const calls = [call('saveSettings', general)];
      if (Object.keys(oidc).length) {
        calls.push(callOptional('saveOidcSettings', oidc));
      }
      await Promise.all(calls);
      showToast('Settings saved');
      // Reload so the SSO tab's derived status (provider_kind, badges, SCIM
      // section visibility) reflects what was just saved.
      this.#load();
    })();
  }
}

customElements.define('settings-page', SettingsPage);
