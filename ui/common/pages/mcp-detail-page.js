import { icons } from '../utils/icons.js';
import { escAttr, escHtml } from '../utils/escape.js';
import { fetchApi } from '../services/api.js';
import { showToast } from '../utils/toast.js';
import { confirmDialog } from '../design-system/app-modal/app-modal.js';
import { navigate } from '../core/router.js';
import { attachSlidingIndicator } from '../utils/tab-indicator.js';
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./mcp-detail-page.css', import.meta.url));
import '../design-system/app-badge/app-badge.js';
import '../design-system/app-button/app-button.js';
import '../design-system/app-empty-state/app-empty-state.js';
import '../design-system/app-grid/app-grid.js';
import '../design-system/app-input/app-input.js';
import '../design-system/app-skeleton/app-skeleton.js';
import '../design-system/app-search/app-search.js';
import '../design-system/app-table/app-table.js';
import '../design-system/app-tabs/app-tabs.js';
import '../design-system/app-tag/app-tag.js';
import { call } from '../core/data-sources.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

// Team/department grants are EE-only routes; the tabs and chips for them are
// hidden unless the running edition actually serves the org hierarchy.
const GRANT_TYPES = [
  { key: 'user', label: 'User', eeOnly: false },
  { key: 'team', label: 'Team', eeOnly: true },
  { key: 'department', label: 'Department', eeOnly: true },
];
/** grant type -> both the API path segment and the grantee tab key. */
const GRANT_PATHS = { user: 'users', team: 'teams', department: 'departments' };

