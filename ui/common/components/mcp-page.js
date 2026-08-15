/**
 * MCP gateway — one unified catalog of connectable services (platform
 * Composio toolkits ∪ custom MCP servers), upload-your-own servers, and
 * per-agent tool access.
 *
 * @element mcp-page
 * @note Data sources (all under /api/mcp, envelope {data, status_code, message}):
 *       `call('fetchMcpConnectors')` → GET /api/mcp/connectors
 *         → data = {created_by_you: [dto], shared_with_you: [dto], total}
 *       `call('fetchMcpToolkits')` → GET /api/mcp/composio/toolkits
 *         → data = {toolkits: [{connector_id, name, display_name, description,
 *           logo_url, auth_flow, tool_count, is_connected}], total}
 *       The catalog grid merges those two client-side rather than using
 *       GET /api/mcp/catalog: the catalog view has no is_connected, ownership,
 *       version, or owner_username, all of which the cards and tabs need.
 *       `call('fetchMcpMyUploads')` → GET /api/mcp/connectors/my-uploads
 *       plus register/probe/update/delete, credential + OAuth management,
 *       connect/disconnect (`/mcp/connect`, `/mcp/connections`),
 *       upload (zip/GitHub) + build status/logs, and the per-agent
 *       connector/tool-rule endpoints — see ui/oss/navigation.js.
 */
import styles from './mcp-page.css' with { type: 'css' };
import { icons } from '../utils/icons.js';
import { attachSlidingIndicator } from '../utils/tab-indicator.js';
import './app-modal.js';
import './app-skeleton.js';
import './app-module-nav.js';
import './autocomplete.js';
import { escHtml } from '/common/utils/escape.js';
import '/common/components/app-button.js';
import { call } from '../core/data-sources.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const AUTH_LABELS = {
  none: 'No auth',
  bearer: 'API key',
  basic: 'Basic',
  oauth2: 'OAuth 2.1',
  url_param: 'URL param',
};

// auth_type → connect flow for custom servers; mirrors `auth_flow_for` in
// oss/mcp-gateway/src/catalog.rs (toolkits carry auth_flow from the API).
const AUTH_FLOWS = { oauth2: 'oauth', bearer: 'api_key', basic: 'api_key', url_param: 'api_key' };

// Nav scopes filter the unified catalog grid. Ownership scopes apply to
// custom MCP servers only — Composio toolkits are platform-registered.
const CATALOG_SCOPES = {
  all: { filter: () => true, empty: '' },
  'created-by-you': {
    filter: (s) => s.kind === 'server' && !s.__shared,
    empty: 'You haven’t registered or uploaded any MCP servers yet',
  },
  'shared-with-me': {
    filter: (s) => s.kind === 'server' && s.__shared,
    empty: 'No MCP servers have been shared with you yet',
  },
  toolkits: {
    filter: (s) => s.kind === 'toolkit',
    empty: 'Platform-registered app toolkits (Gmail, Notion, …) show up here once an admin adds them',
  },
};

const CATALOG_TABS = [['all', 'All'], ['available', 'Available to connect'], ['connected', 'Connected']];

class McpPage extends HTMLElement {
  #initialized = false;
  #connectors = [];
  #toolkits = [];
  #uploads = [];
  #agents = [];
  #selectedAgentId = '';
  #agentConnectors = [];
  #agentTools = new Map(); // connector_id → [{name, description, stance}]
  #catalogScope = 'all'; // key into CATALOG_SCOPES
  #catalogTab = 'all'; // all | available | connected
  #connectTargetId = ''; // service awaiting an API key in the connect modal

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.innerHTML = `
      <app-module-nav module="mcp"></app-module-nav>
      <div class="page-head">
        <div>
          <h1 class="title-page">MCP gateway</h1>
          <p class="page-sub">Connect external MCP servers and control which agents can use their tools</p>
        </div>
        <div class="head-actions">
          <app-button variant="outline" id="upload-btn">${icons.upload('', 14)} Upload MCP server</app-button>
          <app-button variant="dark" id="register-btn">${icons.plus('', 14)} Register connector</app-button>
        </div>
      </div>

      <div id="catalog-section">
        <div class="tk-tabs" id="catalog-tabs" role="tablist" aria-hidden="true">
          <app-skeleton class="tk-skel-tab" height="0.9rem"></app-skeleton>
          <app-skeleton class="tk-skel-tab" height="0.9rem"></app-skeleton>
          <app-skeleton class="tk-skel-tab" height="0.9rem"></app-skeleton>
        </div>
        <div class="tk-grid" id="catalog-grid" aria-busy="true">${this.#catalogSkeletonCards()}</div>
      </div>

      <div id="uploads-section" hidden>
        <h2 class="section-title">My uploads</h2>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Name</th><th>Status</th><th>Message</th><th>Endpoint</th><th class="th-actions"></th>
            </tr></thead>
            <tbody id="uploads-tbody"></tbody>
          </table>
        </div>
        <div class="logs-panel" id="logs-panel" hidden>
          <div class="logs-head">
            <span class="logs-title">${icons.terminal('', 14)} Build logs — <span id="logs-name"></span></span>
            <app-button variant="icon" id="logs-close">${icons.x('', 14)}</app-button>
          </div>
          <pre id="logs-pre"></pre>
        </div>
      </div>

      <h2 class="section-title">Agent access</h2>
      <div class="agent-access-card">
        <div class="agent-picker">
          <label for="agent-select">Agent</label>
          <auto-complete id="agent-select" placeholder="Search agents…" aria-label="Agent"></auto-complete>
          <span class="agent-picker-hint">Choose which connectors this agent may call, and set per-tool allow/deny rules.</span>
        </div>
        <div id="agent-access-body">
          <div class="agent-access-empty">${icons.network('', 28)}<p>Select an agent to manage its connector access</p></div>
        </div>
      </div>

      ${this.#registerModalHtml()}
      ${this.#uploadModalHtml()}
      ${this.#connectModalHtml()}
      <app-modal heading="Connector" id="detail-modal" hide-footer>
        <div id="detail-body"></div>
      </app-modal>
    `;

