import { icons } from '/common/utils/icons.js';
import '/common/features/secrets-manager.js';
import '/common/features/app-module-nav.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./secrets-page.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

// Workspace-level secrets. All CRUD lives in <secrets-manager scope="user">
// (GET|POST /api/secrets, DELETE /api/secrets/{name}); this page only supplies
// the page chrome around it.
//
// Was a view of the Settings module page, hosted in a `module-shell` that owned
// one nav for every view. Under the client router `/secrets` mounts straight
// into the outlet with no shell above it, so the page carries its own nav.
class SecretsPage extends HTMLElement {
  #initialized = false;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.innerHTML = `
      <app-module-nav module="settings"></app-module-nav>
      <header class="page-head">
        <h1 class="title-page">Secrets</h1>
        <p class="page-sub">API credentials stored in this workspace. Router configs and agents reference secrets by name.</p>
      </header>
      <secrets-manager scope="user"></secrets-manager>
      <div class="note-well">${icons.lock('note-icon', 16)}<span>Keys are write only. Once saved, a secret can be rotated or deleted but never read back. The configs reference it by name.</span></div>
    `;
  }
}

customElements.define('secrets-page', SecretsPage);