const fmtDate = (v) => (v ? new Date(v).toLocaleDateString() : '');

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
  // Grants state
  #grants = null;
  #isEe = null;
  #granteeTab = 'users';
  #grantFilter = '';
  #grantType = 'user';
  #grantPicked = null;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#connectorId = new URLSearchParams(location.search).get('id');
    if (!this.#connectorId) {
      this.innerHTML = `<app-empty-state title="No connector specified" icon='${icons.alertTriangle('', 40)}'></app-empty-state>`;
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
      this.innerHTML = `<app-empty-state title="Connector not found" description="It may have been deleted, or you no longer have access to it." icon='${icons.alertTriangle('', 40)}'></app-empty-state>`;
      return;
    }
    document.title = 'Nasiko - ' + (this.#connector.display_name || this.#connector.name);
    await this.#loadTools();
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

  #connectorStatus(c) {
    if (c.source_kind === 'uploaded_build') {
      if (c.build_status === 'pending' || c.build_status === 'building') {
        return { variant: 'info', label: 'Building' };
      }
      if (c.build_status === 'failed') return { variant: 'error', label: 'Failed' };
    }
    return c.is_active
      ? { variant: 'success', label: 'Active' }
      : { variant: 'neutral', label: 'Inactive' };
  }

  // ── Render ────────────────────────────────────────────────────────────────

  #render() {
    const c = this.#connector;
    const name = c.display_name || c.name;
    const st = this.#connectorStatus(c);
    const isOwner = !!c.is_owner;
    const isBuild = c.source_kind === 'uploaded_build';

    this.innerHTML = `
      <div class="mdp-topbar">
        <app-button variant="tertiary" icon-only href="/mcp"
          aria-label="Back to MCP servers">${icons.arrowLeft()}</app-button>
      </div>

      <div class="mdp-header">
        <div class="mdp-title-row">
          <h1 class="mdp-name">${escHtml(name)}</h1>
          <app-badge dot variant="${st.variant}">${escHtml(st.label)}</app-badge>
        </div>
        ${c.description ? '<p class="mdp-description">' + escHtml(c.description) + '</p>' : ''}
      </div>

      <app-tabs>
        ${this.#overviewPanelHtml(c)}
        ${this.#accessPanelHtml()}
        ${isBuild ? this.#logsPanelHtml() : ''}
      </app-tabs>
      ${this.#grantModalHtml()}
    `;

    this.#wireTabs();
    this.#wireGrantModal();
    this.#loadGrants();
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
        <app-grid class="mdp-meta-grid" min-width="280px" gap="md">
          ${items.map(([label, value]) => '<div class="mdp-meta-item"><span class="mdp-meta-label">' + escHtml(label) + '</span><span class="mdp-meta-value">' + escHtml(value) + '</span></div>').join('')}
        </app-grid>

        ${this.#toolsSectionHtml()}

        <div id="mdp-auth-section"></div>

        ${c.is_owner ? this.#dangerZoneHtml() : ''}
      </div>`;
  }

  #toolsSectionHtml() {
    if (!this.#tools.length) {
      return '<div class="mdp-section"><h2 class="mdp-section-title">Tools (0)</h2><p class="mdp-muted">No tools discovered yet</p></div>';
    }
    return `
      <div class="mdp-section">
        <h2 class="mdp-section-title">Tools (${this.#tools.length})</h2>
        <app-grid min-width="260px" gap="md">
          ${this.#tools.map((t) => '<div class="tile"><span class="mdp-tool-name">'
            + escHtml(t.name) + '</span>'
            + (t.description ? '<span class="mdp-tool-desc">' + escHtml(t.description) + '</span>' : '')
            + '</div>').join('')}
        </app-grid>
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
          <app-badge dot variant="${connected ? 'success' : 'neutral'}">${connected ? 'Credential set' : 'No credential set'}</app-badge>
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
          <app-badge dot variant="${status.authorized ? 'success' : 'neutral'}">${status.authorized ? 'Authorized' + escHtml(expiry) : 'Not authorized'}</app-badge>
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
        <div class="mdp-section" id="mdp-grants-section" hidden></div>
      </div>`;
  }

  // ── Grants ────────────────────────────────────────────────────────────────

  /**
   * `GET /consumers` is owner/admin-gated, so a failure here means this caller
   * simply may not manage sharing — the section stays hidden rather than
   * showing an error box on a tab they can still read the agent half of.
   */
  async #loadGrants() {
    const section = this.querySelector('#mdp-grants-section');
    if (!section) return;
    let data;
    try {
      const resp = await fetchApi(
        '/mcp/connectors/' + encodeURIComponent(this.#connectorId) + '/consumers');
      data = resp?.data ?? resp;
    } catch {
      section.hidden = true;
      return;
    }
    this.#grants = {
      users: data?.users || [],
      teams: data?.teams || [],
      departments: data?.departments || [],
    };
    // `/consumers` answers with empty team/department arrays in OSS too, so it
    // can't tell the editions apart — probe an org route that only EE mounts.
    // Existence is the whole signal, so don't read the body: EE answers /teams
    // with a bare `{teams, total}` (no `data` envelope), and unwrapping it was
    // what made every EE deployment look like OSS and hid both tabs.
    if (this.#isEe === null) this.#isEe = await this.#routeExists('/teams');
    if (!this.#isEe) this.#granteeTab = 'users';
    section.hidden = false;
    this.#renderGrants();
  }

  /**
   * False when the route is absent (OSS) *or* forbidden — `/teams` needs team
   * lead or above, and a caller below that can't search teams to grant to one
   * either, so hiding the tab matches what they can actually do.
   */
  async #routeExists(path) {
    try {
      await fetchApi(path);
      return true;
    } catch {
      return false;
    }
  }

  #granteeTabDefs() {
    const defs = [];
    if (this.#isEe) {
      defs.push({ key: 'departments', label: 'Departments' }, { key: 'teams', label: 'Teams' });
    }
    defs.push({ key: 'users', label: 'Users' });
    return defs;
  }

  #renderGrants() {
    const section = this.querySelector('#mdp-grants-section');
    if (!section) return;
    const defs = this.#granteeTabDefs();
    section.innerHTML = `
      <div class="mdp-grants-head">
        <div>
          <h2 class="mdp-section-title">Grants</h2>
          <p class="mdp-muted">Who this server is shared with.${this.#isEe ? ' Members of a granted team or department inherit access automatically.' : ''}</p>
        </div>
        <app-button variant="primary" id="mdp-grant-open">${icons.plus('', 14)} Grant access</app-button>
      </div>
      <app-search id="mdp-grant-filter" size="sm" class="mdp-grants-search"
        placeholder="Search ${defs.map((d) => d.label.toLowerCase()).join(', ')}"
        aria-label="Search grants"
        value="${escAttr(this.#grantFilter)}" autocomplete="off"></app-search>
      <div class="mdp-subtabs" id="mdp-grantee-tabs">
        ${defs.map((d) => `<button type="button" class="mdp-subtab${d.key === this.#granteeTab ? ' is-active' : ''}" data-grantee-tab="${d.key}">${d.label}</button>`).join('')}
      </div>
      <app-table id="mdp-grants-table" pagination="none" limit="5"></app-table>`;

    const filter = section.querySelector('#mdp-grant-filter');
    filter.addEventListener('input', () => {
      this.#grantFilter = filter.value;
      this.#syncGrantsTable();
    });
    const tabs = section.querySelector('#mdp-grantee-tabs');
    attachSlidingIndicator(tabs, '.mdp-subtab', '.is-active', { pill: true });
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-grantee-tab]');
      if (!btn) return;
      this.#granteeTab = btn.dataset.granteeTab;
      tabs.querySelectorAll('.mdp-subtab').forEach((t) =>
        t.classList.toggle('is-active', t.dataset.granteeTab === this.#granteeTab));
      this.#syncGrantsTable();
    });
    section.querySelector('#mdp-grant-open').addEventListener('click', () => this.#openGrantModal());
    // Delegated: <app-table> rebuilds its rows on every sort and refresh, so a
    // per-button listener would not survive the first column click.
    section.querySelector('#mdp-grants-table').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-revoke-kind]');
      if (btn) this.#revokeGrant(btn.dataset.revokeKind, btn.dataset.revokeId, btn.dataset.revokeName);
    });
    this.#syncGrantsTable();
  }

  #syncGrantsTable() {
    const table = this.querySelector('#mdp-grants-table');
    if (!table) return;
    const label = this.#granteeTabDefs().find((d) => d.key === this.#granteeTab)?.label || 'entries';
    const { columns, rows } = this.#grantsTableView();
    table.setAttribute('empty-message',
      `No ${label.toLowerCase()} have access yet. Use Grant access to share this server.`);
    table.columns = columns;
    table.dataFn = () => rows;
    table.refresh();
  }

  #grantsTableView() {
    const matches = (name) => {
      const q = this.#grantFilter.trim().toLowerCase();
      return !q || (name || '').toLowerCase().includes(q);
    };
    const dash = (v) => (v === null || v === undefined || v === '' ? '—' : escHtml(String(v)));
    if (this.#granteeTab === 'users') {
      return {
        columns: [
          { key: 'name', label: 'User' },
          { key: 'granted_by', label: 'Granted by', render: dash },
          { key: 'granted', label: 'Granted', render: dash },
          { key: 'actions', label: '', render: (_v, r) => this.#revokeBtnHtml('user', r.id, r.name) },
        ],
        rows: (this.#grants?.users || [])
          .map((u) => ({
            id: u.user_id,
            name: u.display_name || u.username || u.user_id,
            granted_by: u.granted_by_username || '',
            granted: fmtDate(u.created_at),
          }))
          .filter((r) => matches(r.name)),
      };
    }
    const kind = this.#granteeTab === 'teams' ? 'team' : 'department';
    return {
      columns: [
        { key: 'name', label: kind === 'team' ? 'Team' : 'Department' },
        { key: 'granted', label: 'Granted', render: dash },
        { key: 'actions', label: '', render: (_v, r) => this.#revokeBtnHtml(kind, r.id, r.name) },
      ],
      rows: (this.#grants?.[this.#granteeTab] || [])
        .map((t) => ({ id: t.id, name: t.name, granted: fmtDate(t.created_at) }))
        .filter((r) => matches(r.name)),
    };
  }

  #revokeBtnHtml(kind, id, name) {
    return `<app-button variant="ghost-danger" size="sm" icon-only data-revoke-kind="${kind}"
      data-revoke-id="${escAttr(id)}" data-revoke-name="${escAttr(name)}"
      title="Revoke access for ${escAttr(name)}"
      aria-label="Revoke access for ${escAttr(name)}">${icons.trash()}</app-button>`;
  }

  async #revokeGrant(kind, granteeId, name) {
    const confirmed = await confirmDialog({
      title: 'Revoke access',
      message: `Revoke access for <strong>${escHtml(name || 'this grantee')}</strong>? They lose access to this MCP server.`,
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await fetchApi(this.#grantPath(kind, granteeId), { method: 'DELETE' });
      showToast('Access revoked');
    } catch (e) {
      showToast('Failed to revoke: ' + e.message);
      return;
    }
    this.#loadGrants();
  }

  #grantPath(kind, granteeId) {
    return '/mcp/connectors/' + encodeURIComponent(this.#connectorId)
      + '/grants/' + GRANT_PATHS[kind] + '/' + encodeURIComponent(granteeId);
  }

  // ── Grant modal ───────────────────────────────────────────────────────────

  #grantModalHtml() {
    return `
      <app-modal id="mdp-grant-modal" heading="Grant access">
        <div class="mdp-grant-form">
          <div class="mdp-field">
            <span class="mdp-field-label">Grant type</span>
            <div class="mdp-grant-types" id="mdp-grant-types" role="group" aria-label="Grant type"></div>
          </div>
          <div class="mdp-picker">
            <app-input id="mdp-grant-query" label="User" placeholder="Search users"
              autocomplete="off"><span data-slot="leading">${icons.search()}</span></app-input>
            <div class="mdp-picker-results" id="mdp-grant-results" hidden></div>
          </div>
          <div class="mdp-picker-picked" id="mdp-grant-picked" hidden></div>
          <p class="form-error" id="mdp-grant-error" hidden></p>
        </div>
        <div data-slot="footer">
          <app-button variant="tertiary" id="mdp-grant-cancel">Cancel</app-button>
          <app-button variant="primary" id="mdp-grant-submit" disabled>Grant access</app-button>
        </div>
      </app-modal>`;
  }

  #wireGrantModal() {
    const query = this.querySelector('#mdp-grant-query');
    let timer = null;
    query.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.#searchGranteesInto(query.value), 250);
    });
    this.querySelector('#mdp-grant-cancel').addEventListener('click', () =>
      this.querySelector('#mdp-grant-modal').close());
    this.querySelector('#mdp-grant-submit').addEventListener('click', () => this.#submitGrant());
  }

  #openGrantModal() {
    this.#grantType = 'user';
    this.#renderGrantTypes();
    this.#setPicked(null);
    const query = this.querySelector('#mdp-grant-query');
    query.value = '';
    query.setAttribute('label', 'User');
    query.setAttribute('placeholder', 'Search users');
    this.querySelector('#mdp-grant-results').hidden = true;
    this.querySelector('#mdp-grant-error').hidden = true;
    this.querySelector('#mdp-grant-modal').open();
    query.focus();
  }

  /**
   * The type chips are `<app-tag selectable>`. A tag toggles itself, so
   * single-select is enforced here: the tag that fired wins, every sibling is
   * cleared, and re-clicking the active one keeps it rather than leaving the
   * group with no type at all.
   */
  #renderGrantTypes() {
    const el = this.querySelector('#mdp-grant-types');
    el.innerHTML = GRANT_TYPES
      .filter((t) => !t.eeOnly || this.#isEe)
      .map((t) => `
        <app-tag class="mdp-grant-type" size="sm" selectable data-key="${t.key}"
          ${t.key === this.#grantType ? 'selected' : ''}>${t.label}</app-tag>`).join('');
    if (el.dataset.wired) return;
    el.dataset.wired = '1';
    el.addEventListener('tag-change', (e) => {
      const tag = e.target;
      tag.selected = true;
      for (const peer of el.querySelectorAll('app-tag')) {
        if (peer !== tag) peer.selected = false;
      }
      if (tag.dataset.key === this.#grantType) return;
      this.#grantType = tag.dataset.key;
      this.#setPicked(null);
      const query = this.querySelector('#mdp-grant-query');
      query.value = '';
      const type = GRANT_TYPES.find((t) => t.key === this.#grantType);
      query.setAttribute('label', type ? type.label : 'User');
      query.setAttribute('placeholder', `Search ${this.#grantType}s`);
      this.querySelector('#mdp-grant-results').hidden = true;
    });
  }

  #setPicked(picked) {
    this.#grantPicked = picked;
    const chip = this.querySelector('#mdp-grant-picked');
    const submit = this.querySelector('#mdp-grant-submit');
    if (!chip || !submit) return;
    if (picked) {
      chip.innerHTML = `<app-tag size="sm" removable>${escHtml(picked.label)}</app-tag>`;
      chip.hidden = false;
      // app-tag removes itself on click; the page clears the selection behind it.
      chip.querySelector('app-tag').addEventListener('tag-remove', () => this.#setPicked(null));
    } else {
      chip.innerHTML = '';
      chip.hidden = true;
    }
    submit.disabled = !picked;
  }

  async #searchGranteesInto(rawQuery) {
    const results = this.querySelector('#mdp-grant-results');
    const q = rawQuery.trim();
    if (q.length < 2) {
      results.hidden = true;
      return;
    }
    let options = [];
    try {
      options = await this.#searchGrantees(this.#grantType, q);
    } catch {
      options = [];
    }
    results.innerHTML = options.length
      ? options.map((o, i) => `<button type="button" class="mdp-picker-option" data-i="${i}">
          <span class="mdp-picker-option-label">${escHtml(o.label)}</span>
          ${o.sub ? `<span class="mdp-picker-option-sub">${escHtml(o.sub)}</span>` : ''}
        </button>`).join('')
      : '<div class="mdp-picker-none">No matches</div>';
    results.hidden = false;
    results.querySelectorAll('.mdp-picker-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.#setPicked(options[Number(btn.dataset.i)]);
        results.hidden = true;
      });
    });
  }

  // Users come from the gateway's own share-target search (org-visibility
  // scoped, username-only); teams/departments from the EE org search.
  async #searchGrantees(type, q) {
    const enc = encodeURIComponent(q);
    if (type === 'user') {
      const resp = await fetchApi(`/mcp/share-targets?q=${enc}`);
      return (resp?.data?.users || []).map((u) => ({
        id: u.user_id,
        label: u.display_name || u.username,
        sub: u.display_name ? u.username : '',
      }));
    }
    const resp = await fetchApi(`/search/${GRANT_PATHS[type]}?q=${enc}`);
    return (resp?.data || []).map((t) => ({ id: t.id, label: t.name, sub: t.description || '' }));
  }

  async #submitGrant() {
    if (!this.#grantPicked) return;
    const err = this.querySelector('#mdp-grant-error');
    err.hidden = true;
    try {
      await fetchApi(this.#grantPath(this.#grantType, this.#grantPicked.id), { method: 'POST' });
      this.querySelector('#mdp-grant-modal').close();
      showToast(`Access granted to ${this.#grantPicked.label}`);
      this.#granteeTab = GRANT_PATHS[this.#grantType];
      this.#loadGrants();
    } catch (e) {
      err.textContent = 'Failed to grant access: ' + e.message;
      err.hidden = false;
    }
  }

  // ── Danger zone ───────────────────────────────────────────────────────────

  #dangerZoneHtml() {
    return `
      <div class="mdp-section mdp-danger">
        <h3 class="mdp-danger-title">Danger zone</h3>
        <p class="mdp-muted">Deleting this connector removes it and revokes all agent access</p>
        <app-button variant="danger-secondary" size="sm" id="mdp-delete-btn">${icons.trash()} Delete connector</app-button>
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