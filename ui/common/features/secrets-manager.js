import { icons } from '/common/utils/icons.js';
import { apiFetch, fetchApi } from '/common/services/api.js';
import { timeAgo } from '/common/utils/date-utils.js';
import '/common/design-system/app-skeleton/app-skeleton.js';
import '/common/design-system/app-input/app-input.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import { setFieldError, clearFieldErrors } from '/common/utils/field-error.js';
import { toast } from '/common/utils/toast.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./secrets-manager.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/**
 * <secrets-manager> — the single secrets surface for every scope.
 *
 * Lists secret names, adds/replaces one from an inline row, and deletes one
 * behind an inline confirm. No modals, no alert()/confirm().
 *
 * A row's value is never in the list payload. `scope="user"` can fetch one on
 * demand (`GET /api/secrets/{name}` decrypts with a per-user key and is scoped
 * to the caller's own rows, so it can only ever hand you your own secret) — that
 * backs the per-row reveal and copy. `scope="agent"` has no read-value route at
 * all, so those rows get neither button; the adapter's missing `read` is what
 * decides it, not a flag.
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
  user: 'No secrets yet. Add one below. Agents and router configs reference secrets by name.',
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
 *   GET    /api/secrets/{name}     -> ApiResponse { data: {name, value} } — decrypted
 *   POST   /api/secrets            {name,value} — upsert (ON CONFLICT DO UPDATE)
 *   DELETE /api/secrets/{name}
 * agent (oss/server/src/catalog/agent_secrets.rs:18-31) — no read-value route
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
    read: async (name) => {
      const body = await fetchApi(`/secrets/${encodeURIComponent(name)}`);
      return (body?.data ?? body)?.value ?? '';
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

/// How long a revealed value stays on screen before it re-masks itself. Short
/// enough that a shared screen or a walked-away-from laptop doesn't leave a key
/// sitting there, long enough to read it out or copy it. Matches the same
/// decision in `ee/tenant/src/components/SecretField.jsx`.
const AUTO_REMASK_MS = 30_000;

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
  /** name -> plaintext, for rows the user has revealed. Populated only by an
   *  explicit click; nothing here ever arrives with the list. */
  #revealed = new Map();
  /** name -> re-mask timer, so a value doesn't sit on screen indefinitely. */
  #maskTimers = new Map();
  #revealing = null;     // name whose fetch is in flight
  #copying = null;       // name whose copy is in flight

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#renderShell();
    if (!this.hasAttribute('defer')) this.refresh();
  }

  set agentId(value) { this.setAttribute('agent-id', value ?? ''); }

  get agentId() { return this.getAttribute('agent-id') || ''; }

  get scope() { return this.getAttribute('scope') === 'agent' ? 'agent' : 'user'; }

  /** Every timer has to die with the element, or a pending re-mask fires against
   *  a detached tree and the revealed values outlive the page that showed them. */
  disconnectedCallback() { this.#maskAll(); }

  get readOnly() { return this.hasAttribute('readonly'); }

  /** Public: (re)load the list. Safe to call repeatedly; hosts use it to lazy-load. */
  async refresh() {
    if (!this.#initialized) return;
    this.#pendingDelete = null;
    this.#maskAll();
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
        <app-input id="sm-value" label="Value" type="password" reveal placeholder="sk-…"
          autocomplete="off" required></app-input>
        <app-button size="md" type="submit" id="sm-submit">
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
    const shown = this.#revealed.get(secret.name);
    const isShown = shown !== undefined;
    return `
      <li class="sm-row">
        <span class="sm-name">${icons.lock('', 13)} ${name}</span>
        <span class="sm-value${isShown ? ' is-shown' : ''}"${
          isShown ? ` title="${esc(shown)}"` : ''}>${isShown ? esc(shown) : '••••••••'}</span>
        <span class="sm-meta">${secret.updatedAt ? `Updated ${esc(timeAgo(secret.updatedAt))}` : ''}</span>
        <div class="sm-actions">
          ${this.#canReveal() ? `
          <app-button variant="ghost" size="sm" icon-only
            data-reveal-secret="${name}" aria-pressed="${isShown}"
            ${this.#revealing === secret.name ? 'loading' : ''}
            aria-label="${isShown ? 'Hide' : 'Show'} the value of ${name}">${
              isShown ? icons.eyeOff('', 14) : icons.eye('', 14)}</app-button>
          <app-button variant="ghost" size="sm" icon-only
            data-copy-secret="${name}"
            ${this.#copying === secret.name ? 'loading' : ''}
            aria-label="Copy the value of ${name}">${icons.copy('', 14)}</app-button>` : ''}
          ${this.readOnly ? '' : `
          <app-button variant="ghost" size="sm" icon-only
            data-delete="${name}"
            aria-label="Delete secret ${name}">${icons.trash('', 14)}</app-button>`}
        </div>

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
    // Not `[data-reveal]`: that is app-input's own show/hide hook, and the add
    // row's value field is a password input that has one.
    const revealBtn = e.target.closest('[data-reveal-secret]');
    if (revealBtn) {
      await this.#toggleReveal(revealBtn.dataset.revealSecret);
      return;
    }
    const copyBtn = e.target.closest('[data-copy-secret]');
    if (copyBtn) {
      await this.#copy(copyBtn.dataset.copySecret);
      return;
    }
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

  /* ── Reveal ───────────────────────────────────────────────────────────── */

  /** Only where the scope's API can actually return a value. `scope="agent"`
   *  has no read route, so its rows get no button rather than a broken one. */
  #canReveal() { return typeof this.#scopeAdapter().read === 'function'; }

  async #toggleReveal(name) {
    if (this.#revealed.has(name)) { this.#mask(name); this.#renderList(); return; }
    if (this.#revealing) return;          // one fetch at a time

    this.#revealing = name;
    this.#renderList();                   // paints the button's spinner
    try {
      const value = await this.#scopeAdapter().read(name);
      // The row can be gone by the time this lands — a delete or a refresh
      // between click and response — and re-adding it here would resurrect it.
      if (!this.#secrets.some((s) => s.name === name)) return;
      this.#revealed.set(name, value);
      this.#maskTimers.set(name, setTimeout(() => {
        this.#mask(name);
        this.#renderList();
      }, AUTO_REMASK_MS));
    } catch (err) {
      toast.error(`Could not read ${name}: ${err.message}`);
    } finally {
      this.#revealing = null;
      this.#renderList();
    }
  }

  /** Copy without revealing — the value goes to the clipboard, not onto the
   *  screen. Reuses an already-revealed value rather than fetching it twice. */
  async #copy(name) {
    if (this.#copying) return;
    // `navigator.clipboard` is undefined outside a secure context, and a
    // self-hosted control plane on plain HTTP is a real deployment — say why,
    // rather than failing silently on a button that looked like it worked.
    if (!navigator.clipboard?.writeText) {
      toast.error('Copying needs HTTPS or localhost.');
      return;
    }

    this.#copying = name;
    this.#renderList();
    try {
      const value = this.#revealed.has(name)
        ? this.#revealed.get(name)
        : await this.#scopeAdapter().read(name);
      await navigator.clipboard.writeText(value);
      toast.success(`${name} copied.`);
    } catch (err) {
      toast.error(`Could not copy ${name}: ${err.message}`);
    } finally {
      this.#copying = null;
      this.#renderList();
    }
  }

  #mask(name) {
    clearTimeout(this.#maskTimers.get(name));
    this.#maskTimers.delete(name);
    this.#revealed.delete(name);
  }

  /** Drops every revealed value and its timer. Called on teardown, and on every
   *  refresh — a re-listed secret may have been rewritten by someone else, and
   *  showing the old plaintext next to a new "Updated" stamp would be a lie. */
  #maskAll() {
    for (const name of [...this.#revealed.keys()]) this.#mask(name);
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
