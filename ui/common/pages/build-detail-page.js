/**
 * Build detail — one agent image build (record from GET /api/builds/{id}).
 *
 * @element build-detail-page
 * @note Streams status transitions from GET /api/builds/{id}/progress (SSE)
 *       while the build is in flight; raw logs are linked via logs_url.
 */
import { apiFetch } from '/common/services/api.js';
import { connectSSE } from '/common/services/sse.js';
import { icons } from '/common/utils/icons.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-button/app-button.js';
import '/common/utils/back-link.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-skeleton/app-skeleton.js';
import '/common/design-system/app-stat-row/app-stat-row.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./build-detail-page.css', import.meta.url));
import { escHtml } from '/common/utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const STATUS_VARIANTS = { success: 'success', building: 'info', failed: 'error', queued: 'neutral', cancelled: 'warning', pending: 'neutral' };

class BuildDetailPage extends HTMLElement {
  #initialized = false;
  #buildId = null;
  #evtSource = null;

  #toolbar(sub = '', badge = '') {
    // Back sits at the leading edge, ahead of the title — the same place every
    // detail page puts it — and is the design system's tertiary icon button
    // rather than a page-local `.back-link` anchor. `href` keeps it a real link
    // (the SPA router intercepts it), so no click handler is needed.
    return `<header class="page-head">
      <app-button variant="tertiary" size="sm" icon-only href="/builds" data-back
        aria-label="Back to builds" title="Back to builds">${icons.chevronLeft()}</app-button>
      <div>
        <div class="title-row">
          <h1 class="title-page">Build detail</h1>
          ${badge}
        </div>
        ${sub ? `<p class="page-sub">${sub}</p>` : ''}
      </div>
    </header>`;
  }

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#buildId = new URLSearchParams(location.search).get('id');
    if (!this.#buildId) {
      this.innerHTML = `${this.#toolbar()}
        <app-empty-state
          heading="No build selected"
          description="Open a build from the list to inspect it."
          icon='${icons.briefcase("", 40)}'></app-empty-state>`;
      return;
    }
    this.innerHTML = `${this.#toolbar()}${this.#loadingBodyHtml()}`;
    this.#load();
  }

  disconnectedCallback() {
    this.#evtSource?.close();
    this.#evtSource = null;
  }

  /**
   * Placeholder for the body while the build record loads. The real layout
   * below is three differently-shaped pieces — a KPI strip, a details
   * table, and a log viewer — so the loading state shimmers as three
   * pieces too, instead of one slab that doesn't resemble any of them.
   * The KPI strip reuses <app-stat-row>'s own `loading` skeleton rather
   * than a hand-rolled one, so it can't drift from the real geometry.
   */
  #loadingBodyHtml() {
    const detailRow = () => '<div class="detail-row"><app-skeleton height="12px" style="width:5ch;"></app-skeleton><app-skeleton height="12px" style="width:60%;"></app-skeleton></div>';
    return `
      <app-stat-row loading="3"></app-stat-row>
      <h2 class="section-title">Details</h2>
      <div class="detail-rows">${Array.from({ length: 4 }, detailRow).join('')}</div>
      <h2 class="section-title">Build log</h2>
      <app-skeleton height="160px" radius="md"></app-skeleton>`;
  }

  async #load() {
    let build = null;
    try {
      const res = await apiFetch(`/builds/${this.#buildId}`);
      if (res.ok) build = await res.json();
    } catch { /* fall through to not-found */ }
    if (!build) {
      this.innerHTML = `${this.#toolbar()}
        <app-empty-state
          heading="Build not found"
          description="This build may have been pruned or the ID is wrong."
          icon='${icons.faceFrown("", 40)}'></app-empty-state>`;
      return;
    }

    const shortId = String(build.id).slice(0, 8);
    document.title = `Nasiko — Build #${shortId}`;
    const variant = STATUS_VARIANTS[build.status] || 'neutral';
    const fmtTs = (v) => v ? new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

    this.innerHTML = `${this.#toolbar(
      `<span class="is-mono">#${escHtml(shortId)}</span> · ${escHtml(build.image_reference || '')}`,
      `<app-badge variant="${variant}" dot>${escHtml(build.status)}</app-badge>`)}
      <app-stat-row id="kpi-strip"></app-stat-row>

      <h2 class="section-title">Details</h2>
      <div class="detail-rows">
        <div class="detail-row"><span class="detail-key">Image</span><span class="detail-val">${escHtml(build.image_reference || '—')}</span></div>
        <div class="detail-row"><span class="detail-key">Agent</span><span class="detail-val">${escHtml(build.agent_id || '—')}</span></div>
        <div class="detail-row"><span class="detail-key">Commit</span><span class="detail-val">${escHtml(build.commit_hash ? build.commit_hash.slice(0, 12) : '—')}</span></div>
        <div class="detail-row"><span class="detail-key">Source</span><span class="detail-val">${build.github_url ? `<a class="detail-link" href="${escHtml(build.github_url)}" target="_blank" rel="noopener">${escHtml(build.github_url)} ↗</a>` : '—'}</span></div>
      </div>

      <div class="section-head">
        <h2 class="section-title">Build log</h2>
        ${build.logs_url ? `<a class="detail-link" href="${escHtml(build.logs_url)}" target="_blank" rel="noopener">Raw logs ↗</a>` : ''}
      </div>
      <div class="log-viewer" id="log-viewer">${this.#initialLogLines(build)}</div>
    `;

    // Status is the header badge, not a cell: <app-stat-row> escapes every value,
    // and a build's outcome deserves the colour a plain string can't carry.
    this.querySelector('#kpi-strip').items = [
      { label: 'Version', value: build.version_tag || '—' },
      { label: 'Started', value: fmtTs(build.created_at) },
      { label: 'Updated', value: fmtTs(build.updated_at) },
    ];

    if (build.status === 'building' || build.status === 'queued' || build.status === 'pending') {
      this.#connectSSE();
    }
  }

  #initialLogLines(build) {
    const lines = [
      `<span class="log-line"><span class="ts">${escHtml(this.#logTs(build.created_at))}</span>build ${escHtml(String(build.id))} created</span>`,
      `<span class="log-line"><span class="ts">${escHtml(this.#logTs(build.updated_at))}</span>status: ${escHtml(build.status)}</span>`,
    ];
    if (!build.logs_url && (build.status === 'building' || build.status === 'queued' || build.status === 'pending')) {
      lines.push('<span class="log-line is-muted">waiting for status updates…</span>');
    }
    return lines.join('\n');
  }

  #logTs(v) {
    return v ? new Date(v).toLocaleTimeString(undefined, { hour12: false }) : '';
  }

  #connectSSE() {
    const viewer = this.querySelector('#log-viewer');
    // connectSSE (not raw EventSource) so the multi-tenant dashboard streams from
    // the workspace control plane via apiBase; it also JSON-parses each event.
    this.#evtSource = connectSSE(`/builds/${this.#buildId}/progress`, {
      onMessage: (update) => {
        const status = update && update.status;
        if (!status) return;
        const cls = status === 'failed' ? ' is-error' : '';
        viewer.innerHTML += `\n<span class="log-line${cls}"><span class="ts">${escHtml(new Date().toLocaleTimeString(undefined, { hour12: false }))}</span>status: ${escHtml(status)}</span>`;
        viewer.scrollTop = viewer.scrollHeight;
        if (status === 'success' || status === 'failed' || status === 'not_found') {
          this.#evtSource?.close();
          this.#evtSource = null;
          if (status !== 'not_found') this.#load();
        }
      },
      onError: () => { this.#evtSource?.close(); this.#evtSource = null; },
    });
  }

}

customElements.define('build-detail-page', BuildDetailPage);