    // Module tree nav: catalog scopes re-filter the unified grid; the other
    // rows scroll to their page block ("My uploads" only renders once uploads
    // exist — its row no-ops until then).
    this.addEventListener('module-nav-select', (e) => {
      const section = e.detail.section;
      if (CATALOG_SCOPES[section]) {
        this.#catalogScope = section;
        this.#catalogTab = 'all';
        this.#renderCatalog();
        // The catalog is the first section — return to the top so the page
        // head and tab strip stay in view alongside the filtered grid.
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const target = {
        uploads: '#uploads-section',
        'agent-access': '.agent-access-card',
      }[section];
      const el = target && this.querySelector(target);
      if (el && !el.hidden) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    this.querySelector('#register-btn').addEventListener('click', () => this.#openRegister());
    this.querySelector('#upload-btn').addEventListener('click', () => this.#openUpload());
    this.querySelector('#logs-close').addEventListener('click', () => {
      this.querySelector('#logs-panel').hidden = true;
    });
    const agentPicker = this.querySelector('#agent-select');
    agentPicker.filterFn = (query) => {
      const q = query.toLowerCase();
      return this.#agents
        .filter((a) => !q
          || (a.display_name || '').toLowerCase().includes(q)
          || (a.name || '').toLowerCase().includes(q))
        .map((a) => ({
          label: a.display_name || a.name,
          subtitle: a.name !== (a.display_name || a.name) ? a.name : (a.status || ''),
          value: a.id,
        }));
    };
    agentPicker.addEventListener('option-selected', (e) => {
      this.#selectedAgentId = e.detail.value;
      this.#loadAgentAccess();
    });
    // Clearing the input deselects the agent and returns to the empty state.
    agentPicker.addEventListener('input', () => {
      if (agentPicker.value.trim() === '' && this.#selectedAgentId) {
        this.#selectedAgentId = '';
        this.#loadAgentAccess();
      }
    });
    this.#wireRegisterModal();
    this.#wireUploadModal();
    this.#wireConnectModal();
    // Tab clicks are delegated — the tab strip re-renders after data loads.
    attachSlidingIndicator(this.querySelector('#catalog-tabs'), '.tk-tab', '.active');
    this.querySelector('#catalog-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.tk-tab');
      if (!tab) return;
      this.#catalogTab = tab.dataset.tab;
      this.#renderCatalog();
    });

    this.#load();
    this.#loadAgents();
  }

  // ── Data loading ─────────────────────────────────────────────────────────

  async #load() {
    let connResp;
    let uploadsResp;
    let toolkitsResp;
    try {
      [connResp, uploadsResp, toolkitsResp] = await Promise.all([
        call('fetchMcpConnectors'),
        call('fetchMcpMyUploads').catch(() => ({ data: [] })),
        call('fetchMcpToolkits').catch(() => ({ data: { toolkits: [] } })),
      ]);
    } catch (e) {
      console.error('MCP catalog fetch failed:', e);
      const tabs = this.querySelector('#catalog-tabs');
      tabs.hidden = true;
      tabs.innerHTML = '';
      const grid = this.querySelector('#catalog-grid');
      grid.removeAttribute('aria-busy');
      grid.innerHTML = `<div class="tk-msg">Failed to load connectable services</div>`;
      return;
    }
    const d = connResp?.data ?? {};
    this.#connectors = [
      ...(d.created_by_you || []),
      ...(d.shared_with_you || []).map((c) => ({ ...c, __shared: true })),
    ];
    this.#toolkits = toolkitsResp?.data?.toolkits || [];
    this.#uploads = uploadsResp?.data || [];
    this.#renderCatalog();
    this.#renderUploads();
  }

