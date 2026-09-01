import { setFieldError } from '/common/utils/field-error.js';
import { escAttr, escHtml } from '/common/utils/escape.js';
import { apiFetch } from '/common/services/api.js';
import { icons } from '/common/utils/icons.js';
import '/common/design-system/app-modal/app-modal.js';
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./add-agent-page.css', import.meta.url));
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-card/app-card.js';
import '/common/design-system/app-input/app-input.js';
import { navigate as routerNavigate } from '../core/router.js';
// Importing an agent is a step in the Agent registry module, so it carries that
// module's tree. add-agent-page.css already had the `align-self: stretch` rule
// for the mobile disclosure bar; nothing was mounting the element it styles.
import '/common/features/app-module-nav.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/// Mirrors the server's `validate_version_tag` (oss/server/src/build/routes.rs),
/// which every uploaded agent name must satisfy because it becomes part of an
/// OCI image reference.
const AGENT_NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

/// Best-effort coercion of arbitrary text into a valid agent name. Returns ''
/// when nothing usable survives, so the caller still asks the user.
function sanitizeAgentName(raw) {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')  // spaces, parens, slashes → separator
    .replace(/^[^a-zA-Z0-9_]+/, '')     // leading . or - is rejected by the server
    .replace(/-{2,}/g, '-')
    .replace(/-+$/, '')
    .slice(0, 128);
  return AGENT_NAME_RE.test(cleaned) ? cleaned : '';
}

/// Null when `name` is acceptable, otherwise the reason to show the user.
function agentNameError(name) {
  if (!name) return 'An agent name is required.';
  if (AGENT_NAME_RE.test(name)) return null;
  if (name.length > 128) return 'Agent name must be 128 characters or fewer.';
  if (!/^[a-zA-Z0-9_]/.test(name)) return 'Agent name must start with a letter, digit or underscore.';
  return 'Agent name may only contain letters, digits, dots, underscores and hyphens.';
}

