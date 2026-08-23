import { icons } from '../utils/icons.js';
import { escAttr, escHtml } from '../utils/escape.js';
import { fetchApi } from '../services/api.js';
import { showToast } from '../utils/toast.js';
import { confirmDialog } from '../design-system/app-modal/app-modal.js';
import { navigate } from '../core/router.js';
import styles from './mcp-detail-page.css' with { type: 'css' };
import '../design-system/app-button/app-button.js';
import '../design-system/app-input/app-input.js';
import '../design-system/app-select/app-select.js';
import '../design-system/app-skeleton/app-skeleton.js';
import '../design-system/app-switch/app-switch.js';
import '../design-system/app-tabs/app-tabs.js';
import '../design-system/auto-complete/auto-complete.js';
import { call } from '../core/data-sources.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const AUTH_LABELS = {
  none: 'No auth',
  bearer: 'API key',
  basic: 'Basic',
  oauth2: 'OAuth 2.1',
  url_param: 'URL param',
};

class McpDetailPage extends HTMLElement {
  #initialized = false;
  #connectorId = null;
  #connector = null;
  #tools = [];
  #agents = [];
  #selectedAgentId = '';
  #agentConnectors = [];
  #agentTools = new Map();

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#connectorId = new URLSearchParams(location.search).get('id');
    if (!this.#connectorId) {
      this.innerHTML = '<p style="padding:var(--s-32);color:var(--color-text-muted);">No connector ID specified</p>';
      return;
    }
    this.innerHTML = '<app-skeleton height="400px" style="max-width:900px;margin:0 auto;"></app-skeleton>';
    this.#load();
  }

  async #load() {
    try {
      const resp = await call('fetchMcpConnectorDetail', this.#connectorId);
      this.#connector = resp?.data ?? resp;
    } catch {
      this.#connector = null;
    }
    if (!this.#connector?.name && !this.#connector?.display_name) {
      this.innerHTML = '<p style="color:var(--color-error);padding:var(--s-32);">Connector not found</p>';
      return;
    }
    document.title = 'Nasiko - ' + (this.#connector.display_name || this.#connector.name);
    await this.#loadTools();
    this.#loadAgents();
    this.#render();
  }

  async #loadTools() {
    try {
      if (Array.isArray(this.#connector.tools)) {
        this.#tools = this.#connector.tools;
        return;
      }
      const resp = await fetchApi('/mcp/connectors/' + encodeURIComponent(this.#connectorId) + '/tools');
      this.#tools = resp?.data?.tools || resp?.data || [];
    } catch {
      this.#tools = [];
    }
  }

  async #loadAgents() {
    try {
      const resp = await call('fetchAgents', '', 1, 100);
      this.#agents = resp?.data || [];
    } catch {
      this.#agents = [];
    }
  }

  #connectorStatus(c) {
    if (c.source_kind === 'uploaded_build') {
      if (c.build_status === 'pending' || c.build_status === 'building') {
        return { cls: 'mdp-badge--building', label: 'Building' };
      }
      if (c.build_status === 'failed') return { cls: 'mdp-badge--failed', label: 'Failed' };
    }
    return c.is_active
      ? { cls: 'mdp-badge--active', label: 'Active' }
      : { cls: 'mdp-badge--inactive', label: 'Inactive' };
  }

  // ── Render ────────────────────────────────────────────────────────────────

  #render() {
    const c = this.#connector;
    const name = c.display_name || c.name;
    const st = this.#connectorStatus(c);
    const isOwner = !!c.is_owner;
    const isBuild = c.source_kind === 'uploaded_build';

    this.innerHTML = `
      <div class="mdp-page">
        <div class="mdp-topbar">
          <a class="mdp-back" href="/mcp">${icons.x('', 16)}</a>
        </div>

        <div class="mdp-header">
          <div class="mdp-title-row">
            <h1 class="mdp-name">${escHtml(name)}</h1>
            <span class="mdp-badge ${st.cls}"><span class="mdp-badge-dot"></span>${escHtml(st.label)}</span>
          </div>
          ${c.description ? '<p class="mdp-description">' + escHtml(c.description) + '</p>' : ''}
        </div>

        <app-tabs>
          ${this.#overviewPanelHtml(c)}
          ${this.#accessPanelHtml()}
          ${isBuild ? this.#logsPanelHtml() : ''}
          ${isOwner ? this.#settingsPanelHtml() : ''}
        </app-tabs>
      </div>
    `;

    this.#wireTabs();
    this.#wireAgentPicker();
    if (isOwner) this.#wireDeleteBtn();
    if (c.auth_type === 'oauth2') this.#renderOauthSection(c);
    else if (c.auth_type && c.auth_type !== 'none') this.#renderCredentialSection(c);
  }

  #wireTabs() {
    let logsLoaded = false;
    this.querySelector('app-tabs').addEventListener('tab-change', (e) => {
      if (e.detail.key === 'logs' && !logsLoaded) {
        logsLoaded = true;
        this.#loadLogs();
      }
    });
  }

  async #loadLogs() {
    const pre = this.querySelector('#mdp-logs-pre');
    if (!pre) return;
    try {
      const resp = await call('fetchMcpBuildLogs', this.#connectorId, 500);
      const logs = typeof resp?.data === 'string' ? resp.data : (resp?.data ?? '');
      pre.textContent = logs || '(no logs)';
    } catch (e) {
      pre.textContent = 'Failed to load logs: ' + e.message;
    }
  }

  // ── Overview panel ────────────────────────────────────────────────────────

  #overviewPanelHtml(c) {
    const items = [
      ['URL', c.url || '--'],
      ['Transport', c.transport || 'stdio'],
      ['Auth type', AUTH_LABELS[c.auth_type] || c.auth_type || '--'],
      ['Version', c.version || '--'],
      ['Source', c.source_kind === 'uploaded_build' ? 'Uploaded build' : 'Registered'],
      ['Owner', c.owner_username || '--'],
      ['Tools', String(c.tool_count ?? this.#tools.length)],
      ['Created', c.created_at ? new Date(c.created_at).toLocaleString() : '--'],
    ];
    return `
      <div class="mdp-panel" data-tab="overview" data-label="Overview">
        <div class="mdp-meta-grid">
          ${items.map(([label, value]) => '<div class="mdp-meta-item"><span class="mdp-meta-label">' + escHtml(label) + '</span><span class="mdp-meta-value">' + escHtml(value) + '</span></div>').join('')}
        </div>

        ${this.#toolsSectionHtml()}

        <div id="mdp-auth-section"></div>
      </div>`;
  }

  #toolsSectionHtml() {
    if (!this.#tools.length) {
      return '<div class="mdp-section"><h2 class="mdp-section-title">Tools (0)</h2><p class="mdp-muted">No tools discovered yet</p></div>';
    }
    return `
      <div class="mdp-section">
        <h2 class="mdp-section-title">Tools (${this.#tools.length})</h2>
        <div class="mdp-tools-grid">
          ${this.#tools.map((t) => '<div class="mdp-tool-card"><span class="mdp-tool-name">' + escHtml(t.name) + '</span>' + (t.description ? '<span class="mdp-tool-desc">' + escHtml(t.description) + '</span>' : '') + '</div>').join('')}
        </div>
      </div>`;
  }

  #logsPanelHtml() {
    return `
      <div class="mdp-panel" data-tab="logs" data-label="Logs">
        <div class="mdp-section">
          <pre class="mdp-logs-pre" id="mdp-logs-pre">Loading logs...</pre>
        </div>
      </div>`;
  }

  // ── Credential / OAuth ────────────────────────────────────────────────────

  async #renderCredentialSection(c) {
    const section = this.querySelector('#mdp-auth-section');
    if (!section) return;
    let connected = false;
    try {
      const resp = await call('fetchMcpCredentialStatus', c.connector_id);
      connected = !!resp?.data?.connected;
    } catch { /* leave disconnected */ }
    section.innerHTML = `
      <div class="mdp-section">
        <h2 class="mdp-section-title">${icons.key('', 16)} Credential</h2>
        <div class="mdp-cred-row">
          <span class="mdp-status-dot ${connected ? 'is-ok' : 'is-off'}"></span>
          <span>${connected ? 'Credential set' : 'No credential set'}</span>
          ${connected ? '<app-button variant="danger-secondary" size="sm" id="mdp-cred-remove">Remove</app-button>' : ''}
        </div>
        <div class="mdp-cred-form">
          <app-input type="password" id="mdp-cred-value" class="mdp-cred-input"
            aria-label="Credential"
            placeholder="${c.auth_type === 'basic' ? 'username:password' : 'API key / token'}"></app-input>
          <app-button variant="primary" size="sm" id="mdp-cred-save">${connected ? 'Replace' : 'Save'}</app-button>
        </div>
        <p class="form-error" id="mdp-cred-error" hidden></p>
      </div>`;
    section.querySelector('#mdp-cred-save').addEventListener('click', async () => {
      const value = section.querySelector('#mdp-cred-value').value.trim();
      if (!value) return;
      const err = section.querySelector('#mdp-cred-error');
      err.hidden = true;
      try {
        const resp = await call('setMcpCredential', c.connector_id, value);
        if (resp?.data?.connected === false) {
          err.textContent = 'Stored, but verification failed: ' + (resp.data.error || 'unknown error');
          err.hidden = false;
        }
        this.#renderCredentialSection(c);
      } catch (e) {
        err.textContent = 'Failed to save: ' + e.message;
        err.hidden = false;
      }
    });
    section.querySelector('#mdp-cred-remove')?.addEventListener('click', async () => {
      try {
        await call('deleteMcpCredential', c.connector_id);
        this.#renderCredentialSection(c);
      } catch (e) { showToast('Remove failed: ' + e.message); }
    });
  }

  async #renderOauthSection(c) {
    const section = this.querySelector('#mdp-auth-section');
    if (!section) return;
    let status = { authorized: false, expires_at: null };
    try {
      const resp = await call('fetchMcpOauthStatus', c.connector_id);
      status = resp?.data ?? status;
    } catch { /* leave unauthorized */ }
    const expiry = status.expires_at ? ' - expires ' + new Date(status.expires_at).toLocaleString() : '';
    section.innerHTML = `
      <div class="mdp-section">
        <h2 class="mdp-section-title">${icons.shield('', 16)} OAuth 2.1</h2>
        <div class="mdp-cred-row">
          <span class="mdp-status-dot ${status.authorized ? 'is-ok' : 'is-off'}"></span>
          <span>${status.authorized ? 'Authorized' + escHtml(expiry) : 'Not authorized'}</span>
          ${status.authorized
            ? '<app-button variant="danger-secondary" size="sm" id="mdp-oauth-revoke">Revoke</app-button>'
            : '<app-button variant="primary" size="sm" id="mdp-oauth-authorize">' + icons.externalLink() + ' Authorize</app-button>'}
        </div>
        <p class="form-error" id="mdp-oauth-error" hidden></p>
      </div>`;
    section.querySelector('#mdp-oauth-authorize')?.addEventListener('click', async () => {
      const err = section.querySelector('#mdp-oauth-error');
      err.hidden = true;
      try {
        const resp = await call('authorizeMcpOauth', c.connector_id);
        const url = resp?.data?.authorization_url;
        if (url) window.open(url, 'mcp-oauth', 'width=600,height=720');
      } catch (e) {
        err.textContent = 'Authorization failed: ' + e.message;
        err.hidden = false;
      }
    });
    section.querySelector('#mdp-oauth-revoke')?.addEventListener('click', async () => {
      try {
        await call('revokeMcpOauthToken', c.connector_id);
        this.#renderOauthSection(c);
      } catch (e) { showToast('Revoke failed: ' + e.message); }
    });
  }

  // ── Access & security panel ───────────────────────────────────────────────

  #accessPanelHtml() {
    return `
      <div class="mdp-panel" data-tab="access" data-label="Access &amp; security">
        <div class="mdp-section">
          <h2 class="mdp-section-title">Agent access</h2>
          <p class="mdp-muted">Select an agent to manage its access to this connector and set per-tool allow/block rules</p>
          <div class="mdp-agent-picker">
            <auto-complete id="mdp-agent-select" placeholder="Search agents..." aria-label="Agent"></auto-complete>
          </div>
          <div id="mdp-agent-access-body">
            <div class="mdp-empty">${icons.network('', 28)}<p>Select an agent above</p></div>
          </div>
        </div>
      </div>`;
  }

  #wireAgentPicker() {
    const picker = this.querySelector('#mdp-agent-select');
    if (!picker) return;
    picker.filterFn = (query) => {
      const q = query.toLowerCase();
      return this.#agents
        .filter((a) => !q || (a.display_name || '').toLowerCase().includes(q) || (a.name || '').toLowerCase().includes(q))
        .map((a) => ({
          label: a.display_name || a.name,
          subtitle: a.name !== (a.display_name || a.name) ? a.name : (a.status || ''),
          value: a.id,
        }));
    };
    picker.addEventListener('option-selected', (e) => {
      this.#selectedAgentId = e.detail.value;
      this.#loadAgentAccess();
    });
    picker.addEventListener('input', () => {
      if (picker.value.trim() === '' && this.#selectedAgentId) {
        this.#selectedAgentId = '';
        const body = this.querySelector('#mdp-agent-access-body');
        if (body) body.innerHTML = '<div class="mdp-empty">' + icons.network('', 28) + '<p>Select an agent above</p></div>';
      }
    });
  }

  async #loadAgentAccess() {
    const body = this.querySelector('#mdp-agent-access-body');
    if (!body || !this.#selectedAgentId) return;
    body.innerHTML = '<app-skeleton lines="3" style="padding:var(--s-16)"></app-skeleton>';
    try {
      const resp = await call('fetchAgentMcpConnectors', this.#selectedAgentId);
      this.#agentConnectors = resp?.data?.connectors || [];
    } catch (e) {
      body.innerHTML = '<div class="mdp-empty"><p>Failed to load: ' + escHtml(e.message) + '</p></div>';
      return;
    }
    this.#agentTools = new Map();
    const match = this.#agentConnectors.find((c) => c.connector_id === this.#connectorId);
    this.#renderAgentAccess(match);
  }

  #renderAgentAccess(match) {
    const body = this.querySelector('#mdp-agent-access-body');
    if (!body) return;
    const enabled = match ? !!match.enabled : false;
    body.innerHTML = `
      <div class="mdp-access-row">
        <app-switch class="mdp-access-toggle" aria-label="Connector access"
          ${enabled ? 'checked' : ''}></app-switch>
        <span>${enabled ? 'Enabled' : 'Disabled'}</span>
      </div>
      ${enabled ? '<app-button variant="ghost" size="sm" id="mdp-tools-toggle">' + icons.chevronDown() + ' Tool rules</app-button><div id="mdp-tools-editor" hidden></div>' : ''}`;

    body.querySelector('.mdp-access-toggle')?.addEventListener('change', async (e) => {
      try {
        await call('setAgentMcpConnectorAccess', this.#selectedAgentId, this.#connectorId, e.target.checked);
        this.#loadAgentAccess();
      } catch (err) {
        e.target.checked = !e.target.checked;
        showToast('Failed to update access: ' + err.message);
      }
    });

    body.querySelector('#mdp-tools-toggle')?.addEventListener('click', () => {
      const editor = body.querySelector('#mdp-tools-editor');
      if (!editor) return;
      editor.hidden = !editor.hidden;
      if (!editor.hidden) this.#renderToolsEditor();
    });
  }

  async #renderToolsEditor() {
    const editor = this.querySelector('#mdp-tools-editor');
    if (!editor) return;
    if (!this.#agentTools.has(this.#connectorId)) {
      editor.innerHTML = '<app-skeleton lines="3"></app-skeleton>';
      try {
        const resp = await call('fetchAgentMcpConnectorTools', this.#selectedAgentId, this.#connectorId);
        this.#agentTools.set(this.#connectorId, resp?.data?.tools || []);
      } catch (e) {
        editor.innerHTML = '<p class="form-error">Failed to load tools: ' + escHtml(e.message) + '</p>';
        return;
      }
    }
    const tools = this.#agentTools.get(this.#connectorId);
    if (!tools.length) {
      editor.innerHTML = '<p class="mdp-muted">No tools to configure</p>';
      return;
    }
    editor.innerHTML = `
      <div class="mdp-tools-list">
        ${tools.map((t, i) => '<div class="mdp-tool-line"><div class="mdp-tool-info"><span class="mdp-tool-info-name">' + escHtml(t.name) + '</span>' + (t.description ? '<span class="mdp-tool-info-desc">' + escHtml(t.description) + '</span>' : '') + '</div><app-select class="mdp-tool-stance" size="sm" data-index="' + i + '" aria-label="Tool rule for ' + escAttr(t.name) + '" options=\'[{"value":"allow","label":"Allow"},{"value":"block","label":"Block"}]\' value="' + (t.stance === 'block' ? 'block' : 'allow') + '"></app-select></div>').join('')}
      </div>
      <div class="mdp-tools-actions">
        <span class="mdp-save-status" id="mdp-save-status" hidden></span>
        <app-button variant="primary" size="sm" id="mdp-save-rules">Save rules</app-button>
      </div>`;
    editor.querySelector('#mdp-save-rules').addEventListener('click', async () => {
      const rules = [...editor.querySelectorAll('.mdp-tool-stance')].map((sel) => ({
        connector_id: this.#connectorId,
        tool_pattern: tools[Number(sel.dataset.index)].name,
        stance: sel.value,
      }));
      const statusEl = editor.querySelector('#mdp-save-status');
      try {
        await call('saveAgentMcpToolRules', this.#selectedAgentId, rules);
        statusEl.textContent = 'Saved';
        statusEl.className = 'mdp-save-status is-ok';
      } catch (e) {
        statusEl.textContent = 'Save failed: ' + e.message;
        statusEl.className = 'mdp-save-status is-error';
      }
      statusEl.hidden = false;
    });
  }

  // ── Settings panel ────────────────────────────────────────────────────────

  #settingsPanelHtml() {
    return `
      <div class="mdp-panel" data-tab="settings" data-label="Settings">
        <div class="mdp-section mdp-danger">
          <h3 class="mdp-danger-title">Danger zone</h3>
          <p class="mdp-muted">Deleting this connector removes it and revokes all agent access</p>
          <app-button variant="danger-secondary" size="sm" id="mdp-delete-btn">${icons.trash()} Delete connector</app-button>
        </div>
      </div>`;
  }

  #wireDeleteBtn() {
    this.querySelector('#mdp-delete-btn')?.addEventListener('click', async () => {
      const name = this.#connector.display_name || this.#connector.name;
      const confirmed = await confirmDialog({
        title: 'Delete ' + name,
        message: 'This removes the connector and revokes all agent access. This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await call('deleteMcpConnector', this.#connectorId);
        navigate('/mcp');
      } catch (e) {
        showToast('Failed to delete: ' + e.message);
      }
    });
  }

}

customElements.define('mcp-detail-page', McpDetailPage);