  async #loadAgents() {
    try {
      const resp = await call('fetchAgents', '', 1, 100);
      this.#agents = resp?.data || [];
    } catch {
      this.#agents = [];
    }
  }

  // ── Unified catalog (Composio toolkits ∪ custom MCP servers) ────────────

  /** Both kinds normalized into one card model, sorted by display name. */
  #services() {
    const toolkits = this.#toolkits.map((t) => ({ ...t, kind: 'toolkit' }));
    const servers = this.#connectors.map((c) => ({
      ...c,
      kind: 'server',
      auth_flow: AUTH_FLOWS[c.auth_type] || 'none',
    }));
    return [...toolkits, ...servers].sort((a, b) =>
      (a.display_name || a.name).localeCompare(b.display_name || b.name));
  }

  #findService(id) {
    return this.#services().find((s) => s.connector_id === id);
  }

  #catalogSkeletonCards() {
    return Array.from({ length: 6 }, () => `
      <div class="tk-card tk-card-skel" aria-hidden="true">
        <div class="tk-top">
          <app-skeleton class="tk-skel-logo" height="32px"></app-skeleton>
          <div class="tk-id">
            <app-skeleton class="tk-skel-name" height="20px"></app-skeleton>
            <app-skeleton class="tk-skel-chip" height="20px"></app-skeleton>
          </div>
          <app-skeleton class="tk-skel-btn" height="28px"></app-skeleton>
        </div>
        <app-skeleton lines="2"></app-skeleton>
      </div>`).join('');
  }

  #renderCatalog() {
    const tabs = this.querySelector('#catalog-tabs');
    const grid = this.querySelector('#catalog-grid');
    grid.removeAttribute('aria-busy');
    const scoped = this.#services().filter(CATALOG_SCOPES[this.#catalogScope].filter);

    if (!scoped.length) {
      tabs.hidden = true;
      tabs.innerHTML = '';
      grid.innerHTML = this.#catalogEmptyHtml();
      grid.querySelector('#empty-register-btn')
        ?.addEventListener('click', () => this.#openRegister());
      return;
    }

    const connected = scoped.filter((s) => s.is_connected);
    const counts = {
      all: scoped.length,
      available: scoped.length - connected.length,
      connected: connected.length,
    };
    tabs.hidden = false;
    tabs.removeAttribute('aria-hidden');
    tabs.innerHTML = CATALOG_TABS.map(([key, label]) => `
      <button class="tk-tab ${this.#catalogTab === key ? 'active' : ''}" type="button"
              role="tab" aria-selected="${this.#catalogTab === key}" data-tab="${key}">
        ${label}<span class="n">(${counts[key]})</span>
      </button>`).join('');

    const visible = {
      all: scoped,
      available: scoped.filter((s) => !s.is_connected),
      connected,
    }[this.#catalogTab] || scoped;
    grid.innerHTML = visible.length
      ? visible.map((s) => this.#serviceCardHtml(s)).join('')
      : `<div class="tk-msg">${this.#catalogTab === 'connected'
        ? 'Nothing connected yet'
        : 'Everything here is already connected'}</div>`;

    grid.querySelectorAll('.tk-card').forEach((card) => {
      const id = card.dataset.id;
      card.querySelector('.act-connect')
        ?.addEventListener('click', () => this.#connectService(id));
      card.querySelector('.act-disconnect')
        ?.addEventListener('click', () => this.#disconnectService(id));
      // Broken logo URLs fall back to the letter avatar underneath.
      card.querySelector('.tk-logo img')
        ?.addEventListener('error', (e) => e.target.remove());
      // Custom server cards open the existing detail/management modal.
      if (card.classList.contains('is-clickable')) {
        card.addEventListener('click', (e) => {
          if (!e.target.closest('button')) this.#openDetail(id);
        });
      }
    });
  }

  #catalogEmptyHtml() {
    if (this.#catalogScope !== 'all') {
      return `<div class="tk-msg">${escHtml(CATALOG_SCOPES[this.#catalogScope].empty)}</div>`;
    }
    return `
      <div class="empty-state">
        ${icons.network('', 32)}
        <h3>No connectable services yet</h3>
        <p>Register an external MCP server or upload your own to give agents new tools.</p>
        <app-button variant="dark" id="empty-register-btn">${icons.plus('', 14)} Register connector</app-button>
      </div>`;
  }

  #serviceCardHtml(s) {
    const name = s.display_name || s.name;
    const chips = [`<span class="tk-chip">${s.tool_count ?? 0} tools</span>`];
    if (s.version) chips.push(`<span class="tk-chip">${escHtml(s.version)}</span>`);
    if (s.__shared) {
      chips.push(`<span class="tk-by">shared by ${escHtml(s.owner_username || 'someone')}</span>`);
    }
    return `
      <div class="tk-card${s.kind === 'server' ? ' is-clickable' : ''}" data-id="${escHtml(s.connector_id)}">
        <div class="tk-top">
          <span class="tk-logo" aria-hidden="true">${escHtml(name.charAt(0))}${s.logo_url
            ? `<img src="${escHtml(s.logo_url)}" alt="" loading="lazy" />` : ''}</span>
          <div class="tk-id">
            <span class="tk-name" title="${escHtml(name)}">${escHtml(name)}</span>
            <span class="tk-chips">${chips.join('')}</span>
          </div>
          ${this.#serviceActionHtml(s, name)}
        </div>
        <p class="tk-desc">${escHtml(s.description || 'No description provided.')}</p>
      </div>`;
  }

  /** Connect/Connected button; uploads mid-build show their status instead. */
  #serviceActionHtml(s, name) {
    if (s.kind === 'server' && s.source_kind === 'uploaded_build') {
      if (s.build_status === 'pending' || s.build_status === 'building') {
        return `<span class="chip is-building">Building</span>`;
      }
      if (s.build_status === 'failed') return `<span class="chip is-error">Failed</span>`;
    }
    if (s.is_connected) {
      return `<button class="tk-action is-connected act-disconnect" type="button"
                title="Disconnect ${escHtml(name)}" aria-label="Disconnect ${escHtml(name)}">
          <span class="tk-rest">${icons.check('', 14)} Connected</span>
          <span class="tk-hover">${icons.x('', 14)} Disconnect</span>
        </button>`;
    }
    return `<button class="tk-action act-connect" type="button">${icons.plus('', 14)} Connect</button>`;
  }

  // ── Connect / disconnect (shared by toolkits and custom servers) ────────

  async #connectService(id) {
    const s = this.#findService(id);
    if (!s) return;
    if (s.auth_flow === 'api_key') {
      this.#openConnectModal(s);
      return;
    }
    try {
      const resp = await call('connectMcpService', { connector_id: id });
      this.#applyConnectOutcome(resp?.data);
    } catch (e) {
      alert(`Connect failed: ${e.message}`);
    }
  }

  /** @type {number|null} */
  #oauthPoll = null;

  #onWindowFocus = () => this.#load();

  /**
   * mcp-page was the only component in the polling inventory with a timer and no
   * teardown at all.
   */
  disconnectedCallback() {
    clearInterval(this.#oauthPoll);
    this.#oauthPoll = null;
    window.removeEventListener('focus', this.#onWindowFocus);
  }

  /** Connected → refresh; OAuth URL → popup, poll until it closes then reload. */
  #applyConnectOutcome(d) {
    const url = d?.oauth_url || d?.authorization_url;
    if (url) {
      const popup = window.open(url, 'mcp-oauth', 'width=600,height=720');
      if (popup) {
        // Tracked so teardown can clear it. The interval previously stopped only
        // when the popup was actually closed, so navigating away with it still
        // open left a 500ms timer calling #load() — a fetch plus a render into
        // detached DOM — for as long as the tab lived.
        clearInterval(this.#oauthPoll);
        this.#oauthPoll = setInterval(() => {
          if (popup.closed) {
            clearInterval(this.#oauthPoll);
            this.#oauthPoll = null;
            this.#load();
          }
        }, 500);
      } else {
        // Popup blocked — fall back to a one-shot focus listener, also tracked.
        window.addEventListener('focus', this.#onWindowFocus, { once: true });
      }
      return;
    }
    this.#load();
  }

  async #disconnectService(id) {
    const s = this.#findService(id);
    const name = s?.display_name || s?.name || id;
    if (!confirm(`Disconnect "${name}"? Agents lose access to its tools until you reconnect.`)) return;
    try {
      await call('disconnectMcpConnection', id);
      this.#load();
    } catch (e) {
      alert(`Disconnect failed: ${e.message}`);
    }
  }

  #connectModalHtml() {
    return `
      <app-modal heading="Connect" id="connect-modal">
        <div class="modal-form">
          <label>API key / token
            <input type="password" id="connect-cred-value" placeholder="API key / token" autocomplete="off" />
          </label>
          <div class="form-error" id="connect-error" hidden></div>
        </div>
        <div data-slot="footer">
          <app-button variant="outline" id="connect-cancel">Cancel</app-button>
          <app-button variant="dark" id="connect-submit">Connect</app-button>
        </div>
      </app-modal>`;
  }

  #wireConnectModal() {
    const modal = this.querySelector('#connect-modal');
    this.querySelector('#connect-cancel').addEventListener('click', () => modal.close());
    this.querySelector('#connect-submit').addEventListener('click', async () => {
      const value = this.querySelector('#connect-cred-value').value.trim();
      if (!value) return;
      const err = this.querySelector('#connect-error');
      err.hidden = true;
      try {
        const resp = await call('connectMcpService', {
          connector_id: this.#connectTargetId,
          credentials: { value },
        });
        modal.close();
        this.querySelector('#connect-cred-value').value = '';
        this.#applyConnectOutcome(resp?.data);
      } catch (e) {
        err.textContent = `Connect failed: ${e.message}`;
        err.hidden = false;
      }
    });
  }

  #openConnectModal(s) {
    this.#connectTargetId = s.connector_id;
    const modal = this.querySelector('#connect-modal');
    modal.setAttribute('heading', `Connect ${s.display_name || s.name}`);
    this.querySelector('#connect-cred-value').placeholder =
      s.auth_type === 'basic' ? 'username:password' : 'API key / token';
    modal.open();
  }

  async #deleteConnector(id) {
    const c = this.#connectors.find((x) => x.connector_id === id);
    if (!confirm(`Delete connector "${c?.display_name || c?.name || id}"? Agents will lose access to its tools.`)) return false;
    try {
      await call('deleteMcpConnector', id);
      this.#load();
      return true;
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
      return false;
    }
  }

  // ── Connector detail modal (custom servers) ──────────────────────────────

  #connectorStatus(c) {
    if (c.source_kind === 'uploaded_build') {
      if (c.build_status === 'pending' || c.build_status === 'building') {
        return { cls: 'is-building', label: 'Building' };
      }
      if (c.build_status === 'failed') return { cls: 'is-error', label: 'Failed' };
    }
    return c.is_active
      ? { cls: 'is-ok', label: 'Active' }
      : { cls: 'is-off', label: 'Inactive' };
  }

  async #openDetail(id) {
    const c = this.#connectors.find((x) => x.connector_id === id);
    if (!c) return;
    const modal = this.querySelector('#detail-modal');
    modal.setAttribute('heading', c.display_name || c.name);
    const body = this.querySelector('#detail-body');
    const st = this.#connectorStatus(c);
    body.innerHTML = `
      <div class="detail-meta">
        ${this.#metaRow('URL', c.url || '—')}
        ${this.#metaRow('Transport', c.transport || '—')}
        ${this.#metaRow('Auth type', AUTH_LABELS[c.auth_type] || c.auth_type || '—')}
        ${this.#metaRow('Tools', String(c.tool_count ?? 0))}
        ${this.#metaRow('Status', st.label)}
        ${c.version ? this.#metaRow('Version', c.version) : ''}
        ${c.__shared ? this.#metaRow('Shared by', c.owner_username || 'someone') : ''}
        ${c.description ? this.#metaRow('Description', c.description) : ''}
      </div>
      <div id="detail-auth-section">${c.auth_type && c.auth_type !== 'none' ? '<div class="detail-loading">Checking connection…</div>' : ''}</div>
      ${c.is_owner ? `
        <div class="detail-actions">
          <button class="btn-ghost danger" id="detail-delete" type="button">${icons.trash('', 14)} Delete connector</button>
        </div>` : ''}
    `;
    body.querySelector('#detail-delete')?.addEventListener('click', async () => {
      if (await this.#deleteConnector(id)) modal.close();
    });
    modal.open();
    if (c.auth_type === 'oauth2') this.#renderOauthSection(c);
    else if (c.auth_type && c.auth_type !== 'none') this.#renderCredentialSection(c);
  }

  #metaRow(label, value) {
    return `<div class="meta-row"><span class="meta-label">${escHtml(label)}</span><span class="meta-value">${escHtml(value)}</span></div>`;
  }

  async #renderCredentialSection(c) {
    const section = this.querySelector('#detail-auth-section');
    let connected = false;
    try {
      const resp = await call('fetchMcpCredentialStatus', c.connector_id);
      connected = !!resp?.data?.connected;
    } catch { /* leave disconnected */ }
    section.innerHTML = `
      <h4 class="detail-subtitle">${icons.key('', 14)} Credential</h4>
      <div class="cred-status">
        <span class="status"><span class="status-dot ${connected ? 'is-ok' : 'is-off'}"></span>${connected ? 'Credential set' : 'No credential set'}</span>
        ${connected ? `<button class="btn-ghost danger" id="cred-remove" type="button">Remove</button>` : ''}
      </div>
      <div class="cred-form">
        <input type="password" id="cred-value" placeholder="${c.auth_type === 'basic' ? 'username:password' : 'API key / token'}" />
        <app-button variant="dark" id="cred-save">${connected ? 'Replace' : 'Save'}</app-button>
      </div>
      <div class="form-error" id="cred-error" hidden></div>
    `;
    section.querySelector('#cred-save').addEventListener('click', async () => {
      const value = section.querySelector('#cred-value').value.trim();
      if (!value) return;
      const err = section.querySelector('#cred-error');
      err.hidden = true;
      try {
        const resp = await call('setMcpCredential', c.connector_id, value);
        if (resp?.data?.connected === false) {
          err.textContent = `Stored, but verification failed: ${resp.data.error || 'unknown error'}`;
          err.hidden = false;
        }
        this.#renderCredentialSection(c);
      } catch (e) {
        err.textContent = `Failed to save credential: ${e.message}`;
        err.hidden = false;
      }
    });
    section.querySelector('#cred-remove')?.addEventListener('click', async () => {
      try {
        await call('deleteMcpCredential', c.connector_id);
        this.#renderCredentialSection(c);
      } catch (e) {
        alert(`Remove failed: ${e.message}`);
      }
    });
  }

  async #renderOauthSection(c) {
    const section = this.querySelector('#detail-auth-section');
    let status = { authorized: false, expires_at: null };
    try {
      const resp = await call('fetchMcpOauthStatus', c.connector_id);
      status = resp?.data ?? status;
    } catch { /* leave unauthorized */ }
    const expiry = status.expires_at
      ? ` · expires ${new Date(status.expires_at).toLocaleString()}` : '';
    section.innerHTML = `
      <h4 class="detail-subtitle">${icons.shield('', 14)} OAuth 2.1</h4>
      <div class="cred-status">
        <span class="status"><span class="status-dot ${status.authorized ? 'is-ok' : 'is-off'}"></span>${status.authorized ? `Authorized${escHtml(expiry)}` : 'Not authorized'}</span>
        <span class="cred-actions">
          ${status.authorized
            ? `<button class="btn-ghost danger" id="oauth-revoke" type="button">Revoke</button>`
            : `<app-button variant="dark" id="oauth-authorize">${icons.externalLink('', 14)} Authorize</app-button>`}
        </span>
      </div>
      <div class="form-error" id="oauth-error" hidden></div>
    `;
    section.querySelector('#oauth-authorize')?.addEventListener('click', async () => {
      const err = section.querySelector('#oauth-error');
      err.hidden = true;
      try {
        const resp = await call('authorizeMcpOauth', c.connector_id);
        const url = resp?.data?.authorization_url;
        if (url) window.open(url, 'mcp-oauth', 'width=600,height=720');
      } catch (e) {
        err.textContent = `Authorization failed: ${e.message}`;
        err.hidden = false;
      }
    });
    section.querySelector('#oauth-revoke')?.addEventListener('click', async () => {
      try {
        await call('revokeMcpOauthToken', c.connector_id);
        this.#renderOauthSection(c);
      } catch (e) {
        alert(`Revoke failed: ${e.message}`);
      }
    });
  }

  // ── Register connector modal ─────────────────────────────────────────────

  #registerModalHtml() {
    return `
      <app-modal heading="Register connector" id="register-modal">
        <form id="register-form" class="modal-form">
          <label>Name
            <input name="name" required placeholder="github" autocomplete="off" />
          </label>
          <label>Display name
            <input name="display_name" placeholder="GitHub" autocomplete="off" />
          </label>
          <label>Server URL
            <div class="url-row">
              <input name="url" required type="url" placeholder="https://mcp.example.com/mcp" autocomplete="off" />
              <app-button variant="outline" id="probe-btn">${icons.search('', 14)} Probe</app-button>
            </div>
          </label>
          <div class="probe-result" id="probe-result" hidden></div>
          <label>Auth type
            <select name="auth_type" id="register-auth-type">
              <option value="none">No auth</option>
              <option value="bearer">API key (bearer)</option>
              <option value="basic">Basic auth</option>
              <option value="oauth2">OAuth 2.1</option>
              <option value="url_param">URL parameter</option>
            </select>
          </label>
          <div class="auth-fields" data-auth="bearer" hidden>
            <label>Credential header <span class="opt">(optional, default Authorization)</span>
              <input name="credential_header_name" placeholder="X-Api-Key" autocomplete="off" />
            </label>
          </div>
          <div class="auth-fields" data-auth="basic" hidden>
            <label>Username <input name="basic_username" autocomplete="off" /></label>
            <label>Password <input name="basic_password" type="password" autocomplete="off" /></label>
          </div>
          <div class="auth-fields" data-auth="oauth2" hidden>
            <label>OAuth client ID <span class="opt">(leave blank if the server supports DCR)</span>
              <input name="oauth_client_id" autocomplete="off" />
            </label>
            <label>OAuth client secret
              <input name="oauth_client_secret" type="password" autocomplete="off" />
            </label>
          </div>
          <div class="auth-fields" data-auth="url_param" hidden>
            <label>URL parameter name <input name="url_param_name" placeholder="api_key" autocomplete="off" /></label>
          </div>
          <label>Description
            <textarea name="description" rows="2" placeholder="What this server's tools do"></textarea>
          </label>
          <div class="form-error" id="register-error" hidden></div>
        </form>
        <div data-slot="footer">
          <app-button variant="outline" id="register-cancel">Cancel</app-button>
          <app-button variant="dark" id="register-submit">Register</app-button>
        </div>
      </app-modal>`;
  }

  #wireRegisterModal() {
    const modal = this.querySelector('#register-modal');
    const form = this.querySelector('#register-form');
    const authSelect = this.querySelector('#register-auth-type');
    const syncAuthFields = () => {
      modal.querySelectorAll('.auth-fields').forEach((el) => {
        el.hidden = el.dataset.auth !== authSelect.value;
      });
    };
    authSelect.addEventListener('change', syncAuthFields);

    this.querySelector('#probe-btn').addEventListener('click', async () => {
      const url = form.elements.url.value.trim();
      const result = this.querySelector('#probe-result');
      if (!url) return;
      result.hidden = false;
      result.className = 'probe-result';
      result.innerHTML = 'Probing…';
      try {
        const resp = await call('probeMcpConnector', url);
        const d = resp?.data ?? {};
        if (d.auth_type) {
          authSelect.value = d.auth_type;
          syncAuthFields();
        }
        result.className = 'probe-result is-ok';
        result.innerHTML = `${icons.checkCircle('', 14)} Detected auth: <strong>${escHtml(AUTH_LABELS[d.auth_type] || d.auth_type)}</strong>${d.hint ? ` — ${escHtml(d.hint)}` : ''}`;
      } catch (e) {
        result.className = 'probe-result is-error';
        result.innerHTML = `${icons.xCircle('', 14)} Probe failed: ${escHtml(e.message)}`;
      }
    });

    this.querySelector('#register-cancel').addEventListener('click', () => modal.close());
    this.querySelector('#register-submit').addEventListener('click', async () => {
      if (!form.reportValidity()) return;
      const err = this.querySelector('#register-error');
      err.hidden = true;
      const f = form.elements;
      const body = { name: f.name.value.trim(), url: f.url.value.trim(), auth_type: f.auth_type.value };
      for (const key of ['display_name', 'description', 'credential_header_name',
        'basic_username', 'basic_password', 'oauth_client_id', 'oauth_client_secret', 'url_param_name']) {
        const v = f[key].value.trim();
        if (v) body[key] = v;
      }
      try {
        await call('registerMcpConnector', body);
        modal.close();
        form.reset();
        this.querySelector('#probe-result').hidden = true;
        this.#load();
      } catch (e) {
        err.textContent = `Failed to register: ${e.message}`;
        err.hidden = false;
      }
    });
  }

  #openRegister() {
    this.querySelector('#register-modal').open();
  }

  // ── Upload MCP server modal ──────────────────────────────────────────────

  #uploadModalHtml() {
    return `
      <app-modal heading="Upload MCP server" id="upload-modal">
        <div class="upload-tabs" role="tablist">
          <button class="upload-tab is-active" data-tab="zip" type="button" role="tab">${icons.upload('', 14)} Upload zip</button>
          <button class="upload-tab" data-tab="github" type="button" role="tab">${icons.github('', 14)} From GitHub</button>
        </div>
        <form id="upload-zip-form" class="modal-form" data-pane="zip">
          <label>Name <input name="name" required placeholder="my-mcp-server" autocomplete="off" /></label>
          <label>Version tag <input name="version_tag" placeholder="v1" autocomplete="off" /></label>
          <label>Source archive (.zip)
            <input name="file" type="file" accept=".zip,application/zip" required />
          </label>
        </form>
        <form id="upload-github-form" class="modal-form" data-pane="github" hidden>
          <label>Name <input name="name" required placeholder="my-mcp-server" autocomplete="off" /></label>
          <label>Version tag <input name="version_tag" placeholder="v1" autocomplete="off" /></label>
          <label>GitHub repository URL
            <input name="github_url" required type="url" placeholder="https://github.com/org/repo" autocomplete="off" />
          </label>
        </form>
        <div class="form-error" id="upload-error" hidden></div>
        <div class="upload-queued" id="upload-queued" hidden></div>
        <div data-slot="footer">
          <app-button variant="outline" id="upload-cancel">Cancel</app-button>
          <app-button variant="dark" id="upload-submit">Queue build</app-button>
        </div>
      </app-modal>`;
  }

  #wireUploadModal() {
    const modal = this.querySelector('#upload-modal');
    let activeTab = 'zip';
    attachSlidingIndicator(modal.querySelector('.upload-tabs'), '.upload-tab', '.is-active');
    modal.querySelectorAll('.upload-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        activeTab = tab.dataset.tab;
        modal.querySelectorAll('.upload-tab').forEach((t) =>
          t.classList.toggle('is-active', t === tab));
        modal.querySelectorAll('[data-pane]').forEach((p) => {
          p.hidden = p.dataset.pane !== activeTab;
        });
      });
    });
    this.querySelector('#upload-cancel').addEventListener('click', () => modal.close());
    this.querySelector('#upload-submit').addEventListener('click', async () => {
      const err = this.querySelector('#upload-error');
      const queued = this.querySelector('#upload-queued');
      err.hidden = true;
      queued.hidden = true;
      try {
        let resp;
        if (activeTab === 'zip') {
          const form = this.querySelector('#upload-zip-form');
          if (!form.reportValidity()) return;
          const fd = new FormData();
          fd.append('name', form.elements.name.value.trim());
          fd.append('version_tag', form.elements.version_tag.value.trim() || 'v1');
          fd.append('file', form.elements.file.files[0]);
          resp = await call('uploadMcpServerZip', fd);
        } else {
          const form = this.querySelector('#upload-github-form');
          if (!form.reportValidity()) return;
          resp = await call('uploadMcpServerGithub', {
            name: form.elements.name.value.trim(),
            version_tag: form.elements.version_tag.value.trim() || 'v1',
            github_url: form.elements.github_url.value.trim(),
          });
        }
        queued.innerHTML = `${icons.checkCircle('', 14)} Build queued — connector <code>${escHtml(resp?.data?.connector_id || '')}</code>. Track progress under “My uploads”.`;
        queued.hidden = false;
        this.#load();
      } catch (e) {
        err.textContent = `Upload failed: ${e.message}`;
        err.hidden = false;
      }
    });
  }

  #openUpload() {
    this.querySelector('#upload-modal').open();
  }

  // ── My uploads ───────────────────────────────────────────────────────────

  #renderUploads() {
    const section = this.querySelector('#uploads-section');
    if (!this.#uploads.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const chipClass = { Active: 'is-ok', Deploying: 'is-building', Failed: 'is-error' };
    const tbody = this.querySelector('#uploads-tbody');
    tbody.innerHTML = this.#uploads.map((u) => {
      const info = u.upload_info || {};
      const cls = chipClass[info.upload_status] || 'is-off';
      return `
        <tr data-id="${escHtml(u.connector_id)}" data-name="${escHtml(u.connector_name)}">
          <td class="cell-name"><span class="name-main">${escHtml(u.connector_name)}</span></td>
          <td><span class="chip ${cls}">${escHtml(info.upload_status || 'Unknown')}</span></td>
          <td class="cell-muted">${escHtml(info.error_detail || info.status_message || '—')}</td>
          <td class="cell-url">${escHtml(u.url || '—')}</td>
          <td class="cell-actions">
            <app-button variant="icon" class="act-logs" title="Build logs">${icons.terminal('', 14)}</app-button>
          </td>
        </tr>`;
    }).join('');
    tbody.querySelectorAll('.act-logs').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tr = btn.closest('tr');
        this.#showBuildLogs(tr.dataset.id, tr.dataset.name);
      });
    });
  }

  async #showBuildLogs(connectorId, name) {
    const panel = this.querySelector('#logs-panel');
    panel.hidden = false;
    panel.scrollIntoView({ block: 'nearest' });
    this.querySelector('#logs-name').textContent = name;
    const pre = this.querySelector('#logs-pre');
    pre.textContent = 'Loading logs…';
    try {
      const resp = await call('fetchMcpBuildLogs', connectorId, 200);
      const logs = typeof resp?.data === 'string' ? resp.data : (resp?.data ?? '');
      pre.textContent = logs || '(no logs)';
    } catch (e) {
      pre.textContent = `Failed to load logs: ${e.message}`;
    }
  }

  // ── Agent access ─────────────────────────────────────────────────────────

  async #loadAgentAccess() {
    const body = this.querySelector('#agent-access-body');
    if (!this.#selectedAgentId) {
      body.innerHTML = `<div class="agent-access-empty">${icons.network('', 28)}<p>Select an agent to manage its connector access</p></div>`;
      return;
    }
    body.innerHTML = `<div class="detail-loading" aria-busy="true"><app-skeleton lines="3"></app-skeleton></div>`;
    try {
      const resp = await call('fetchAgentMcpConnectors', this.#selectedAgentId);
      this.#agentConnectors = resp?.data?.connectors || [];
    } catch (e) {
      body.innerHTML = `<div class="agent-access-empty"><p>Failed to load connector access: ${escHtml(e.message)}</p></div>`;
      return;
    }
    this.#agentTools = new Map();
    this.#renderAgentAccess();
  }

  #renderAgentAccess() {
    const body = this.querySelector('#agent-access-body');
    if (!this.#agentConnectors.length) {
      body.innerHTML = `<div class="agent-access-empty">${icons.cube('', 28)}<p>No connectors are available to this agent yet</p></div>`;
      return;
    }
    body.innerHTML = `
      <table class="agent-access-table">
        <thead><tr><th>Connector</th><th>Description</th><th>Enabled</th><th class="th-actions"></th></tr></thead>
        <tbody>
          ${this.#agentConnectors.map((c) => `
            <tr data-id="${escHtml(c.connector_id)}">
              <td class="cell-name"><span class="name-main">${escHtml(c.display_name || c.name)}</span></td>
              <td class="cell-muted">${escHtml(c.description || '—')}</td>
              <td>
                <label class="switch">
                  <input type="checkbox" class="access-toggle" ${c.enabled ? 'checked' : ''} />
                  <span class="slider"></span>
                </label>
              </td>
              <td class="cell-actions">
                <app-button variant="ghost" class="act-tools">${icons.chevronDown('', 14)} Tools</app-button>
              </td>
            </tr>
            <tr class="tools-row" data-for="${escHtml(c.connector_id)}" hidden>
              <td colspan="4"><div class="tools-editor" data-id="${escHtml(c.connector_id)}"></div></td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;

    body.querySelectorAll('.access-toggle').forEach((toggle) => {
      toggle.addEventListener('change', async () => {
        const id = toggle.closest('tr').dataset.id;
        try {
          await call('setAgentMcpConnectorAccess', this.#selectedAgentId, id, toggle.checked);
        } catch (e) {
          toggle.checked = !toggle.checked;
          alert(`Failed to update access: ${e.message}`);
        }
      });
    });
    body.querySelectorAll('.act-tools').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.closest('tr').dataset.id;
        const row = body.querySelector(`.tools-row[data-for="${CSS.escape(id)}"]`);
        row.hidden = !row.hidden;
        if (!row.hidden) this.#renderToolsEditor(id);
      });
    });
  }

  async #renderToolsEditor(connectorId) {
    const editor = this.querySelector(`.tools-editor[data-id="${CSS.escape(connectorId)}"]`);
    if (!editor) return;
    if (!this.#agentTools.has(connectorId)) {
      editor.innerHTML = `<div class="detail-loading" aria-busy="true"><app-skeleton lines="3"></app-skeleton></div>`;
      try {
        const resp = await call('fetchAgentMcpConnectorTools', this.#selectedAgentId, connectorId);
        this.#agentTools.set(connectorId, resp?.data?.tools || []);
      } catch (e) {
        editor.innerHTML = `<div class="form-error">Failed to load tools: ${escHtml(e.message)}</div>`;
        return;
      }
    }
    const tools = this.#agentTools.get(connectorId);
    if (!tools.length) {
      editor.innerHTML = `<div class="cell-muted tools-empty">This connector exposes no tools yet.</div>`;
      return;
    }
    editor.innerHTML = `
      <div class="tools-list">
        ${tools.map((t, i) => `
          <div class="tool-line">
            <div class="tool-info">
              <span class="tool-name">${escHtml(t.name)}</span>
              ${t.description ? `<span class="tool-desc">${escHtml(t.description)}</span>` : ''}
            </div>
            <select class="tool-stance" data-index="${i}">
              <option value="allow" ${t.stance !== 'deny' ? 'selected' : ''}>Allow</option>
              <option value="deny" ${t.stance === 'deny' ? 'selected' : ''}>Deny</option>
            </select>
          </div>`).join('')}
      </div>
      <div class="tools-actions">
        <span class="tools-save-status" hidden></span>
        <app-button variant="dark" class="tools-save">Save rules</app-button>
      </div>`;
    editor.querySelector('.tools-save').addEventListener('click', async () => {
      const rules = [...editor.querySelectorAll('.tool-stance')].map((sel) => ({
        connector_id: connectorId,
        tool_pattern: tools[Number(sel.dataset.index)].name,
        stance: sel.value,
      }));
      const statusEl = editor.querySelector('.tools-save-status');
      try {
        await call('saveAgentMcpToolRules', this.#selectedAgentId, rules);
        statusEl.textContent = 'Saved';
        statusEl.className = 'tools-save-status is-ok';
      } catch (e) {
        statusEl.textContent = `Save failed: ${e.message}`;
        statusEl.className = 'tools-save-status is-error';
      }
      statusEl.hidden = false;
    });
  }

}

customElements.define('mcp-page', McpPage);
