import { apiFetch } from '/common/services/api.js';
import { icons } from '/common/utils/icons.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-input/app-input.js';
import '/common/design-system/app-radio/app-radio.js';
import '/common/design-system/app-search/app-search.js';
import '/common/design-system/app-skeleton/app-skeleton.js';
import { escAttr, escHtml } from '/common/utils/escape.js';
import styles from './add-agent-github-page.css' with { type: 'css' };
import { navigate as routerNavigate } from '../core/router.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const GITHUB_ICON = `<svg class="gh-icon" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>`;

class AddAgentGithubPage extends HTMLElement {
  #allRepos = [];
  #selectedRepo = null;
  #branch = '';
  #agentName = '';
  #githubUsername = null;
  /** @type {number|null} */
  #pollTimer = null;

  connectedCallback() {
    this.innerHTML = `
      <app-button class="back-btn" variant="tertiary" size="sm" href="/add-agent">${
        icons.chevronLeft()} Back</app-button>
      <div class="page-head">
        <div>
          <h1 class="title-page">Import from GitHub</h1>
          <p class="subtitle">Connect your GitHub repository, configure options, and register it as an agent</p>
        </div>
      </div>

      <div class="page-layout">
        <div class="steps-col">
          <div class="step-section">
            <p class="step-label">Step 1/3</p>
            <p class="step-title">Select repository</p>
            <p class="step-desc">Choose a repository containing the agent source code</p>
            <app-search class="repo-search" placeholder="Filter repositories..."
              aria-label="Filter repositories"></app-search>
            <div class="repo-list">
              <div class="repo-item"><app-skeleton height="20px"></app-skeleton></div>
              <div class="repo-item"><app-skeleton height="20px"></app-skeleton></div>
              <div class="repo-item"><app-skeleton height="20px"></app-skeleton></div>
            </div>
          </div>

          <hr class="step-divider" />

          <div class="step-section step-two">
            <p class="step-label">Step 2/3</p>
            <p class="step-title">Configure options</p>
            <p class="step-desc step-two-desc">Please select a repository in step 1 first</p>
            <div class="config-fields" inert>
              <app-input class="branch-input" label="Branch" placeholder="main"
                hint="Leave blank to use the default branch" autocomplete="off"></app-input>
              <app-input class="name-input" label="Agent name" placeholder="Custom agent name"
                hint="Auto-detected from repository name. Override if needed"
                autocomplete="off"></app-input>
            </div>
          </div>

          <hr class="step-divider" />

          <div class="step-section step-three">
            <p class="step-label">Step 3/3</p>
            <p class="step-title">Clone and upload</p>
            <p class="step-desc">The selected repository will be cloned and registered as an agent</p>
            <app-button variant="primary" size="sm" class="clone-btn" disabled>Clone and upload</app-button>
          </div>
        </div>

        <div class="status-col">
          <div class="connect-status loading">
            <p class="connect-status-title">Checking GitHub connection...</p>
          </div>
        </div>
      </div>
    `;

    this.querySelector('.repo-search').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      const filtered = this.#allRepos.filter(r =>
        r.full_name.toLowerCase().includes(q) ||
        (r.description || '').toLowerCase().includes(q)
      );
      this.#renderRepos(filtered);
    });

    this.querySelector('.branch-input').addEventListener('input', (e) => {
      this.#branch = e.target.value;
    });
    this.querySelector('.name-input').addEventListener('input', (e) => {
      this.#agentName = e.target.value;
    });

    this.querySelector('.clone-btn').addEventListener('click', () => this.#doClone());

    this.#checkConnection();
  }

  async #checkConnection() {
    try {
      const tokenRes = await apiFetch('/auth/github/token');
      const tokenBody = await tokenRes.json();

      if (tokenBody.status === 'connected') {
        this.#githubUsername = tokenBody.username || 'GitHub user';
        this.#showConnectedBanner();
        this.#loadRepos();
      } else {
        this.#showDisconnectedBanner();
      }
    } catch {
      this.#showDisconnectedBanner();
    }
  }

  #showConnectedBanner() {
    const el = this.querySelector('.connect-status');
    el.className = 'connect-status connected';
    el.innerHTML = `
      <div class="connect-status-header">
        ${icons.checkCircle('', 16)}
        <span class="connect-status-title">Connected to GitHub</span>
      </div>
      <p class="connect-status-sub">Logged in as ${this.#githubUsername}</p>
      <div class="connect-status-actions">
        <app-button size="sm" variant="ghost" class="switch-account-btn">Switch account</app-button>
      </div>
    `;
    el.querySelector('.switch-account-btn')?.addEventListener('click', () => this.#logout());
  }

  #showDisconnectedBanner() {
    const el = this.querySelector('.connect-status');
    el.className = 'connect-status disconnected';
    el.innerHTML = `
      <div class="connect-status-header">
        ${GITHUB_ICON}
        <span class="connect-status-title">Connect to GitHub</span>
      </div>
      <p class="connect-status-sub">Authenticate to access your repositories</p>
      <div class="connect-status-actions">
        <app-button size="sm" variant="primary" class="login-gh-btn">Login with GitHub</app-button>
      </div>
    `;
    el.querySelector('.login-gh-btn').addEventListener('click', () => this.#startGithubAuth());

    // Disable the steps
    const repoList = this.querySelector('.repo-list');
    if (repoList) {
      repoList.innerHTML = '<div class="repo-item repo-note">Connect GitHub to view repositories.</div>';
    }
  }

  async #startGithubAuth() {
    const btn = this.querySelector('.login-gh-btn');
    if (btn) { btn.setAttribute('loading', ''); btn.label = 'Connecting...'; }

    try {
      const res = await apiFetch('/github/login');
      if (!res.ok) throw new Error((await res.text()) || 'Failed to start GitHub login');
      const { auth_url } = await res.json();
      if (!auth_url) throw new Error('No authorization URL returned');

      const popup = window.open(auth_url, 'github-auth', 'width=600,height=700');
      this.#pollForToken(popup);
    } catch (err) {
      if (btn) { btn.removeAttribute('loading'); btn.label = 'Login with GitHub'; }
      const { showToast } = await import('/common/utils/toast.js');
      showToast(`GitHub connect failed: ${err.message}`);
    }
  }

  /**
   * The GitHub OAuth poll is bounded (90 attempts) and self-clearing, so it
   * terminates on its own — but until it does, an element removed mid-poll keeps
   * firing an authenticated request every 2s and writing the result into detached
   * DOM. Tracked and cleared, same as mcp-page's popup poll.
   */
  disconnectedCallback() {
    clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  #pollForToken(popup) {
    let attempts = 0;
    const maxAttempts = 90;

    clearInterval(this.#pollTimer);
    const timer = (this.#pollTimer = setInterval(async () => {
      attempts++;
      if (attempts > maxAttempts) { clearInterval(timer); return; }
      if (popup && popup.closed) {
        clearInterval(timer);
        const btn = this.querySelector('.login-gh-btn');
        if (btn) { btn.removeAttribute('loading'); btn.label = 'Login with GitHub'; }
        return;
      }
      try {
        const res = await apiFetch('/auth/github/token');
        if (!res.ok) return;
        const body = await res.json();
        if (body.status === 'connected') {
          clearInterval(timer);
          if (popup && !popup.closed) popup.close();
          this.#githubUsername = body.username || 'GitHub user';
          this.#showConnectedBanner();
          this.#loadRepos();
        }
      } catch { /* keep polling */ }
    }, 2000));
  }

  async #logout() {
    try {
      await apiFetch('/github/logout', { method: 'DELETE' });
    } catch { /* best-effort */ }
    this.#githubUsername = null;
    this.#allRepos = [];
    this.#selectedRepo = null;
    this.#showDisconnectedBanner();
  }

  async #loadRepos() {
    const repoList = this.querySelector('.repo-list');
    if (!repoList) return;
    repoList.innerHTML = `
      <div class="repo-item"><app-skeleton height="20px"></app-skeleton></div>
      <div class="repo-item"><app-skeleton height="20px"></app-skeleton></div>
      <div class="repo-item"><app-skeleton height="20px"></app-skeleton></div>
    `;
    try {
      const res = await apiFetch('/github/repositories');
      if (res.status === 403) {
        this.#showDisconnectedBanner();
        return;
      }
      if (res.status === 404) {
        throw new Error('GitHub integration is not configured on this deployment.');
      }
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      const body = await res.json();
      this.#allRepos = Array.isArray(body) ? body : (body?.repositories || []);
      this.#renderRepos(this.#allRepos);
    } catch (err) {
      repoList.innerHTML = `<p class="repo-load-error">Failed to load repos: ${escHtml(err.message)}</p>`;
    }
  }

  #selectRepo(repo) {
    this.#selectedRepo = repo;
    this.#branch = repo.default_branch || 'main';
    this.#agentName = repo.name || repo.full_name.split('/').pop() || '';

    this.querySelector('.branch-input').value = this.#branch;
    this.querySelector('.name-input').value = this.#agentName;

    const fields = this.querySelector('.config-fields');
    fields.removeAttribute('inert');

    const desc = this.querySelector('.step-two-desc');
    desc.textContent = 'Configure repository options';

    this.querySelector('.clone-btn').removeAttribute('disabled');

    // Clicking anywhere on the row selects it, so the radio is checked here
    // rather than only by its own click. Same `name` on every one, so the
    // native group keeps them exclusive.
    this.querySelectorAll('.repo-radio').forEach(r => {
      r.checked = r.value === repo.full_name;
    });
  }

  async #doClone() {
    if (!this.#selectedRepo) return;
    this.#clearVersionConflictWarning();

    const payload = { repository_full_name: this.#selectedRepo.full_name };
    if (this.#branch) payload.branch = this.#branch;
    if (this.#agentName) payload.agent_name = this.#agentName;

    await this.#submitClone(payload);
  }

  async #submitClone(payload) {
    const btn = this.querySelector('.clone-btn');
    btn.setAttribute('loading', '');
    btn.label = 'Cloning and uploading...';

    try {
      const res = await apiFetch('/github/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      const body = await res.json();

      // A version conflict is rejected fast (no Docker build yet), so a
      // short poll here catches it before we navigate away. A real build
      // takes much longer, so the normal case still redirects right below.
      const conflict = body.upload_id ? await this.#waitForVersionConflict(body.upload_id) : null;
      if (conflict) {
        this.#showVersionConflictWarning(conflict, payload);
        return;
      }

      window.location.href = '/agents.html?view=your-agents';
    } catch (err) {
      btn.removeAttribute('loading');
      btn.label = 'Clone and upload';
      const { showToast } = await import('/common/utils/toast.js');
      showToast(`Clone failed: ${err.message}`);
    }
  }

  /**
   * Poll the upload's status for a "version already exists" rejection before
   * redirecting away. The countdown starts here, before the build worker has
   * even cloned the repository, so it has to cover clone time too — not just
   * the (fast) version check that follows it — or a slow clone means this
   * gives up and redirects right as the real rejection would have landed,
   * and the user never sees the "Deploy as vX" recovery action.
   */
  async #waitForVersionConflict(uploadId) {
    const ATTEMPTS = 40;
    const INTERVAL_MS = 700;
    for (let i = 0; i < ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
      try {
        const res = await apiFetch(`/agents/uploads/${encodeURIComponent(uploadId)}`);
        if (!res.ok) continue;
        const item = await res.json();
        const detail = item.error_details?.[0];
        if (detail?.startsWith('VERSION_CONFLICT:')) {
          // Wire format: "VERSION_CONFLICT:<version>:<suggested>:<message>"
          const rest = detail.slice('VERSION_CONFLICT:'.length);
          const [version, suggested, ...msgParts] = rest.split(':');
          return { version, suggested, message: msgParts.join(':').trim() };
        }
        // Resolved some other way (succeeded, or a real unrelated failure) —
        // nothing to warn about, stop waiting so we don't delay the redirect.
        if (item.status !== 'initiated' && item.status !== 'processing') return null;
      } catch {
        // Transient poll failure — keep trying for the remaining attempts.
      }
    }
    return null;
  }

  #clearVersionConflictWarning() {
    this.querySelector('.version-conflict-warning')?.remove();
  }

  #showVersionConflictWarning(conflict, payload) {
    const btn = this.querySelector('.clone-btn');
    btn.removeAttribute('loading');
    btn.label = 'Clone and upload';

    const stepThree = this.querySelector('.step-three');
    this.#clearVersionConflictWarning();
    const warn = document.createElement('div');
    warn.className = 'version-conflict-warning';
    const msg = document.createElement('p');
    msg.textContent = conflict.message;
    warn.appendChild(msg);

    const actions = document.createElement('div');
    actions.className = 'version-conflict-actions';

    // Versions are immutable, so there's no overwrite option — the only way
    // forward is to deploy under a fresh, unused version.
    const bumpBtn = document.createElement('app-button');
    bumpBtn.setAttribute('variant', 'primary');
    bumpBtn.setAttribute('size', 'sm');
    bumpBtn.label = `Deploy as v${conflict.suggested}`;
    bumpBtn.addEventListener(
      'click',
      () => {
        this.#clearVersionConflictWarning();
        this.#submitClone({ ...payload, version_override: conflict.suggested });
      },
      { once: true },
    );
    actions.appendChild(bumpBtn);

    warn.appendChild(actions);
    stepThree.insertBefore(warn, btn);
  }

  #renderRepos(repos) {
    const repoList = this.querySelector('.repo-list');
    if (!repos.length) {
      repoList.innerHTML = '<div class="repo-item repo-note">No repositories found.</div>';
      return;
    }
    repoList.innerHTML = repos.map(r => `
      <div class="repo-item repo-selectable" data-full-name="${escAttr(r.full_name)}">
        <app-radio class="repo-radio" name="repo" value="${escAttr(r.full_name)}"
          aria-label="${escAttr(r.full_name)}"
          ${this.#selectedRepo?.full_name === r.full_name ? 'checked' : ''}></app-radio>
        <div class="repo-info">
          <span class="repo-name">${escHtml(r.full_name)}</span>
          <span class="repo-meta">
            ${r.language ? `<span>${escHtml(r.language)}</span>` : ''}
            ${r.updated_at ? `<span>${escHtml(new Date(r.updated_at).toLocaleDateString())}</span>` : ''}
            ${r.private ? '<app-badge variant="neutral">Private</app-badge>' : ''}
          </span>
        </div>
      </div>
    `).join('');

    repoList.querySelectorAll('.repo-selectable').forEach(row => {
      row.addEventListener('click', () => {
        const fullName = row.dataset.fullName;
        const repo = this.#allRepos.find(r => r.full_name === fullName);
        if (repo) this.#selectRepo(repo);
      });
    });
  }
}

customElements.define('add-agent-github-page', AddAgentGithubPage);