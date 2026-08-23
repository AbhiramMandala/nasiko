import { icons } from '/common/utils/icons.js';
import { apiFetch, fetchApi } from '/common/services/api.js';
import { timeAgo } from '/common/utils/date-utils.js';
import '/common/design-system/app-skeleton/app-skeleton.js';
import '/common/design-system/app-input/app-input.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import { setFieldError, clearFieldErrors } from '/common/utils/field-error.js';
import { toast } from '/common/utils/toast.js';

import styles from './secrets-manager.css' with { type: 'css' };
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/**
 * <secrets-manager> — the single secrets surface for every scope.
 *
 * Lists secret names (values are write-only and never returned by the API),
 * adds/replaces one from an inline row, and deletes one behind an inline
 * confirm. No modals, no alert()/confirm().
 *
 * Usage:
 *   <secrets-manager scope="user" heading="Secrets" description="..."></secrets-manager>
 *
 *   const el = document.createElement('secrets-manager');
 *   el.setAttribute('scope', 'agent');
 *   el.agentId = '<uuid>';
 *
 * Attributes:
 *   scope="user|agent"  which API backs it (default "user")
 *   agent-id="<uuid>"   required for scope="agent" (or set `.agentId`)
 *   heading="..."       section heading; omit for a headless embed
 *   description="..."   sub-line under the heading
 *   readonly            read-only mode — no add row, no delete buttons
 *   defer               don't fetch on connect; the host calls .refresh()
 *
 * Events:
 *   secrets-changed  {detail:{scope, action:'add'|'remove', name}} after a mutation
 */

/** Human copy for the empty state, per scope. */
const EMPTY_COPY = {
  user: 'No secrets yet. Add one below — agents and router configs reference it by name.',
  agent: 'No secrets configured for this agent yet. Add one below.',
};

/** Reason a list request can fail with no rows to show. */
const FORBIDDEN_COPY = {
  user: 'Your session cannot read these secrets.',
  agent: 'You need owner access to manage this agent’s secrets.',
};

/**
 * Scope adapters — the one and only place the two secret APIs differ.
 *
 * Everything below this object is scope-agnostic and talks to `{list, add,
 * remove}` alone.
 *
 * user  (oss/server/src/secrets/routes.rs:19-25)
 *   GET    /api/secrets            -> ApiResponse { data: [{id,name,created_at,updated_at}] }
 *   POST   /api/secrets            {name,value} — upsert (ON CONFLICT DO UPDATE)
 *   DELETE /api/secrets/{name}
 * agent (oss/server/src/catalog/agent_secrets.rs:18-31)
 *   GET    /api/agents/{id}/secrets        -> bare [{name, updated_at}] (no envelope)
 *   POST   /api/agents/{id}/secrets        {name,value} — upsert (jsonb_set)
 *   DELETE /api/agents/{id}/secrets/{name}
 */
const SCOPE_ADAPTERS = {
  user: () => ({
    list: async () => {
      const body = await fetchApi('/secrets');
      return toEntries(body?.data ?? body);
    },
    // POST upserts, so it covers both "add" and "replace"; PUT /secrets/{name}
    // is update-only (404 when absent) and would need a second round trip.
    add: (name, value) => sendJson('/secrets', 'POST', { name, value }),
    remove: (name) => sendJson(`/secrets/${encodeURIComponent(name)}`, 'DELETE'),
  }),

  agent: (agentId) => {
    const base = `/agents/${encodeURIComponent(agentId)}/secrets`;
    return {
      list: async () => toEntries(await fetchApi(base)),
      add: (name, value) => sendJson(base, 'POST', { name, value }),
      remove: (name) => sendJson(`${base}/${encodeURIComponent(name)}`, 'DELETE'),
    };
  },
};

/** Mutating call that returns no body worth parsing; throws the server's text. */
async function sendJson(path, method, body) {
  const opts = { method };
  if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await apiFetch(path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text.trim() || `HTTP ${res.status}`);
  }
}

