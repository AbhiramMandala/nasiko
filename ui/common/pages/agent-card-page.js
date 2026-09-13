import { setFieldError } from '/common/utils/field-error.js';
import { icons } from '/common/utils/icons.js';
import { fetchApi, apiFetch } from '/common/services/api.js';
import { authService } from '/common/services/auth-service.js';
import { showToast } from '/common/utils/toast.js';
import { confirmDialog } from '/common/design-system/app-modal/app-modal.js';
import { ansiToHtml } from '/common/utils/ansi.js';
import { attachSlidingIndicator } from '/common/utils/tab-indicator.js';
import '/common/design-system/app-tabs/app-tabs.js';
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./agent-card-page.css', import.meta.url));
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/features/agent-llm-config.js';
import '/common/features/secrets-manager.js';
import { escHtml, escAttr } from '/common/utils/escape.js';
import '/common/design-system/app-button/app-button.js';
import '/common/utils/back-link.js';
import '/common/design-system/app-input/app-input.js';
import '/common/design-system/app-radio/app-radio.js';
import '/common/design-system/app-search/app-search.js';
import '/common/design-system/app-select/app-select.js';
import '/common/design-system/app-switch/app-switch.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-table/app-table.js';
import '/common/design-system/app-tag/app-tag.js';
import { call } from '../core/data-sources.js';
import { navigate as routerNavigate } from '../core/router.js';


document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const GRANT_TYPES = [
  { key: 'user', label: 'User', eeOnly: false },
  { key: 'team', label: 'Team', eeOnly: true },
  { key: 'department', label: 'Department', eeOnly: true },
  { key: 'agent', label: 'Agent', eeOnly: false },
];

