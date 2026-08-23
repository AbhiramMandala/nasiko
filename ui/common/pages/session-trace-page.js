import { icons } from '/common/utils/icons.js';
import '/common/design-system/app-empty-state/app-empty-state.js';

import styles from './session-trace-page.css' with { type: 'css' };
import { escHtml } from '/common/utils/escape.js';
import { call } from '../core/data-sources.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/**
 * Redirect stub for the retired trace-scoped view.
 *
 * `/session-trace?trace_id=…` used to render its own flat span list.
 * That showed strictly less than the Observability session view for the same
 * data (no span detail, no attributes, no chat transcript), so the two pages
 * are consolidated onto `/observability-session`. This keeps old links
 * and bookmarks working: resolve the trace to its session via the trace
 * payload's `project_session_id`, then hand off with the trace preselected.
 *
 * @element session-trace-page
 */
class SessionTracePage extends HTMLElement {
  connectedCallback() {
    const traceId = new URLSearchParams(location.search).get('trace_id')
      || this.getAttribute('trace-id');
    if (!traceId) {
      this.innerHTML = `<app-empty-state title="No trace ID specified"
        description="Open a trace from a session to inspect it."
        icon='${icons.faceFrown("", 40)}'></app-empty-state>`;
      return;
    }
    document.title = `Nasiko — Trace ${traceId.slice(0, 12)}`;
    this.#redirect(traceId);
  }

  async #redirect(traceId) {
    let sessionId = new URLSearchParams(location.search).get('session_id') || '';
    if (!sessionId) {
      try {
        const trace = await call('fetchTraceDetail', traceId);
        sessionId = trace?.project_session_id || '';
      } catch {
        // Fall through to the manual escape hatch below.
      }
    }
    if (sessionId) {
      const q = new URLSearchParams({ session_id: sessionId, trace_id: traceId });
      // replace() so Back returns to the chat, not to this interstitial.
      location.replace(`/observability-session?${q}`);
      return;
    }
    // A trace with no session mapping can't open the session view. Say so
    // rather than bouncing to a page that would 404 on an empty session id.
    this.innerHTML = `
      <div class="trace-header">
        <a class="back-link" href="javascript:history.back()">${icons.chevronLeft('', 16)} Back</a>
        <h1>${escHtml(traceId)}</h1>
      </div>
      <app-empty-state
        title="This trace isn't linked to a session yet"
        description="Agent spans reach the trace backend a few seconds after a reply finishes. Try refreshing in a moment, or open the session from Execution history."
        icon='${icons.faceFrown("", 40)}'></app-empty-state>
    `;
  }

}

customElements.define('session-trace-page', SessionTracePage);
