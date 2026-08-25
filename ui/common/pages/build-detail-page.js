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
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-skeleton/app-skeleton.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./build-detail-page.css', import.meta.url));
import { escHtml } from '/common/utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const STATUS_VARIANTS = { success: 'success', building: 'info', failed: 'error', queued: 'neutral', cancelled: 'warning', pending: 'neutral' };

class BuildDetailPage extends HTMLElement {
  #initialized = false;
  #buildId = null;
  #evtSource = null;

  #toolbar(sub = '') {
    // Back sits at the leading edge, ahead of the title — the same place every
    // detail page puts it — and is the design system's tertiary icon button
    // rather than a page-local `.back-link` anchor. `href` keeps it a real link
    // (the SPA router intercepts it), so no click handler is needed.
    return `<header class="page-head">
      <app-button variant="tertiary" size="sm" icon-only href="/builds"
        aria-label="Back to builds" title="Back to builds">${icons.chevronLeft()}</app-button>
      <div>
        <h1 class="title-page">Build detail</h1>
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
          title="No build selected"
          description="Open a build from the list to inspect it."
          icon='${icons.briefcase("", 40)}'></app-empty-state>`;
      return;
    }
    this.innerHTML = `${this.#toolbar()}<app-skeleton height="300px"></app-skeleton>`;
    this.#load();
  }

  disconnectedCallback() {
    this.#evtSource?.close();
    this.#evtSource = null;
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
          title="Build not found"
          description="This build may have been pruned or the ID is wrong."
          icon='${icons.faceFrown("", 40)}'></app-empty-state>`;
      return;
    }

    const shortId = String(build.id).slice(0, 8);
    document.title = `Nasiko — Build #${shortId}`;
    const variant = STATUS_VARIANTS[build.status] || 'neutral';
    const fmtTs = (v) => v ? new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

    this.innerHTML = `${this.#toolbar(`<span class="is-mono">#${escHtml(shortId)}</span> · ${escHtml(build.image_reference || '')}`)}
      <div class="kpi-strip">
        <div class="kpi">
          <div class="kpi-label">Status</div>
          <div class="kpi-value"><app-badge variant="${variant}" dot>${escHtml(build.status)}</app-badge></div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Version</div>
          <div class="kpi-value is-mono">${escHtml(build.version_tag || '—')}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Started</div>
          <div class="kpi-value is-mono">${fmtTs(build.created_at)}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Updated</div>
          <div class="kpi-value is-mono">${fmtTs(build.updated_at)}</div>
        </div>
      </div>

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