class AgentCardPage extends HTMLElement {
  #initialized = false;
  #agent = null;
  #agentId = null;
  #canManage = false;
  #logsLoaded = false;
  #secretsLoaded = false;
  #accessLoaded = false;
  #configureLoaded = false;
  #versionsLoaded = false;
  #versions = [];
  // Version targeted by the open rollback modal.
  #rollbackTarget = null;
  #logsTail = 100;
  #logsFollowing = true;
  // Access & security state
  #access = null;
  #granteeTab = 'users';
  #accessFilter = '';
  #grantType = 'user';
  #grantPicked = null;
  #transferPicked = null;
  // Configure state
  #connectors = [];
  #connectorTools = new Map();
  #openConnectors = new Set();

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#agentId = new URLSearchParams(location.search).get('id');
    if (!this.#agentId) {
      this.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--s-16);min-height:60vh;text-align:center;">
          <app-empty-state
            heading="No agent selected"
            description="Open an agent from the hub to see its card, settings, and logs.">
          </app-empty-state>
          <a href="/agents" style="color:var(--fg-brand);font-size:var(--font-size-sm);font-weight:600;">Browse the agent hub</a>
        </div>`;
      return;
    }
    this.addEventListener('click', (e) => this.#onActionClick(e));
    this.innerHTML = this.#loadingShellHtml();
    this.#load();
  }

  /**
   * Loading placeholder shown between mount and the first successful fetch.
   * Mirrors the real #render() shape below (title, tags, stat cards, detail
   * cards) instead of one flat rectangle: each piece shimmers on its own, so
   * the page reads as "several things are loading" rather than "one grey
   * slab is loading" — and the page doesn't jump size once data arrives.
   */
  #loadingShellHtml() {
    const statCell = () => '<div class="acp-stat"><app-skeleton height="48px"></app-skeleton></div>';
    const detailCard = () => '<div class="acp-details-card"><app-skeleton lines="4"></app-skeleton></div>';
    return `
      <div class="acp-page">
        <div class="acp-topbar">
          <app-skeleton height="28px" style="width:80px;"></app-skeleton>
        </div>
        <div class="acp-title-row">
          <h1 class="acp-name"><app-skeleton lines="1" style="width:12ch;"></app-skeleton></h1>
        </div>
        <div class="acp-badge-row">
          <span class="acp-tag"><app-skeleton height="12px" radius="full" style="width:5ch;"></app-skeleton></span>
          <span class="acp-tag"><app-skeleton height="12px" radius="full" style="width:8ch;"></app-skeleton></span>
        </div>
        <p class="acp-description"><app-skeleton lines="2"></app-skeleton></p>
        <div class="acp-stats-grid">${Array.from({ length: 4 }, statCell).join('')}</div>
        <div class="acp-details-row">${Array.from({ length: 2 }, detailCard).join('')}</div>
      </div>`;
  }

  /**
   * `count` independent row-shaped placeholders instead of one tall block.
   * Used for the tab panels whose real content is a short list or table
   * (access grants, versions, MCP connectors) so each row shimmers on its
   * own, matching the rows that will actually replace them.
   */
  #rowSkeletonHtml(count, height = '40px') {
    const row = () => `<app-skeleton height="${height}" radius="md" style="margin-bottom:var(--s-8);"></app-skeleton>`;
    return Array.from({ length: count }, row).join('');
  }

  async #load() {
    try {
      // GET /api/agents/{id} → SingleResponse envelope {data, status_code, message}
      const resp = await fetchApi(`/agents/${this.#agentId}`);
      this.#agent = resp?.data ?? resp;
    } catch {
      this.#agent = null;
    }
    if (!this.#agent?.name && !this.#agent?.display_name) {
      this.innerHTML = '<p style="color:var(--color-error);">Agent not found.</p>';
      return;
    }
    this.#canManage = await this.#resolveCanManage(this.#agent);
    this.#logsLoaded = false;
    this.#secretsLoaded = false;
    this.#accessLoaded = false;
    this.#configureLoaded = false;
    document.title = `Nasiko — ${this.#agent.display_name || this.#agent.name}`;
    this.#render();
  }

  // `can_manage` is computed server-side with the same predicate the mutating
  // routes enforce. Older servers don't send it — fall back to comparing the
  // caller with owner_id (superusers manage everything).
  async #resolveCanManage(agent) {
    if (typeof agent.can_manage === 'boolean') return agent.can_manage;
    const user = await authService.fetchCurrentUser().catch(() => null);
    if (!user) return false;
    return user.is_superuser === true || (!!agent.owner_id && user.id === agent.owner_id);
  }

  /* ── Page skeleton ─────────────────────────────────────────────────────── */

  #render() {
    const a = this.#agent;
    const displayName = a.display_name || a.name;
    const isCodingAgent = a.is_coding_agent === true;

    this.innerHTML = `
      <div class="acp-page">
        ${this.#topbarHtml(a)}
        ${this.#heroHtml(a, displayName)}
        <app-tabs>
          ${this.#overviewPanelHtml(a)}
          ${this.#canManage ? this.#accessPanelHtml() : ''}
          ${this.#canManage ? this.#versionsPanelHtml() : ''}
          ${isCodingAgent ? '' : this.#configurePanelHtml(a)}
          ${this.#canManage ? this.#settingsPanelHtml(a) : ''}
          ${isCodingAgent ? '' : this.#logsPanelHtml()}
        </app-tabs>
      </div>
      ${this.#canManage ? this.#modalsHtml() : ''}
    `;

    this.#wireTabs();
    this.#wireOverview(a);
    this.#wireLogsControls();
    if (this.#canManage) {
      this.#wireSettings();
      this.#wireGrantModal();
      this.#wireTransferModal();
      this.#wireVersionModals();
    }
    this.#loadStats();
    this.#loadResourceUsage();
  }

  #topbarHtml(a) {
    const actions = this.#canManage && a.status === 'running' ? `
            <app-button variant="ghost" size="sm" data-action="restart" title="Restart agent">${icons.refresh()} Restart</app-button>
            <app-button variant="ghost" size="sm" data-action="stop" title="Stop agent">${icons.square()} Stop</app-button>` : '';
    return `
        <div class="acp-topbar">
        <app-button href="/agents" variant="tertiary" size="sm" icon-only data-back
            aria-label="Back">${icons.x('', 16)}</app-button>
          <div class="acp-topbar-actions">${actions}</div>
        </div>`;
  }

  #heroHtml(a, displayName) {
    const tagsHtml = (a.tags || []).slice(0, 3).map(t =>
      `<span class="acp-tag">${escHtml(t)}</span>`
    ).join('');
    const extraTagCount = (a.tags || []).length - 3;
    const moreTag = extraTagCount > 0 ? `<span class="acp-tag acp-tag--more">+${extraTagCount}</span>` : '';
    const statusVariant = a.status === 'running' ? 'success' : (a.status === 'error' || a.status === 'failed') ? 'error' : 'neutral';
    const statusLabel = a.status === 'running' ? 'Active' : (a.status || 'Unknown').replace(/^./, c => c.toUpperCase());
    return `
        <div class="acp-title-row">
          <h1 class="acp-name">${escHtml(displayName)}</h1>
          <span class="acp-version">v${escHtml(a.version || '?')}</span>
          <span class="acp-verified" title="Registered agent">${icons.checkCircle('', 16)}</span>
          <app-button class="acp-start-btn" size="md" variant="primary"
            href="/chat?agent_id=${encodeURIComponent(a.id)}&agent_name=${encodeURIComponent(displayName)}">
            Start session ${icons.send()}
          </app-button>
        </div>

        <div class="acp-badge-row">
          <span class="badge badge--${statusVariant}">${escHtml(statusLabel)}</span>
          ${a.provider ? `<span class="acp-tag">Author: ${escHtml(a.provider)}</span>` : ''}
          ${tagsHtml}${moreTag}
        </div>`;
  }

  /* ── Overview tab ──────────────────────────────────────────────────────── */

  #overviewPanelHtml(a) {
    const skills = a.skills || [];
    const skillsHtml = skills.map(s => {
      const href = s.sample_query
        ? `/chat?agent_id=${encodeURIComponent(a.id)}&query=${encodeURIComponent(s.sample_query)}`
        : null;
      const wrapper = href ? 'a' : 'div';
      const hrefAttr = href ? ` href="${escAttr(href)}"` : '';
      return `
      <${wrapper} class="acp-skill-card tile"${hrefAttr}>
        <div class="acp-skill-name">${escHtml(s.name)}</div>
        <div class="acp-skill-desc">${escHtml(s.description || '')}</div>
        ${s.sample_query ? `
        <div class="acp-skill-sample">
          <span class="acp-skill-sample-icon">${icons.send('', 14)}</span>
          <span class="acp-skill-sample-text">${escHtml(s.sample_query)}</span>
        </div>` : ''}
      </${wrapper}>`;
    }).join('');

    const caps = a.capabilities || {};

    return `
        <div class="acp-panel" data-tab="overview" data-label="Overview">
          <div class="acp-overview-head">
            <p class="acp-description">${escHtml(a.description || '')}</p>
            <div class="acp-json-toggle">
              <app-switch id="acp-json-switch" size="sm" label="Agent JSON"></app-switch>
              ${icons.code('acp-json-icon', 16)}
            </div>
          </div>

          <div id="acp-json-view" hidden>
            <div class="acp-json-block">
              <app-button class="acp-json-copy" variant="ghost" size="sm" icon-only
                title="Copy JSON" aria-label="Copy JSON">${icons.copy()}</app-button>
              <pre><code>${escHtml(JSON.stringify(a, null, 2))}</code></pre>
            </div>
          </div>

          <div id="acp-overview-body">
          ${skills.length ? `
          <section class="acp-section">
            <h2 class="acp-section-title">Skills</h2>
            <p class="acp-section-sub">What this agent can do.</p>
            <div class="acp-skills-grid">${skillsHtml}</div>
          </section>` : ''}

          <section class="acp-section">
            <h2 class="acp-section-title">Quick performance</h2>
            <p class="acp-section-sub">Recent runtime metrics for this agent.</p>
            <div class="acp-stats-grid" id="acp-stats">
              <div class="acp-stat"><app-skeleton height="48px"></app-skeleton></div>
              <div class="acp-stat"><app-skeleton height="48px"></app-skeleton></div>
              <div class="acp-stat"><app-skeleton height="48px"></app-skeleton></div>
              <div class="acp-stat"><app-skeleton height="48px"></app-skeleton></div>
            </div>
          </section>

          <section class="acp-section">
            <h2 class="acp-section-title">Resource usage</h2>
            <p class="acp-section-sub">What this agent's container is consuming right now.</p>
            <div class="acp-stats-grid" id="acp-resources">
              <div class="acp-stat"><app-skeleton height="48px"></app-skeleton></div>
              <div class="acp-stat"><app-skeleton height="48px"></app-skeleton></div>
              <div class="acp-stat"><app-skeleton height="48px"></app-skeleton></div>
            </div>
          </section>

          <div class="acp-details-row">
            <section class="acp-section acp-details-card">
              <h2 class="acp-section-title">Agent details</h2>
              <dl class="acp-dl">
                <div><dt>Provider</dt><dd>${escHtml(a.provider || '—')}</dd></div>
                <div><dt>Project URL</dt><dd>${a.project_url ? `<a href="${escAttr(a.project_url)}" target="_blank">${escHtml(a.project_url)}</a>` : '—'}</dd></div>
                <div><dt>Docs</dt><dd>${a.docs_url ? `<a href="${escAttr(a.docs_url)}" target="_blank">${escHtml(a.docs_url)}</a>` : '—'}</dd></div>
                <div><dt>ID</dt><dd><code>${escHtml(a.id)}</code></dd></div>
                <div><dt>Version</dt><dd>${escHtml(a.version || '—')}</dd></div>
                <div><dt>Protocol</dt><dd>${escHtml(a.protocol_version || '—')}</dd></div>
                <div><dt>Transport</dt><dd>${escHtml(a.transport || 'JSONRPC')}</dd></div>
                <div><dt>Default I/O</dt><dd>${escHtml(a.default_io || 'application/json, text/plain')}</dd></div>
              </dl>
            </section>

            <section class="acp-section acp-details-card">
              <h2 class="acp-section-title">Capabilities</h2>
              <dl class="acp-dl">
                <div><dt>Streaming</dt><dd>${caps.streaming ? 'Yes' : 'No'}</dd></div>
                <div><dt>Push notification</dt><dd>${caps.push_notifications ? 'Supported' : 'Not supported'}</dd></div>
                <div><dt>State history</dt><dd>${caps.state_transition_history ? 'Yes' : 'No'}</dd></div>
                <div><dt>Chat agent</dt><dd>${a.status === 'running' ? 'Enabled' : 'Disabled'}</dd></div>
              </dl>
            </section>
          </div>
          </div>
        </div>`;
  }

  #wireOverview(a) {
    const jsonSwitch = this.querySelector('#acp-json-switch');
    jsonSwitch.addEventListener('change', () => {
      this.querySelector('#acp-json-view').hidden = !jsonSwitch.checked;
      this.querySelector('#acp-overview-body').hidden = jsonSwitch.checked;
    });
    this.querySelector('.acp-json-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(JSON.stringify(a, null, 2))
        .then(() => showToast('Agent JSON copied'))
        .catch(() => showToast('Copy failed'));
    });
  }

  /* ── Tab switching ─────────────────────────────────────────────────────── */

  // app-tabs owns the strip and panel visibility; we only lazy-load on entry.
  #wireTabs() {
    this.querySelector('app-tabs').addEventListener('tabs-change', (e) => {
      const key = e.detail.key;
      if (key === 'logs' && !this.#logsLoaded) this.#loadLogs();
      if (key === 'settings' && !this.#secretsLoaded) {
        this.#secretsLoaded = true;
        this.querySelector('#acp-secrets')?.refresh();
      }
      if (key === 'access' && !this.#accessLoaded) this.#loadAccess();
      if (key === 'versions' && !this.#versionsLoaded) this.#loadVersions();
      if (key === 'configure' && !this.#configureLoaded) this.#loadConfigure();
    });
  }

  /* ── Topbar / danger-zone actions (wired once, delegated) ──────────────── */

  async #onActionClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || !this.#agent) return;
    const action = btn.dataset.action;
    if (action === 'restart') this.#runContainerAction(btn, 'restart', 'Restarting...');
    else if (action === 'stop') this.#runContainerAction(btn, 'stop', 'Stopping...');
    else if (action === 'delete') this.#deleteAgent(btn);
    else if (action === 'reupload') this.#openReuploadModal();
    else if (action === 'rollback') this.#openRollbackModal(btn.dataset.version);
  }

  async #runContainerAction(btn, verb, busyLabel) {
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.label = busyLabel;
    try {
      const res = await apiFetch(`/containers/${encodeURIComponent(this.#agent.name)}/${verb}`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      if (verb === 'restart') showToast('Agent restarted');
      location.reload();
    } catch (err) {
      showToast(`Failed to ${verb}: ${err.message}`);
      btn.innerHTML = original;
      btn.disabled = false;
    }
  }

  async #deleteAgent(btn) {
    const displayName = this.#agent.display_name || this.#agent.name;
    const confirmed = await confirmDialog({
      title: `Delete ${displayName}`,
      message: 'This removes the agent from the registry, revokes all grants, and stops its container. This action cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.label = 'Deleting...';
    try {
      const res = await apiFetch(`/agents/${encodeURIComponent(this.#agent.id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      routerNavigate('/your-agents');
    } catch (err) {
      showToast(`Failed to delete: ${err.message}`);
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  /* ── Access & security tab ─────────────────────────────────────────────── */

  #accessPanelHtml() {
    return `
        <div class="acp-panel" data-tab="access" data-label="Access &amp; security">
          <div id="acp-access-body">${this.#rowSkeletonHtml(4)}</div>
        </div>`;
  }

  /* ── Versions tab ──────────────────────────────────────────────────────── */

  #versionsPanelHtml() {
    return `
        <div class="acp-panel" data-tab="versions" data-label="Versions">
          <section class="acp-section">
            <div class="acp-versions-head">
              <div>
                <h2 class="acp-section-title">Version history</h2>
                <p class="acp-section-sub">Every build of this agent. Re-upload to ship a new
                  version, or roll back to a previous image.</p>
              </div>
              <app-button variant="primary" size="md" data-action="reupload">${icons.upload()} Re-upload</app-button>
            </div>
            <div id="acp-versions-body">${this.#rowSkeletonHtml(3)}</div>
          </section>
        </div>`;
  }

  async #loadVersions() {
    this.#versionsLoaded = true;
    const el = this.querySelector('#acp-versions-body');
    if (!el) return;
    try {
      const resp = await fetchApi(`/agents/${this.#agent.id}/versions`);
      this.#versions = (resp?.data ?? resp) || [];
    } catch (e) {
      el.innerHTML = `<div class="acp-stats-empty"><app-empty-state
        heading="Version history unavailable"
        description="${escAttr(e.message)}"
        icon="${escAttr(icons.layers('', 32))}"></app-empty-state></div>`;
      return;
    }
    this.#renderVersions();
  }

  // Same `<app-table>` treatment as the grants table: the DS owns the head,
  // hairlines, sorting and empty row. Rows carry `status_label` so the column
  // sorts on the word it shows rather than on the raw `is_active` flag.
  #renderVersions() {
    const el = this.querySelector('#acp-versions-body');
    if (!el) return;

    if (!this.#versions.length) {
      el.innerHTML = `<div class="acp-stats-empty"><app-empty-state
        heading="No versions recorded"
        description="Versions appear here once this agent has been built through upload, push or re-upload."
        icon="${escAttr(icons.layers('', 32))}"></app-empty-state></div>`;
      return;
    }

    el.innerHTML = '<app-table id="acp-versions-table" pagination="none" limit="5"></app-table>';
    const table = el.querySelector('#acp-versions-table');
    table.columns = [
      { key: 'version', label: 'Version', render: (v) => `<code>${escHtml(v)}</code>` },
      { key: 'status_label', label: 'Status', render: (v, row) => row.is_active
        ? `<app-badge variant="success" dot>Active</app-badge>`
        : `<app-badge variant="neutral">${escHtml(v)}</app-badge>` },
      { key: 'image_tag', label: 'Image', render: (v) => `<code>${escHtml(v || '—')}</code>` },
      { key: 'changelog', label: 'Changelog', render: (v) => escHtml(v || '—') },
      { key: 'built', label: 'Built', render: (v) => escHtml(v) },
      { key: 'actions', label: '', render: (_v, row) => row.is_active || !row.can_rollback ? ''
        : `<app-button variant="ghost" size="sm" data-action="rollback"
            data-version="${escAttr(row.version)}">Roll back</app-button>` },
    ];
    table.dataFn = () => this.#versions.map((v) => ({
      ...v,
      status_label: v.status === 'archived' ? 'Archived' : (v.status || '—'),
      built: v.created_at ? new Date(v.created_at).toLocaleString() : '—',
    }));
    table.refresh();
  }

  #wireVersionModals() {
    const reupload = this.querySelector('#acp-reupload-modal');
    this.querySelector('#acp-reupload-cancel').addEventListener('click', () => reupload.close());
    this.querySelector('#acp-reupload-submit').addEventListener('click', () => this.#submitReupload());

    const rollback = this.querySelector('#acp-rollback-modal');
    this.querySelector('#acp-rollback-cancel').addEventListener('click', () => rollback.close());
    this.querySelector('#acp-rollback-submit').addEventListener('click', () => this.#submitRollback());
  }

  #openReuploadModal() {
    this.querySelector('#acp-reupload-file').value = '';
    this.querySelector('#acp-reupload-version').value = 'patch';
    this.querySelector('#acp-reupload-changelog').value = '';
    this.querySelector('#acp-reupload-error').hidden = true;
    this.querySelector('#acp-reupload-modal').open();
  }

  /// `PUT /api/agents/{id}/update` — multipart `source` (.zip) plus an optional
  /// `version` (semver or one of auto|patch|minor|major) and `changelog`.
  /// Queues a build; progress shows up under Builds.
  async #submitReupload() {
    const submit = this.querySelector('#acp-reupload-submit');
    const error = this.querySelector('#acp-reupload-error');
    const file = this.querySelector('#acp-reupload-file').files[0];
    const version = this.querySelector('#acp-reupload-version').value.trim();
    const changelog = this.querySelector('#acp-reupload-changelog').value.trim();

    error.hidden = true;
    if (!file) {
      this.#showModalError(error, 'Choose a .zip archive to upload.');
      return;
    }
    const versionField = this.querySelector('#acp-reupload-version');
    setFieldError(versionField, null);
    if (!version) {
      setFieldError(versionField, 'A version or bump strategy is required.');
      return;
    }

    const form = new FormData();
    form.append('source', file, file.name);
    form.append('version', version);
    if (changelog) form.append('changelog', changelog);

    submit.disabled = true;
    try {
      const res = await apiFetch(`/agents/${encodeURIComponent(this.#agent.id)}/update`, {
        method: 'PUT',
        body: form,
      });
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      const body = await res.json().catch(() => null);
      this.querySelector('#acp-reupload-modal').close();
      showToast(`Build queued for v${body?.new_version || version}`);
      this.#refreshVersions();
    } catch (err) {
      this.#showModalError(error, err.message);
    } finally {
      submit.disabled = false;
    }
  }

  #openRollbackModal(targetVersion) {
    this.#rollbackTarget = targetVersion;
    this.querySelector('#acp-rollback-summary').textContent =
      `Redeploys the image built for ${targetVersion} and archives the current version. `
      + 'The rollback runs as a build, so it appears in the version history too.';
    this.querySelector('#acp-rollback-reason').value = '';
    this.querySelector('#acp-rollback-error').hidden = true;
    this.querySelector('#acp-rollback-modal').open();
  }

  async #submitRollback() {
    const submit = this.querySelector('#acp-rollback-submit');
    const error = this.querySelector('#acp-rollback-error');
    const reason = this.querySelector('#acp-rollback-reason').value.trim();
    error.hidden = true;

    submit.disabled = true;
    try {
      const res = await apiFetch(`/agents/${encodeURIComponent(this.#agent.id)}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_version: this.#rollbackTarget, reason: reason || null }),
      });
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      const body = await res.json().catch(() => null);
      this.querySelector('#acp-rollback-modal').close();
      showToast(`Rollback to ${body?.rolled_back_to || this.#rollbackTarget} queued`);
      this.#refreshVersions();
    } catch (err) {
      this.#showModalError(error, err.message);
    } finally {
      submit.disabled = false;
    }
  }

  /// Builds are asynchronous, so the row that just changed won't be `active`
  /// yet — re-reading is still the honest thing to show.
  #refreshVersions() {
    this.#versionsLoaded = false;
    this.#loadVersions();
  }

  #showModalError(el, message) {
    el.textContent = message;
    el.hidden = false;
  }

  // Feature-detects what the running edition serves: EE answers
  // /teams and /departments with arrays; OSS has no such routes (the request
  // falls through to the agent proxy and fails), so those grantee tabs hide.
  async #loadAccess() {
    this.#accessLoaded = true;
    const id = this.#agent.id;
    const [visibility, users, agentGrants, teams, departments] = await Promise.all([
      this.#fetchVisibility(id),
      this.#fetchArray(`/agents/${id}/users`),
      this.#fetchArray(`/agents/${id}/grants/agents`),
      this.#fetchArray(`/agents/${id}/teams`),
      this.#fetchArray(`/agents/${id}/departments`),
    ]);
    this.#access = {
      visibility,
      users: (users || []).map((u) => ({
        id: u.id ?? u.user_id ?? '',
        name: u.username || u.user_id || u.id || '',
        email: u.email || '',
        role: u.role || '',
      })),
      agents: this.#normalizeAgentGrants(agentGrants, visibility),
      teams,
      departments,
    };
    if (this.#granteeTab !== 'users' && this.#granteeTab !== 'agents'
        && !Array.isArray(this.#access[this.#granteeTab])) {
      this.#granteeTab = 'users';
    }
    this.#renderAccess();
  }

  // `null` means "this edition doesn't serve the route" — the caller uses that
  // to decide whether Team/Department exist at all, so an enveloped array must
  // NOT be mistaken for a missing route. EE answers /users with a bare array
  // but /teams and /departments as {data:{accessible_teams|accessible_departments}},
  // and reading only the bare form is what silently hid both grantee types.
  async #fetchArray(path) {
    try {
      const v = await fetchApi(path);
      if (Array.isArray(v)) return v;
      const inner = v?.data;
      if (Array.isArray(inner)) return inner;
      const nested = Object.values(inner || {}).find(Array.isArray);
      return nested ?? null;
    } catch {
      return null;
    }
  }

  async #fetchVisibility(id) {
    try {
      const v = await fetchApi(`/agents/${id}/visibility`);
      return typeof v?.is_public === 'boolean' ? v : null;
    } catch {
      return null;
    }
  }

  // OSS answers GET /grants/agents with [{target_agent_id, target_name}]; EE
  // doesn't serve that read — derive its agent grants from visibility.grants.
  #normalizeAgentGrants(rows, visibility) {
    if (Array.isArray(rows)) {
      return rows.map((r) => ({ id: r.target_agent_id, name: r.target_name || '' }));
    }
    const grants = visibility?.grants;
    if (!Array.isArray(grants)) return [];
    return grants
      .filter((g) => g.grant_type === 'agent')
      .map((g) => ({ id: g.grantee_id, name: '' }));
  }

  // Direct user shares: EE lists ALL users with access (owner + inherited), so
  // "direct" comes from the grant rows; OSS's /users listing is direct-only.
  #directUserIds() {
    const grants = this.#access.visibility?.grants;
    if (Array.isArray(grants)) {
      return new Set(grants.filter((g) => g.grant_type === 'user').map((g) => g.grantee_id));
    }
    return new Set(this.#access.users.map((u) => u.id));
  }

  #granteeTabDefs() {
    const defs = [];
    if (Array.isArray(this.#access.departments)) defs.push({ key: 'departments', label: 'Departments' });
    if (Array.isArray(this.#access.teams)) defs.push({ key: 'teams', label: 'Teams' });
    defs.push({ key: 'users', label: 'Users' });
    defs.push({ key: 'agents', label: 'Agents' });
    return defs;
  }

  #renderAccess() {
    const body = this.querySelector('#acp-access-body');
    if (!body) return;
    const acc = this.#access;
    const isEe = Array.isArray(acc.teams) || Array.isArray(acc.departments);
    const privateSub = isEe
      ? 'Only granted departments, teams and users'
      : 'Only granted users and agents';

    const visibilitySection = acc.visibility === null ? '' : `
      <section class="acp-section">
        <h2 class="acp-section-title">Visibility</h2>
        <p class="acp-section-sub">Who can discover and use this agent?</p>
        <div class="acp-vis-options" role="radiogroup" aria-label="Agent visibility">
          ${this.#visOptionHtml('public', 'Public', 'Anyone in your organisation can discover and use it', acc.visibility.is_public)}
          ${this.#visOptionHtml('private', 'Private', privateSub, !acc.visibility.is_public)}
        </div>
      </section>`;

    body.innerHTML = `
      ${visibilitySection}
      <section class="acp-section">
        <div class="acp-access-head">
          <div>
            <h2 class="acp-section-title">Access</h2>
            <p class="acp-section-sub">Grant access to ${isEe ? 'users, teams, or departments' : 'users or agents'}. ${isEe ? 'Access is automatically inherited by members.' : ''}</p>
          </div>
          <app-button variant="primary" size="md" id="acp-grant-open">${icons.plus('', 14)} Grant access</app-button>
        </div>
        <app-search id="acp-access-filter" class="acp-access-search"
          placeholder="Search ${this.#granteeTabDefs().map(d => d.label.toLowerCase()).join(', ')}"
          aria-label="Search access grants"
          value="${escAttr(this.#accessFilter)}" autocomplete="off"></app-search>
        <div class="acp-subtabs" id="acp-grantee-tabs">
          ${this.#granteeTabDefs().map(d => `<button type="button" class="acp-subtab${d.key === this.#granteeTab ? ' is-active' : ''}" data-grantee-tab="${d.key}">${d.label}</button>`).join('')}
        </div>
        <app-table id="acp-access-table" pagination="none" limit="5"></app-table>
      </section>`;

    this.#wireAccess(body);
  }

  #visOptionHtml(value, label, sub, checked) {
    return `
      <app-radio class="acp-vis-option" name="acp-visibility" value="${escAttr(value)}"
        label="${escAttr(label)}" hint="${escAttr(sub)}" ${checked ? 'checked' : ''}></app-radio>`;
  }

  #wireAccess(body) {
    body.querySelectorAll('input[name="acp-visibility"]').forEach((radio) => {
      radio.addEventListener('change', () => this.#setVisibility(radio.value === 'public'));
    });
    const filter = body.querySelector('#acp-access-filter');
    filter?.addEventListener('input', () => {
      this.#accessFilter = filter.value;
      this.#syncAccessTable();
    });
    const granteeTabs = body.querySelector('#acp-grantee-tabs');
    if (granteeTabs) attachSlidingIndicator(granteeTabs, '.acp-subtab', '.is-active', { pill: true });
    granteeTabs?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-grantee-tab]');
      if (!btn) return;
      this.#granteeTab = btn.dataset.granteeTab;
      body.querySelectorAll('.acp-subtab').forEach(t =>
        t.classList.toggle('is-active', t.dataset.granteeTab === this.#granteeTab));
      this.#syncAccessTable();
    });
    body.querySelector('#acp-grant-open')?.addEventListener('click', () => this.#openGrantModal());
    this.#wireAccessTable();
    this.#syncAccessTable();
  }

  async #setVisibility(isPublic) {
    try {
      const res = await apiFetch(`/agents/${encodeURIComponent(this.#agent.id)}/grants/public`, {
        method: isPublic ? 'POST' : 'DELETE',
      });
      if (!res.ok && res.status !== 404) throw new Error(await res.text());
      this.#access.visibility.is_public = isPublic;
      showToast(isPublic ? 'Agent is now public' : 'Agent is now private');
    } catch (err) {
      showToast(`Failed to change visibility: ${err.message}`);
      this.#renderAccess();
    }
  }

  #matchesFilter(...fields) {
    const q = this.#accessFilter.trim().toLowerCase();
    if (!q) return true;
    return fields.some((f) => (f || '').toLowerCase().includes(q));
  }

  /**
   * The grants table is `<app-table>` — the design system's table, so the head,
   * hairlines, sorting, sticky action column and empty row all come from one
   * place instead of a per-page `<table>`. Its own search and pager are off: the
   * section already owns an `<app-search>` that spans every grantee tab, and a
   * grant list is short enough to read whole.
   *
   * Each tab is a different shape, so this hands the element a fresh
   * `columns` + `dataFn` pair and refreshes it. Rows carry their computed
   * `grant` string as a real field so the column sorts on what it shows.
   */
  #syncAccessTable() {
    const table = this.querySelector('#acp-access-table');
    if (!table) return;
    const { columns, rows } = this.#accessTableView();
    const label = this.#granteeTabDefs().find(d => d.key === this.#granteeTab)?.label || 'entries';
    table.setAttribute('empty-message',
      `No ${label.toLowerCase()} have access yet — use Grant access to share this agent.`);
    table.columns = columns;
    table.dataFn = () => rows;
    table.refresh();
  }

  #accessTableView() {
    switch (this.#granteeTab) {
      case 'departments': return this.#departmentsTableView();
      case 'teams': return this.#teamsTableView();
      case 'agents': return this.#agentsTableView();
      default: return this.#usersTableView();
    }
  }

  /** Dash for an empty cell, so a blank column reads as "none" not as broken. */
  #cellOrDash(v) {
    return v === null || v === undefined || v === '' ? '—' : escHtml(String(v));
  }

  #grantBadge(kind) {
    const mod = kind === 'Owner' ? ' is-owner' : kind === 'Direct' ? ' is-direct' : '';
    return `<span class="acp-grant-badge${mod}">${kind}</span>`;
  }

  #usersTableView() {
    const ownerId = this.#agent.owner_id;
    const direct = this.#directUserIds();
    let rows = this.#access.users.filter((u) => this.#matchesFilter(u.name, u.email));
    // OSS's grant listing omits the owner — surface them anyway.
    if (ownerId && !this.#access.users.some((u) => u.id === ownerId)) {
      const self = authService.getCurrentUserId() === ownerId ? authService.getCurrentUser() : null;
      rows = [{ id: ownerId, name: self || this.#shortId(ownerId), email: '', role: '' }, ...rows];
    }
    return {
      columns: [
        { key: 'name', label: 'User' },
        { key: 'email', label: 'Email', render: (v) => this.#cellOrDash(v) },
        { key: 'role', label: 'Role', render: (v) => this.#cellOrDash(v) },
        { key: 'grant', label: 'Grant', render: (v) => this.#grantBadge(v) },
        { key: 'actions', label: '', render: (_v, row) => row.grant === 'Owner'
          ? `<app-button variant="ghost" size="sm" data-transfer-open>Transfer ownership</app-button>`
          : row.grant === 'Direct' ? this.#revokeBtnHtml('user', row.id, row.name) : '' },
      ],
      rows: rows.map((u) => ({
        ...u,
        grant: u.id === ownerId ? 'Owner' : direct.has(u.id) ? 'Direct' : 'Inherited',
      })),
    };
  }

  #teamsTableView() {
    return {
      columns: [
        { key: 'name', label: 'Team' },
        { key: 'members_count', label: 'Members', render: (v) => this.#cellOrDash(v) },
        { key: 'grant', label: 'Grant', render: (v) => this.#grantBadge(v) },
        { key: 'actions', label: '', render: (_v, row) => this.#revokeBtnHtml('team', row.id, row.name) },
      ],
      rows: (this.#access.teams || [])
        .filter((t) => this.#matchesFilter(t.name))
        .map((t) => ({ ...t, grant: 'Direct' })),
    };
  }

  #departmentsTableView() {
    return {
      columns: [
        { key: 'name', label: 'Department' },
        { key: 'members_count', label: 'Members', render: (v) => this.#cellOrDash(v) },
        { key: 'teams_count', label: 'Teams', render: (v) => this.#cellOrDash(v) },
        { key: 'actions', label: '', render: (_v, row) => this.#revokeBtnHtml('department', row.id, row.name) },
      ],
      rows: (this.#access.departments || []).filter((d) => this.#matchesFilter(d.name)),
    };
  }

  #agentsTableView() {
    return {
      columns: [
        { key: 'name', label: 'Agent' },
        { key: 'grant', label: 'Grant', render: (v) => this.#grantBadge(v) },
        { key: 'actions', label: '', render: (_v, row) => this.#revokeBtnHtml('agent', row.id, row.name) },
      ],
      rows: (this.#access.agents || [])
        .filter((g) => this.#matchesFilter(g.name, g.id))
        .map((g) => ({ ...g, name: g.name || this.#shortId(g.id), grant: 'Direct' })),
    };
  }

  #revokeBtnHtml(kind, id, name) {
    return `<app-button variant="ghost" size="sm" icon-only data-revoke-kind="${kind}"
      data-revoke-id="${escAttr(id)}" title="Revoke access for ${escAttr(name)}"
      aria-label="Revoke access for ${escAttr(name)}">${icons.trash()}</app-button>`;
  }

  // Delegated once on the table: app-table rebuilds its rows on every sort and
  // refresh, so per-button listeners would not survive the first column click.
  #wireAccessTable() {
    const table = this.querySelector('#acp-access-table');
    if (!table) return;
    table.addEventListener('click', (e) => {
      const revoke = e.target.closest('[data-revoke-kind]');
      if (revoke) {
        this.#revokeGrant(revoke.dataset.revokeKind, revoke.dataset.revokeId);
        return;
      }
      if (e.target.closest('[data-transfer-open]')) this.#openTransferModal();
    });
  }

  async #revokeGrant(kind, granteeId) {
    const confirmed = await confirmDialog({
      title: 'Revoke access',
      message: 'Revoke this access grant? The user or team will lose access to this agent.',
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!confirmed) return;
    const paths = { user: 'users', team: 'teams', department: 'departments', agent: 'agents' };
    try {
      const res = await apiFetch(
        `/agents/${encodeURIComponent(this.#agent.id)}/grants/${paths[kind]}/${encodeURIComponent(granteeId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok && res.status !== 404) throw new Error(await res.text());
      showToast('Access revoked');
    } catch (err) {
      showToast(`Failed to revoke: ${err.message}`);
      return;
    }
    this.#loadAccess();
  }

  /* ── Grant-access modal ────────────────────────────────────────────────── */

  #modalsHtml() {
    return `
      <app-modal id="acp-grant-modal" heading="Grant access">
        <div class="acp-grant-form">
          <div class="acp-field">
            <span class="acp-field-label">Grant type</span>
            <div class="acp-grant-types" id="acp-grant-types" role="group" aria-label="Grant type"></div>
          </div>
          <div class="acp-picker">
            <app-input id="acp-grant-query" label="User" placeholder="Search users"
              autocomplete="off"><span data-slot="leading">${icons.search()}</span></app-input>
            <div class="acp-picker-results" id="acp-grant-results" hidden></div>
          </div>
          <div class="acp-picker-picked" id="acp-grant-picked" hidden></div>
          <p class="form-error" id="acp-grant-error" hidden></p>
        </div>
        <div data-slot="footer">
          <app-button variant="tertiary" size="md" id="acp-grant-cancel">Cancel</app-button>
          <app-button variant="primary" size="md" id="acp-grant-submit" disabled>Grant access</app-button>
        </div>
      </app-modal>
      <app-modal id="acp-transfer-modal" heading="Transfer ownership">
        <div class="acp-grant-form">
          <p class="acp-section-sub">The new owner gains full control of this agent — its grants, secrets, and lifecycle. You keep access only if a grant covers you.</p>
          <div class="acp-picker">
            <app-input id="acp-transfer-query" label="New owner" placeholder="Search users"
              autocomplete="off"><span data-slot="leading">${icons.search()}</span></app-input>
            <div class="acp-picker-results" id="acp-transfer-results" hidden></div>
          </div>
          <div class="acp-picker-picked" id="acp-transfer-picked" hidden></div>
          <p class="form-error" id="acp-transfer-error" hidden></p>
        </div>
        <div data-slot="footer">
          <app-button variant="tertiary" size="md" id="acp-transfer-cancel">Cancel</app-button>
          <app-button variant="primary" size="md" id="acp-transfer-submit" disabled>Transfer ownership</app-button>
        </div>
      </app-modal>
      <app-modal id="acp-reupload-modal" heading="Re-upload agent">
        <div class="acp-grant-form">
          <p class="acp-section-sub">Uploads a new source archive and queues a build. The running
            container is replaced once the build succeeds.</p>
          <label class="acp-field">
            <span class="acp-field-label">Source archive (.zip)</span>
            <input type="file" id="acp-reupload-file" accept=".zip,application/zip" required />
          </label>
          <div class="acp-field">
            <app-input id="acp-reupload-version" label="Version" value="patch"
              autocomplete="off"></app-input>
            <span class="acp-field-hint">A semver string (e.g. 1.2.3), or one of
              <code>auto</code>, <code>patch</code>, <code>minor</code>, <code>major</code>.</span>
          </div>
          <app-input id="acp-reupload-changelog" label="Changelog (optional)"
            autocomplete="off" placeholder="What changed in this version?"></app-input>
          <p class="form-error" id="acp-reupload-error" hidden></p>
        </div>
        <div data-slot="footer">
          <app-button variant="tertiary" size="md" id="acp-reupload-cancel">Cancel</app-button>
          <app-button variant="primary" size="md" id="acp-reupload-submit">Queue build</app-button>
        </div>
      </app-modal>
      <app-modal id="acp-rollback-modal" heading="Roll back version">
        <div class="acp-grant-form">
          <p class="acp-section-sub" id="acp-rollback-summary"></p>
          <app-input id="acp-rollback-reason" label="Reason (optional)" autocomplete="off"
            placeholder="Recorded against the rollback build"></app-input>
          <p class="form-error" id="acp-rollback-error" hidden></p>
        </div>
        <div data-slot="footer">
          <app-button variant="tertiary" size="md" id="acp-rollback-cancel">Cancel</app-button>
          <app-button variant="primary" size="md" id="acp-rollback-submit">Roll back</app-button>
        </div>
      </app-modal>`;
  }

  #openGrantModal() {
    this.#grantPicked = null;
    this.#grantType = 'user';
    this.#renderGrantTypes();
    this.#setPicked('grant', null);
    const query = this.querySelector('#acp-grant-query');
    query.value = '';
    query.setAttribute('label', 'User');
    query.setAttribute('placeholder', 'Search users');
    this.querySelector('#acp-grant-results').hidden = true;
    this.querySelector('#acp-grant-error').hidden = true;
    this.querySelector('#acp-grant-modal').open();
    query.focus();
  }

  /**
   * The grant-type chips are `<app-tag selectable>` — the design system's filter
   * chip, which is what this control has always looked like. A tag toggles
   * itself, so single-select is enforced here: the tag that fired wins and every
   * sibling is cleared, and re-clicking the active one keeps it selected rather
   * than leaving the group with no type.
   */
  #renderGrantTypes() {
    const isEe = Array.isArray(this.#access?.teams) || Array.isArray(this.#access?.departments);
    const el = this.querySelector('#acp-grant-types');
    el.innerHTML = GRANT_TYPES
      .filter((t) => !t.eeOnly || isEe)
      .map((t) => `
        <app-tag class="acp-grant-type" size="sm" selectable data-key="${t.key}"
          ${t.key === this.#grantType ? 'selected' : ''}>${t.label}</app-tag>`).join('');
    el.addEventListener('tag-change', (e) => {
      const tag = e.target;
      tag.selected = true;
      for (const peer of el.querySelectorAll('app-tag')) {
        if (peer !== tag) peer.selected = false;
      }
      if (tag.dataset.key === this.#grantType) return;
      this.#grantType = tag.dataset.key;
      this.#setPicked('grant', null);
      const query = this.querySelector('#acp-grant-query');
      query.value = '';
      const type = GRANT_TYPES.find((t) => t.key === this.#grantType);
      query.setAttribute('label', type ? type.label : 'User');
      query.setAttribute('placeholder', `Search ${this.#grantType}s`);
      this.querySelector('#acp-grant-results').hidden = true;
    });
  }

  #wireGrantModal() {
    const query = this.querySelector('#acp-grant-query');
    query.addEventListener('input', this.#debounce(async () => {
      await this.#searchInto(this.#grantType, query.value, '#acp-grant-results', (picked) => {
        this.#setPicked('grant', picked);
      });
    }, 250));
    this.querySelector('#acp-grant-cancel').addEventListener('click', () =>
      this.querySelector('#acp-grant-modal').close());
    this.querySelector('#acp-grant-submit').addEventListener('click', () => this.#submitGrant());
  }

  #wireTransferModal() {
    const query = this.querySelector('#acp-transfer-query');
    query.addEventListener('input', this.#debounce(async () => {
      await this.#searchInto('user', query.value, '#acp-transfer-results', (picked) => {
        this.#setPicked('transfer', picked);
      });
    }, 250));
    this.querySelector('#acp-transfer-cancel').addEventListener('click', () =>
      this.querySelector('#acp-transfer-modal').close());
    this.querySelector('#acp-transfer-submit').addEventListener('click', () => this.#submitTransfer());
  }

  #openTransferModal() {
    this.#setPicked('transfer', null);
    const query = this.querySelector('#acp-transfer-query');
    query.value = '';
    this.querySelector('#acp-transfer-results').hidden = true;
    this.querySelector('#acp-transfer-error').hidden = true;
    this.querySelector('#acp-transfer-modal').open();
    query.focus();
  }

  #setPicked(which, picked) {
    if (which === 'grant') this.#grantPicked = picked; else this.#transferPicked = picked;
    const chip = this.querySelector(`#acp-${which}-picked`);
    const submit = this.querySelector(`#acp-${which}-submit`);
    if (!chip || !submit) return;
    if (picked) {
      chip.innerHTML = `<app-tag class="acp-chip" size="sm" removable>${escHtml(picked.label)}</app-tag>`;
      chip.hidden = false;
      // app-tag removes itself on click; the page clears the selection behind it.
      chip.querySelector('app-tag').addEventListener('tag-remove', () => this.#setPicked(which, null));
    } else {
      chip.innerHTML = '';
      chip.hidden = true;
    }
    submit.disabled = !picked;
  }

  // Searches the picker source for a grant type and renders clickable results.
  async #searchInto(type, rawQuery, resultsSelector, onPick) {
    const results = this.querySelector(resultsSelector);
    const q = rawQuery.trim();
    if (q.length < 2) {
      results.hidden = true;
      return;
    }
    let options = [];
    try {
      options = await this.#searchGrantees(type, q);
    } catch {
      options = [];
    }
    results.innerHTML = options.length
      ? options.map((o, i) => `<button type="button" class="acp-picker-option" data-i="${i}">
          <span class="acp-picker-option-label">${escHtml(o.label)}</span>
          ${o.sub ? `<span class="acp-picker-option-sub">${escHtml(o.sub)}</span>` : ''}
        </button>`).join('')
      : '<div class="acp-picker-none">No matches</div>';
    results.hidden = false;
    results.querySelectorAll('.acp-picker-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        onPick(options[Number(btn.dataset.i)]);
        results.hidden = true;
      });
    });
  }

  async #searchGrantees(type, q) {
    const enc = encodeURIComponent(q);
    if (type === 'user') {
      const resp = await fetchApi(`/search/users?q=${enc}`);
      return (resp?.data || []).map((u) => ({ id: u.id, label: u.display_name || u.username, sub: u.email || '' }));
    }
    if (type === 'agent') {
      const resp = await fetchApi(`/search/agents?q=${enc}`);
      return (resp?.agents || [])
        .filter((r) => r.id !== this.#agent.id)
        .map((r) => ({ id: r.id, label: r.display_name || r.name, sub: '' }));
    }
    if (type === 'team') {
      const resp = await fetchApi(`/search/teams?q=${enc}`);
      return (resp?.data || []).map((t) => ({ id: t.id, label: t.name, sub: '' }));
    }
    const resp = await fetchApi(`/search/departments?q=${enc}`);
    return (resp?.data || []).map((d) => ({ id: d.id, label: d.name, sub: d.description || '' }));
  }

  async #submitGrant() {
    if (!this.#grantPicked) return;
    const err = this.querySelector('#acp-grant-error');
    err.hidden = true;
    try {
      await this.#grantEntity(this.#grantType, this.#grantPicked.id);
      this.querySelector('#acp-grant-modal').close();
      showToast(`Access granted to ${this.#grantPicked.label}`);
      this.#granteeTab = { user: 'users', team: 'teams', department: 'departments', agent: 'agents' }[this.#grantType];
      this.#loadAccess();
    } catch (e) {
      err.textContent = `Failed to grant access: ${e.message}`;
      err.hidden = false;
    }
  }

  // EE mounts POST /grants/{kind}/{id}; OSS mounts POST /grants/{kind} with a
  // JSON body. Try the path form first — on OSS it answers 405 (the path only
  // serves DELETE there), never a false success — then fall back.
  async #grantEntity(type, granteeId) {
    const kind = { user: 'users', team: 'teams', department: 'departments', agent: 'agents' }[type];
    const base = `/agents/${encodeURIComponent(this.#agent.id)}/grants/${kind}`;
    const res = await apiFetch(`${base}/${encodeURIComponent(granteeId)}`, { method: 'POST' });
    if (res.ok) return;
    if (res.status !== 404 && res.status !== 405) throw new Error(await res.text());
    const bodyKey = type === 'user' ? 'user_id' : 'agent_id';
    const fallback = await apiFetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [bodyKey]: granteeId }),
    });
    if (!fallback.ok) throw new Error(await fallback.text());
  }

  async #submitTransfer() {
    if (!this.#transferPicked) return;
    const transferConfirmed = await confirmDialog({
      title: 'Transfer ownership',
      message: `Transfer ownership to <strong>${this.#transferPicked.label}</strong>? This cannot be undone.`,
      confirmLabel: 'Transfer',
      danger: true,
    });
    if (!transferConfirmed) return;
    const err = this.querySelector('#acp-transfer-error');
    err.hidden = true;
    try {
      // OSS expects {new_owner_id}, EE expects {owner_id} — send both keys;
      // each edition deserializes its own and ignores the other.
      const res = await apiFetch(`/agents/${encodeURIComponent(this.#agent.id)}/owner`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner_id: this.#transferPicked.id, new_owner_id: this.#transferPicked.id }),
      });
      if (!res.ok) throw new Error(await res.text());
      this.querySelector('#acp-transfer-modal').close();
      showToast(`Ownership transferred to ${this.#transferPicked.label}`);
      this.#load();
    } catch (e) {
      err.textContent = `Failed to transfer: ${e.message}`;
      err.hidden = false;
    }
  }

  /* ── Configure tab (MCP servers + LLM router) ──────────────────────────── */

  #configurePanelHtml(a) {
    return `
        <div class="acp-panel" data-tab="configure" data-label="Configure">
          <section class="acp-section">
            <h2 class="acp-section-title">MCP</h2>
            <p class="acp-section-sub">MCP servers this agent may use. Allow or block each tool individually.</p>
            <div id="acp-mcp-list">${this.#rowSkeletonHtml(2, '64px')}</div>
          </section>
          <section class="acp-section">
            <h2 class="acp-section-title">LLM router</h2>
            <p class="acp-section-sub">Which models this agent runs on. Overrides here apply to this agent only.</p>
            <agent-llm-config agent-id="${escAttr(a.id)}"></agent-llm-config>
          </section>
        </div>`;
  }

  async #loadConfigure() {
    this.#configureLoaded = true;
    const list = this.querySelector('#acp-mcp-list');
    if (!list) return;
    try {
      const resp = await call('fetchAgentMcpConnectors', this.#agent.id);
      this.#connectors = resp?.data?.connectors || [];
    } catch (e) {
      list.innerHTML = `<p class="acp-section-sub">Failed to load MCP connectors: ${escHtml(e.message)}</p>`;
      return;
    }
    // Fetch every connector's tools up front so each card can show its
    // "{n} of {m} tools allowed" summary without waiting for an expand.
    await Promise.all(this.#connectors.map(async (c) => {
      try {
        const resp = await call('fetchAgentMcpConnectorTools', this.#agent.id, c.connector_id);
        this.#connectorTools.set(c.connector_id, resp?.data?.tools || []);
      } catch {
        this.#connectorTools.set(c.connector_id, []);
      }
    }));
    this.#renderConnectors();
  }

  #renderConnectors() {
    const list = this.querySelector('#acp-mcp-list');
    if (!list) return;
    if (!this.#connectors.length) {
      list.innerHTML = `<app-empty-state
        heading="No MCP servers available"
        description="Connect servers on the MCP page to make their tools available here."
        icon="${escAttr(icons.server('', 32))}"></app-empty-state>`;
      return;
    }
    list.innerHTML = this.#connectors.map((c) => this.#connectorCardHtml(c)).join('');
    this.#wireConnectors(list);
  }

  #connectorCardHtml(c) {
    const name = c.display_name || c.name || 'Connector';
    const tools = this.#connectorTools.get(c.connector_id) || [];
    const allowed = tools.filter((t) => t.stance !== 'block').length;
    const summary = c.enabled === false
      ? 'Disabled'
      : tools.length ? `${allowed} of ${tools.length} tools allowed` : 'No tools synced yet';
    const open = this.#openConnectors.has(c.connector_id);
    const logo = c.logo_url
      ? `<img class="acp-mcp-logo" src="${escAttr(c.logo_url)}" alt="" />`
      : `<span class="acp-mcp-initial">${escHtml(name.charAt(0).toUpperCase())}</span>`;
    return `
      <div class="acp-mcp-card${c.enabled === false ? ' is-disabled' : ''}" data-connector="${escAttr(c.connector_id)}">
        <div class="acp-mcp-head">
          <app-button variant="ghost" size="sm" icon-only class="acp-mcp-toggle-open"
            aria-expanded="${open}"
            aria-label="${open ? 'Collapse' : 'Expand'} ${escAttr(name)}"
            >${open ? icons.chevronUp() : icons.chevronDown()}</app-button>
          ${logo}
          <span class="acp-mcp-name">${escHtml(name)}</span>
          <span class="acp-mcp-summary">${escHtml(summary)}</span>
          <app-switch class="acp-mcp-enable-input" size="sm"
            aria-label="${c.enabled === false ? 'Enable' : 'Disable'} ${escAttr(name)}"
            ${c.enabled === false ? '' : 'checked'}></app-switch>
        </div>
        ${open ? this.#connectorToolsHtml(c, tools) : ''}
      </div>`;
  }

  #connectorToolsHtml(c, tools) {
    const disabled = c.enabled === false;
    const note = disabled
      ? `<div class="acp-mcp-note">${icons.info('', 12)} This server is disabled for this agent — tool rules apply once it is re-enabled.</div>`
      : '';
    if (!tools.length) {
      return `<div class="acp-mcp-tools">${note}<div class="acp-mcp-note">This connector exposes no tools yet.</div></div>`;
    }
    return `
      <div class="acp-mcp-tools">
        ${note}
        ${tools.map((t, i) => {
          const group = `stance-${c.connector_id}-${i}`;
          const opt = (stance, label, on) => `
            <label>
              <input type="radio" name="${escAttr(group)}" value="${stance}"
                data-tool-index="${i}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              ${label}
            </label>`;
          return `
          <div class="acp-mcp-tool${disabled ? ' is-dim' : ''}">
            <span class="acp-mcp-tool-name">${escHtml(t.name)}</span>
            <span class="acp-mcp-tool-desc">${escHtml(t.description || '')}</span>
            <fieldset class="seg-ctrl acp-stance" aria-label="Tool access for ${escAttr(t.name)}">
              ${opt('allow', 'Allow', t.stance !== 'block')}
              ${opt('block', 'Block', t.stance === 'block')}
            </fieldset>
          </div>`;
        }).join('')}
      </div>`;
  }

  #wireConnectors(list) {
    list.querySelectorAll('.acp-mcp-card').forEach((card) => {
      const connectorId = card.dataset.connector;
      card.querySelector('.acp-mcp-toggle-open').addEventListener('click', () => {
        if (this.#openConnectors.has(connectorId)) this.#openConnectors.delete(connectorId);
        else this.#openConnectors.add(connectorId);
        this.#renderConnectors();
      });
      card.querySelector('.acp-mcp-enable-input').addEventListener('change', (e) =>
        this.#setConnectorEnabled(connectorId, e.target.checked));
      card.querySelectorAll('.acp-stance input[type="radio"]').forEach((radio) => {
        radio.addEventListener('change', () =>
          this.#setToolStance(connectorId, Number(radio.dataset.toolIndex), radio.value));
      });
    });
  }

  async #setConnectorEnabled(connectorId, enabled) {
    const connector = this.#connectors.find((c) => c.connector_id === connectorId);
    try {
      await call('setAgentMcpConnectorAccess', this.#agent.id, connectorId, enabled);
      if (connector) connector.enabled = enabled;
    } catch (e) {
      showToast(`Failed to update access: ${e.message}`);
    }
    this.#renderConnectors();
  }

  // Applies one Allow/Block click by re-saving the connector's full rule set —
  // PUT /api/mcp/agents/{id}/tools replaces rules per connector mentioned in
  // the batch, so unmentioned connectors keep their rules.
  async #setToolStance(connectorId, toolIndex, stance) {
    const tools = this.#connectorTools.get(connectorId) || [];
    const tool = tools[toolIndex];
    if (!tool || tool.stance === stance) return;
    const previous = tool.stance;
    tool.stance = stance;
    this.#renderConnectors();
    try {
      const rules = tools.map((t) => ({
        connector_id: connectorId,
        tool_pattern: t.name,
        stance: t.stance === 'block' ? 'block' : 'allow',
      }));
      await call('saveAgentMcpToolRules', this.#agent.id, rules);
    } catch (e) {
      tool.stance = previous;
      this.#renderConnectors();
      showToast(`Failed to save tool rule: ${e.message}`);
    }
  }

  /* ── Settings tab ──────────────────────────────────────────────────────── */

  #settingsPanelHtml(a) {
    return `
        <div class="acp-panel" data-tab="settings" data-label="Settings">
          <section class="acp-section">
            <h2 class="acp-section-title">Agent identity</h2>
            <form class="acp-identity" id="acp-identity-form">
              <app-input id="acp-display-name" label="Display name"
                value="${escAttr(a.display_name || a.name)}" maxlength="120"
                hint="Shown wherever this agent appears in Nasiko."></app-input>
              <label class="acp-field">
                <span class="acp-field-label">Description</span>
                <textarea id="acp-description" rows="3">${escHtml(a.description || '')}</textarea>
                <span class="acp-field-hint">Explain what this agent does for the people you share it with.</span>
              </label>
              <app-input label="Agent ID" value="${escAttr(a.id)}" readonly
                hint="Generated when the agent was first published."></app-input>
              <div class="acp-identity-actions">
                <app-button type="submit" size="md" variant="primary">Save changes</app-button>
              </div>
            </form>
          </section>
          <section class="acp-section">
            <h2 class="acp-section-title">Agent configuration</h2>
            <dl class="acp-dl">
              <div><dt>Image</dt><dd><code>${escHtml(a.image || '—')}</code></dd></div>
              <div><dt>Port</dt><dd>${escHtml(String(a.port || '—'))}</dd></div>
              <div><dt>Status</dt><dd><app-badge variant="${a.status === 'running' ? 'success' : a.status === 'error' ? 'error' : 'warning'}">${a.status || 'unknown'}</app-badge></dd></div>
              <div><dt>Replicas</dt><dd>${a.replicas ?? '—'}</dd></div>
            </dl>
          </section>
          <section class="acp-section">
            <secrets-manager id="acp-secrets" scope="agent" defer
              agent-id="${escAttr(a.id)}"
              heading="Secrets"
              description="Environment secrets injected into this agent's container at deploy time. Values are write-only."></secrets-manager>
          </section>
          <section class="acp-section acp-danger">
            <h3 class="acp-danger-title">Danger zone</h3>
            <p class="acp-section-sub">Deleting this agent removes it from the registry, revokes all grants, and stops its container.</p>
            <app-button variant="danger" size="md" data-action="delete">${icons.trash()} Delete agent</app-button>
          </section>
        </div>`;
  }

  #wireSettings() {
    const identityForm = this.querySelector('#acp-identity-form');
    identityForm?.addEventListener('submit', (e) => this.#saveIdentity(e));
  }

  async #saveIdentity(e) {
    e.preventDefault();
    const displayName = this.querySelector('#acp-display-name').value.trim();
    const description = this.querySelector('#acp-description').value.trim();
    if (!displayName) {
      showToast('Display name cannot be empty');
      return;
    }
    try {
      await fetchApi(`/agents/${encodeURIComponent(this.#agent.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: displayName, description }),
      });
    } catch (err) {
      showToast(`Failed to save: ${err.message}`);
      return;
    }
    this.#agent.display_name = displayName;
    this.#agent.description = description;
    document.title = `Nasiko — ${displayName}`;
    const h1 = this.querySelector('.acp-name');
    if (h1) h1.textContent = displayName;
    showToast('Agent details saved');
  }

  /* ── Overview stats ────────────────────────────────────────────────────── */

  async #loadStats() {
    const el = this.querySelector('#acp-stats');
    if (!el) return;

    // Renders in place of the skeletons. A section that can't answer must say
    // so — silently returning leaves four skeletons pulsing forever, which is
    // indistinguishable from a hung page.
    const unavailable = (description) => {
      el.innerHTML = `<div class="acp-stats-empty"><app-empty-state
        heading="Metrics unavailable"
        description="${escAttr(description)}"
        icon="${escAttr(icons.trace('', 32))}"></app-empty-state></div>`;
    };

    let stats;
    try {
      // Same endpoint/shape as `nasiko observe stats`: {data:{project:{...}}}.
      const resp = await fetchApi(`/observability/agent/${this.#agentId}/stats`);
      stats = resp?.data?.project;
    } catch {
      // 503 when TEMPO_URL/LOKI_URL aren't configured, or any transport error.
      unavailable("The observability backend did not answer, so recent metrics can't be shown.");
      return;
    }

    if (!stats) {
      unavailable('The observability backend returned no data for this agent.');
      return;
    }

    const hasData = (stats.trace_count != null && stats.trace_count > 0) ||
                    (stats.cost_summary?.total?.cost > 0);

    if (!hasData) {
      el.innerHTML = `
        <div class="acp-stats-empty">
          <app-empty-state
            heading="No usage data yet"
            description="Stats will appear after the first request to this agent."
            icon="${escAttr(icons.trace('', 32))}">
          </app-empty-state>
        </div>`;
      return;
    }

    const fmtInt = (n) => n == null ? '—' : Number(n).toLocaleString();
    const fmtCost = (n) => {
      if (n == null) return '—';
      const v = +n;
      if (v === 0) return '$0';
      if (v < 0.01) return `$${v.toFixed(4)}`;
      return `$${v.toFixed(2)}`;
    };
    const fmtMs = (n) => n == null ? '—' : `${Math.round(n)} ms`;

    el.innerHTML = `
      <div class="acp-stat"><div class="acp-stat-label">Traces</div><div class="acp-stat-value">${fmtInt(stats.trace_count)}</div></div>
      <div class="acp-stat"><div class="acp-stat-label">Total cost</div><div class="acp-stat-value">${fmtCost(stats.cost_summary?.total?.cost)}</div></div>
      <div class="acp-stat"><div class="acp-stat-label">P50 latency</div><div class="acp-stat-value">${fmtMs(stats.latency_ms_p50)}</div></div>
      <div class="acp-stat"><div class="acp-stat-label">P99 latency</div><div class="acp-stat-value">${fmtMs(stats.latency_ms_p99)}</div></div>
    `;
  }

  /**
   * Container CPU / memory / network for this agent.
   *
   * Owner-scoped endpoint (`/observability/agent/{ref}/resources`), ACL-checked
   * server-side — deliberately not the admin whole-box endpoint, so this section
   * works for an agent's owner without exposing the rest of the host.
   */
  async #loadResourceUsage() {
    const el = this.querySelector('#acp-resources');
    if (!el) return;

    let usage;
    let state = '';
    try {
      const resp = await call('fetchAgentResourceStats', this.#agentId);
      usage = resp?.data?.usage ?? null;
      state = resp?.data?.usage?.state ?? '';
    } catch {
      // 503 on a runtime that cannot report usage, or 403 if access was revoked
      // mid-session. Either way there is nothing to show — say so rather than
      // leaving skeletons spinning forever.
      el.innerHTML = `<div class="acp-stats-empty"><app-empty-state
        heading="Usage unavailable"
        description="Container resource usage could not be read for this agent."
        icon="${escAttr(icons.cube('', 32))}"></app-empty-state></div>`;
      return;
    }

    // `usage: null` is the normal answer for an agent with no container right now
    // — scaled to zero or never deployed. Not an error.
    if (!usage) {
      el.innerHTML = `<div class="acp-stats-empty"><app-empty-state
        heading="Not running"
        description="This agent has no running container, so there is nothing to measure."
        icon="${escAttr(icons.cube('', 32))}"></app-empty-state></div>`;
      return;
    }

    const fmtBytes = (n) => {
      if (!n) return '0 B';
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let v = n;
      let i = 0;
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
      return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
    };
    const meter = (pct) => {
      if (pct == null || Number.isNaN(pct)) return '';
      // Only the bar width is clamped — CPU legitimately exceeds 100% on
      // multi-core containers, and the label and severity must report that
      // rather than announce a capped 100%.
      const width = Math.max(0, Math.min(100, pct));
      const sev = pct >= 90 ? 'is-crit' : pct >= 70 ? 'is-warn' : 'is-ok';
      const word = pct >= 90 ? 'critical' : pct >= 70 ? 'high' : 'normal';
      return `<div class="acp-meter ${sev}" role="img" aria-label="${pct.toFixed(0)} percent, ${word}"><i style="width:${width.toFixed(1)}%"></i></div>`;
    };

    const cpuKnown = usage.cpu_percent != null;
    const memPct = usage.mem_limit_bytes
      ? (usage.mem_used_bytes / usage.mem_limit_bytes) * 100
      : null;

    el.innerHTML = `
      <div class="acp-stat">
        <div class="acp-stat-label">CPU</div>
        <div class="acp-stat-value">${cpuKnown ? `${usage.cpu_percent >= 10 ? usage.cpu_percent.toFixed(0) : usage.cpu_percent.toFixed(1)}%` : '—'}</div>
        ${cpuKnown ? meter(usage.cpu_percent) : '<div class="acp-stat-sub">not reporting</div>'}
        ${cpuKnown ? '<div class="acp-stat-sub">of one core</div>' : ''}
      </div>
      <div class="acp-stat">
        <div class="acp-stat-label">Memory</div>
        <div class="acp-stat-value">${fmtBytes(usage.mem_used_bytes)}</div>
        ${meter(memPct)}
        ${usage.mem_limit_bytes ? `<div class="acp-stat-sub">of ${fmtBytes(usage.mem_limit_bytes)}</div>` : ''}
      </div>
      <div class="acp-stat">
        <div class="acp-stat-label">Network</div>
        <div class="acp-stat-value">${fmtBytes(usage.net_rx_bytes)}</div>
        <div class="acp-stat-sub">in · ${fmtBytes(usage.net_tx_bytes)} out${state ? ` · ${escHtml(state)}` : ''}</div>
      </div>
    `;
  }

  /* ── Logs tab ──────────────────────────────────────────────────────────── */

  #logsPanelHtml() {
    return `
        <div class="acp-panel" data-tab="logs" data-label="Logs">
          <section class="acp-section">
            <div class="acp-logs-toolbar">
              <div class="acp-logs-toolbar-start">
                <h2 class="acp-section-title">Container logs</h2>
              </div>
              <div class="acp-logs-toolbar-end">
                <label class="acp-logs-tail-label">
                  Lines:
                  <app-select size="sm" id="acp-logs-tail"
                    options='[{"value":"50","label":"50"},{"value":"100","label":"100"},{"value":"500","label":"500"}]'
                    value="100"></app-select>
                </label>
                <app-button variant="secondary" size="sm" id="acp-logs-follow"
                  aria-pressed="true" title="Auto-scroll to latest logs"
                  >${icons.arrowDown()} Follow</app-button>
              </div>
            </div>
            <div class="acp-logs-viewer" id="acp-logs-viewer">
              <app-skeleton lines="12" height="320px"></app-skeleton>
            </div>
          </section>
        </div>`;
  }

  #wireLogsControls() {
    const tailSelect = this.querySelector('#acp-logs-tail');
    tailSelect?.addEventListener('change', () => {
      this.#logsTail = Number(tailSelect.value);
      this.#logsLoaded = false;
      this.#loadLogs();
    });
    const followBtn = this.querySelector('#acp-logs-follow');
    followBtn?.addEventListener('click', () => {
      this.#logsFollowing = !this.#logsFollowing;
      // The on state is the brand-tinted `secondary`; off is the hairline
      // `tertiary`. Same component either way, so the box never shifts.
      followBtn.setAttribute('variant', this.#logsFollowing ? 'secondary' : 'tertiary');
      followBtn.setAttribute('aria-pressed', String(this.#logsFollowing));
      if (this.#logsFollowing) this.#scrollLogsToBottom();
    });
  }

  async #loadLogs() {
    const viewer = this.querySelector('#acp-logs-viewer');
    if (!viewer) return;

    if (!this.#logsLoaded) {
      viewer.innerHTML = '<app-skeleton lines="12" height="320px"></app-skeleton>';
    }

    try {
      const logs = await fetchApi(`/observability/agents/${this.#agentId}/logs?limit=${this.#logsTail}`);
      this.#logsLoaded = true;

      if (!logs || logs.length === 0) {
        viewer.innerHTML = `
          <div class="acp-logs-empty">
            <app-empty-state
              heading="No logs available"
              description="This agent has not produced any log output yet.">
            </app-empty-state>
          </div>`;
        return;
      }

      const linesHtml = logs.map((line, i) => {
        const ts = this.#formatLogTimestamp(line.timestamp);
        return `<div class="acp-log-line">` +
          `<span class="acp-log-num">${i + 1}</span>` +
          `<span class="acp-log-ts">${escHtml(ts)}</span>` +
          `<app-badge class="acp-log-badge" variant="${this.#levelVariant(line.level)}">${escHtml(line.level || 'info')}</app-badge>` +
          `<span class="acp-log-msg">${ansiToHtml(line.message)}</span>` +
          `</div>`;
      }).join('');

      viewer.innerHTML = `<div class="acp-logs-scroll">${linesHtml}</div>`;

      if (this.#logsFollowing) {
        this.#scrollLogsToBottom();
      }
    } catch {
      this.#logsLoaded = false;
      viewer.innerHTML = `
        <div class="acp-logs-empty">
          <app-empty-state
            heading="Failed to load logs"
            description="Could not fetch logs for this agent. The agent may not be running.">
          </app-empty-state>
        </div>`;
    }
  }

  #scrollLogsToBottom() {
    const scroll = this.querySelector('.acp-logs-scroll');
    if (scroll) {
      scroll.scrollTop = scroll.scrollHeight;
    }
  }

  #formatLogTimestamp(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  #levelVariant(level) {
    // Server emits uppercase levels (ERROR/WARN/INFO/DEBUG); structured logs can
    // pass through abbreviations (ERR/WRN/DBG/TRC) verbatim.
    const l = String(level || '').toUpperCase();
    if (l.startsWith('ERR') || l.startsWith('CRIT') || l.startsWith('FATAL')) return 'error';
    if (l.startsWith('WARN') || l === 'WRN') return 'warning';
    if (l.startsWith('DEB') || l === 'DBG' || l.startsWith('TRA') || l === 'TRC') return 'neutral';
    if (l.startsWith('INF')) return 'info';
    return 'neutral';
  }

  /* ── Utilities ─────────────────────────────────────────────────────────── */

  #debounce(fn, ms) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  #shortId(id) {
    const s = String(id || '');
    return s.length > 12 ? `${s.slice(0, 8)}…` : s;
  }

}

customElements.define('agent-card-page', AgentCardPage);