/** Normalize either list shape into `{name, updatedAt}` rows, sorted by name. */
function toEntries(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => ({ name: s?.name || '', updatedAt: s?.updated_at || s?.created_at || null }))
    .filter((s) => s.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Env-var shape — secrets land in container env, so shell identifier rules. */
const NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

class SecretsManager extends HTMLElement {
  #initialized = false;
  #adapter = null;
  #secrets = [];
  #status = 'loading';   // 'loading' | 'ready' | 'denied'
  #pendingDelete = null; // name awaiting inline confirm
  #busy = false;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#renderShell();
    if (!this.hasAttribute('defer')) this.refresh();
  }

  set agentId(value) { this.setAttribute('agent-id', value ?? ''); }

  get agentId() { return this.getAttribute('agent-id') || ''; }

  get scope() { return this.getAttribute('scope') === 'agent' ? 'agent' : 'user'; }

  get readOnly() { return this.hasAttribute('readonly'); }

  /** Public: (re)load the list. Safe to call repeatedly; hosts use it to lazy-load. */
  async refresh() {
    if (!this.#initialized) return;
    this.#pendingDelete = null;
    try {
      this.#secrets = await this.#scopeAdapter().list();
      this.#status = 'ready';
    } catch {
      this.#secrets = [];
      this.#status = 'denied';
    }
    this.#renderList();
    this.#syncAddRow();
  }

  /* ── Rendering ────────────────────────────────────────────────────────── */

  #renderShell() {
    const heading = this.getAttribute('heading');
    const description = this.getAttribute('description');
    this.innerHTML = `
      ${heading ? `<h2 class="sm-title">${esc(heading)}</h2>` : ''}
      ${description ? `<p class="sm-sub">${esc(description)}</p>` : ''}
      <div class="sm-list" id="sm-list"><app-skeleton lines="3" height="88px"></app-skeleton></div>
      <form class="sm-add" id="sm-add" novalidate hidden>
        <app-input id="sm-name" label="Name" placeholder="API_KEY"
          maxlength="128" autocomplete="off"
          spellcheck="false" required></app-input>
        <app-input id="sm-value" label="Value" type="password" placeholder="sk-…"
          autocomplete="off" required></app-input>
        <app-button type="submit" id="sm-submit">
          ${icons.plus('', 14)} Add secret
        </app-button>
      </form>`;

    this.querySelector('#sm-add')?.addEventListener('submit', (e) => this.#onAdd(e));
    this.querySelector('#sm-list')?.addEventListener('click', (e) => this.#onListClick(e));
  }

  #renderList() {
    const list = this.querySelector('#sm-list');
    if (!list) return;
    if (this.#status === 'denied') {
      list.innerHTML = `<p class="sm-note">${FORBIDDEN_COPY[this.scope]}</p>`;
      return;
    }
    if (!this.#secrets.length) {
      list.innerHTML = `
        <app-empty-state icon="${esc(icons.lock('', 32))}"
          description="${esc(EMPTY_COPY[this.scope])}"></app-empty-state>`;
      return;
    }
    list.innerHTML = `<ul class="sm-rows">${this.#secrets.map((s) => this.#rowHtml(s)).join('')}</ul>`;
  }

  #rowHtml(secret) {
    const name = esc(secret.name);
    if (this.#pendingDelete === secret.name) {
      return `
        <li class="sm-row">
          <span class="sm-name">${icons.lock('', 13)} ${name}</span>
          <span class="sm-confirm-text">Delete this secret?</span>
          <app-button variant="ghost" size="sm" data-cancel>Cancel</app-button>
          <app-button variant="danger" size="sm" data-confirm="${name}">Delete</app-button>
        </li>`;
    }
    return `
      <li class="sm-row">
        <span class="sm-name">${icons.lock('', 13)} ${name}</span>
        <span class="sm-value">••••••••</span>
        <span class="sm-meta">${secret.updatedAt ? `Updated ${esc(timeAgo(secret.updatedAt))}` : ''}</span>
        ${this.readOnly ? '' : `
        <app-button variant="ghost" size="sm" icon-only
          data-delete="${name}"
          aria-label="Delete secret ${name}">${icons.trash('', 14)}</app-button>`}
      </li>`;
  }

  /** The add row and its read-only note follow permission + load state. */
  #syncAddRow() {
    const form = this.querySelector('#sm-add');
    if (!form) return;
    form.hidden = this.readOnly || this.#status === 'denied';
  }

  /* ── Mutations ────────────────────────────────────────────────────────── */

  async #onAdd(e) {
    e.preventDefault();
    if (this.#busy) return;
    const nameInput = this.querySelector('#sm-name');
    const valueInput = this.querySelector('#sm-value');
    const name = nameInput.value.trim();
    // The form is `novalidate`: the browser's own bubble says only "Please match
    // the format requested", which never tells the user what the format is.
    clearFieldErrors(nameInput, valueInput);
    if (!name) {
      setFieldError(nameInput, 'Enter a secret name.');
      return;
    }
    if (!NAME_PATTERN.test(name)) {
      setFieldError(nameInput, 'Use A–Z, 0–9 and _ only, starting with a letter or _ — e.g. API_KEY.');
      return;
    }
    if (!valueInput.value) {
      setFieldError(valueInput, 'Enter a value.');
      return;
    }

    this.#setBusy(true);
    try {
      await this.#scopeAdapter().add(name, valueInput.value);
    } catch (err) {
      toast.error(`Could not save ${name}: ${err.message}`);
      this.#setBusy(false);
      return;
    }
    nameInput.value = '';
    valueInput.value = '';
    this.#setBusy(false);
    toast.success(this.#savedCopy(name));
    this.#emitChanged('add', name);
    await this.refresh();
  }

  async #onListClick(e) {
    const deleteBtn = e.target.closest('[data-delete]');
    if (deleteBtn) {
      this.#pendingDelete = deleteBtn.dataset.delete;
      this.#renderList();
      return;
    }
    if (e.target.closest('[data-cancel]')) {
      this.#pendingDelete = null;
      this.#renderList();
      return;
    }
    const confirmBtn = e.target.closest('[data-confirm]');
    if (confirmBtn) await this.#remove(confirmBtn.dataset.confirm);
  }

  async #remove(name) {
    if (this.#busy) return;
    this.#setBusy(true);
    try {
      await this.#scopeAdapter().remove(name);
    } catch (err) {
      toast.error(`Could not delete ${name}: ${err.message}`);
      this.#setBusy(false);
      return;
    }
    this.#setBusy(false);
    toast.success(`${name} deleted.`);
    this.#emitChanged('remove', name);
    await this.refresh();
  }

  /* ── Internals ────────────────────────────────────────────────────────── */

  #scopeAdapter() {
    if (!this.#adapter) this.#adapter = SCOPE_ADAPTERS[this.scope](this.agentId);
    return this.#adapter;
  }

  #savedCopy(name) {
    return this.scope === 'agent'
      ? `${name} saved — restart the agent to apply.`
      : `${name} saved.`;
  }

  #setBusy(busy) {
    this.#busy = busy;
    // `loading` shows app-button's spinner AND disables it — a plain `disabled`
    // greys the button with no indication that a request is in flight.
    this.querySelector('#sm-submit')?.toggleAttribute('loading', busy);
  }

  #emitChanged(action, name) {
    this.dispatchEvent(new CustomEvent('secrets-changed', {
      bubbles: true,
      detail: { scope: this.scope, action, name },
    }));
  }
}

customElements.define('secrets-manager', SecretsManager);