class AddAgentPage extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <app-module-nav module="agents"></app-module-nav>
      <span class="page-icon">${icons.cube('', 28)}</span>
      <h1 class="title-page">Import new agent</h1>
      <p class="page-subtitle">Choose how you would like to register your agent.</p>

      <a class="cli-banner" href="/setup-cli">
        <span class="cli-banner-icon">${icons.terminal('', 18)}</span>
        <span class="cli-banner-text">
          <span class="cli-banner-title">Set up CLI</span>
          <span class="cli-banner-sub">Prefer the terminal? Build, test, and publish agents with the Nasiko CLI.</span>
        </span>
        <span class="cli-banner-chevron">${icons.chevronRight('', 16)}</span>
      </a>

      <div class="method-grid">
        ${this.#methodCard({
          icon: icons.github('', 22), id: 'btn-github', title: 'Import from GitHub',
          req: 'Requires GitHub authentication', cta: 'Connect GitHub',
          desc: 'Pull your agent from a GitHub repository. Keep code and metadata in sync.',
        })}
        ${this.#methodCard({
          icon: icons.upload('', 22), id: 'btn-upload', title: 'Upload a code package',
          req: 'Include skill.json in the package', cta: 'Upload .zip',
          desc: 'Register your agent with a .zip that includes source and config.',
        })}
        ${this.#methodCard({
          icon: icons.layers('', 22), id: 'btn-oci', title: 'Import from OCI registry',
          req: "You'll need the image URL", cta: 'Connect registry',
          desc: 'Pull a pre-built agent image directly from any OCI-compatible container registry.',
        })}
      </div>

      <app-modal id="upload-modal" heading="Upload agent package">
        <div class="upload-form">
          <label class="field">
            <span class="field-label">Source archive (.zip)</span>
            <input type="file" id="upload-file" accept=".zip,application/zip" required />
          </label>
          <div class="field">
            <app-input id="upload-name" label="Agent name" autocomplete="off"
                       placeholder="my-agent"></app-input>
            <span class="field-hint">Letters, digits, dots, underscores and hyphens; must start with
              a letter, digit or underscore. Pre-filled from the file name.</span>
          </div>
          <p class="form-error" id="upload-error" hidden></p>
        </div>
        <div data-slot="footer">
          <app-button variant="tertiary" size="md" id="upload-cancel">Cancel</app-button>
          <app-button variant="primary" size="md" id="upload-submit">Upload and deploy</app-button>
        </div>
      </app-modal>

      <app-modal id="oci-modal" heading="Import from OCI registry">
        <div class="upload-form" id="oci-form">
          <div class="field">
            <app-input id="oci-ref" label="Artifact reference" autocomplete="off"
                       spellcheck="false"
                       placeholder="registry.example.com/owner/my-agent:v1.0"></app-input>
            <span class="field-hint">Format <code>registry.host/owner/name[:tag]</code>; defaults to
              <code>:latest</code>. The host must be allow-listed on the server.</span>
          </div>
          <p class="form-error" id="oci-error" hidden></p>
        </div>
        <div class="agent-card-setup" id="oci-progress" hidden>
          <div class="setup-progress">
            <span class="setup-spinner"></span>
            <span class="setup-label">Setting up…</span>
          </div>
          <p class="setup-hint">Pulling the image and starting the container. This may take a few
            minutes. You can close this dialog and it will continue running in the background.</p>
        </div>
        <div data-slot="footer">
          <app-button variant="tertiary" size="md" id="oci-cancel">Cancel</app-button>
          <app-button variant="primary" size="md" id="oci-submit">Import and deploy</app-button>
        </div>
      </app-modal>
    `;

    this.querySelector('#btn-github')?.addEventListener('click', () => {
      routerNavigate('/add-agent-github');
    });

    this.#checkGithubStatus();
    this.#wireUploadModal();
    this.#wireOciModal();
  }

  /** One import-method tile. */
  #methodCard({ icon, id, title, req, desc, cta }) {
    return `
      <app-card name="${escAttr(title)}">
        <span slot="leading">${icon}</span>
        <div slot="body" class="method-body">
          <div class="method-card-req">${escHtml(req)}</div>
          <div class="method-card-desc">${escHtml(desc)}</div>
          <app-button class="method-btn" variant="primary" block id="${escAttr(id)}">${escHtml(cta)}</app-button>
        </div>
      </app-card>`;
  }

  /// The import runs synchronously server-side (build/pull + deploy inside the
  /// request), so the request — not the dialog — is what has to survive: hence a
  /// real "setting up" state in the body, and an unload guard, because leaving
  /// the page aborts the fetch, which drops the handler and strands the agent
  /// in `deploying`. Closing the dialog is harmless; the fetch keeps going.
  #wireOciModal() {
    const modal = this.querySelector('#oci-modal');
    // app-modal has no isOpen(); the internal <dialog> is a plain child.
    const dialogEl = modal.querySelector('dialog');
    const form = this.querySelector('#oci-form');
    const progress = this.querySelector('#oci-progress');
    const refEl = this.querySelector('#oci-ref');
    const errorEl = this.querySelector('#oci-error');
    const submitEl = this.querySelector('#oci-submit');

    const blockUnload = (e) => e.preventDefault();
    const setBusy = (busy) => {
      form.hidden = busy;
      progress.hidden = !busy;
      modal.toggleAttribute('hide-footer', busy);
      if (busy) window.addEventListener('beforeunload', blockUnload);
      else window.removeEventListener('beforeunload', blockUnload);
    };

    this.querySelector('#btn-oci').addEventListener('click', () => {
      refEl.value = '';
      errorEl.hidden = true;
      setBusy(false);
      modal.open();
    });
    this.querySelector('#oci-cancel').addEventListener('click', () => modal.close());
    refEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitEl.click(); });

    submitEl.addEventListener('click', async () => {
      const reference = refEl.value.trim();
      errorEl.hidden = true;
      // Mirrors the server's parse (oss/server/src/catalog/import.rs): the
      // reference must carry a registry host, otherwise it 400s.
      const [repoWithHost] = reference.split(':');
      if (!repoWithHost.includes('/')) {
        setFieldError(refEl, 'Enter a full reference: registry.host/owner/name[:tag].');
        return;
      }
      setFieldError(refEl, null);

      setBusy(true);
      try {
        const res = await apiFetch('/import/registry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reference }),
        });
        if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
        setBusy(false);  // drops the unload guard, so it can't outlive the import
        // Don't yank someone who dismissed the dialog and moved on.
        if (dialogEl.open) window.location.href = '/agents.html?view=your-agents';
        else this.#toast('Agent imported. See Your agents.');
      } catch (err) {
        setBusy(false);
        if (!dialogEl.open) { this.#toast(`Import failed: ${err.message}`); return; }
        errorEl.textContent = `Import failed: ${err.message}`;
        errorEl.hidden = false;
      }
    });
  }

  async #checkGithubStatus() {
    try {
      const res = await apiFetch('/auth/github/token');
      const body = await res.json();
      if (body.status === 'connected') {
        const card = this.querySelector('#btn-github')?.closest('app-card');
        if (!card) return;
        const req = card.querySelector('.method-card-req');
        const btn = this.querySelector('#btn-github');
        if (req) { req.textContent = `Connected as ${body.username || 'GitHub user'}`; req.classList.add('connected'); }
        // `label`, not textContent: assigning text to an <app-button> would
        // replace the inner <button> it rendered with a bare text node.
        if (btn) btn.label = 'Import from GitHub';
      }
    } catch { /* leave default text */ }
  }

  /// The agent name becomes part of an OCI image reference, so the server
  /// enforces `[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}` on it (`validate_version_tag`).
  /// A raw file name routinely violates that ("My Agent.zip", "agent (1).zip"),
  /// which used to surface as an unexplained 400 with no way to correct it —
  /// hence a real form: sanitized suggestion, editable, validated before send.
  #wireUploadModal() {
    const modal = this.querySelector('#upload-modal');
    const fileEl = this.querySelector('#upload-file');
    const nameEl = this.querySelector('#upload-name');
    const errorEl = this.querySelector('#upload-error');
    const submitEl = this.querySelector('#upload-submit');

    this.querySelector('#btn-upload')?.addEventListener('click', () => {
      fileEl.value = '';
      nameEl.value = '';
      setFieldError(nameEl, null);
      errorEl.hidden = true;
      modal.open();
    });

    this.querySelector('#upload-cancel').addEventListener('click', () => modal.close());

    // Suggest a name from the chosen file, but never overwrite one the user
    // has already typed.
    fileEl.addEventListener('change', () => {
      const file = fileEl.files[0];
      if (!file || nameEl.value.trim()) return;
      nameEl.value = sanitizeAgentName(file.name.replace(/\.zip$/i, ''));
    });

    submitEl.addEventListener('click', async () => {
      const file = fileEl.files[0];
      const name = nameEl.value.trim();
      errorEl.hidden = true;

      if (!file) {
        this.#showUploadError('Choose a .zip archive to upload.');
        return;
      }
      // A message about what is in one control belongs on that control —
      // `state="error"` + `hint`, which app-input already renders. `.form-error`
      // is for failures with no single field to blame (the upload itself).
      const invalid = agentNameError(name);
      if (invalid) {
        setFieldError(nameEl, invalid);
        return;
      }
      setFieldError(nameEl, null);

      const formData = new FormData();
      formData.append('name', name);
      formData.append('file', file);

      submitEl.disabled = true;
      try {
        const res = await apiFetch('/agents/upload', { method: 'POST', body: formData });
        if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
        routerNavigate('/your-agents');
      } catch (err) {
        this.#showUploadError(`Upload failed: ${err.message}`);
      } finally {
        submitEl.disabled = false;
      }
    });
  }

  #showUploadError(message) {
    const el = this.querySelector('#upload-error');
    el.textContent = message;
    el.hidden = false;
  }
  async #toast(message) {
    const { showToast } = await import('/common/utils/toast.js');
    showToast(message);
  }
}

customElements.define('add-agent-page', AddAgentPage);
