/**
 * Opt an agent into a persistent, private-per-agent directory (the CLI's
 * `--writable` / `--writable-path`), with an optional custom mount target.
 *
 * Used by the zip-upload deploy on-ramp — the only path the server wires
 * `--writable` through today (OCI import and GitHub have no equivalent yet).
 *
 * The server treats these fields as tri-state — an omitted field keeps the
 * agent's stored value. That is what stops a re-upload from silently detaching
 * a live volume, so this element tracks whether the user actually touched it
 * ({@link WritableStorageField#dirty}) and callers must send nothing when it is
 * still false.
 *
 * @element writable-storage-field
 * @prop {{writable: boolean, writablePath: string}} value - Get/set current state
 * @prop {boolean} dirty - True once the user has interacted; false after `value` is set programmatically
 */
const styles = new CSSStyleSheet();
styles.replaceSync(`@scope (writable-storage-field) {
  :scope {
    display: flex;
    flex-direction: column;
    gap: var(--s-8);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--s-8);
    font-size: var(--font-size-sm);
  }

  .row input { accent-color: var(--color-primary); }
  .row label { margin: 0; font-weight: 400; }

  .hint {
    font-size: var(--font-size-xs);
    color: var(--color-text-muted);
  }

  .path {
    display: flex;
    flex-direction: column;
    gap: var(--s-8);
  }

  .path[hidden] { display: none; }

  .path input {
    width: 100%;
    height: var(--control-h-sm);
    padding: 0 var(--s-12);
    border: 1px solid var(--color-border);
    border-radius: var(--r-8);
    background: var(--bg-input);
    color: var(--color-text-main);
    font-family: inherit;
    font-size: var(--font-size-sm);
  }

  .path input:focus-visible {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-ring);
  }
}`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

class WritableStorageField extends HTMLElement {
  #initialized = false;
  #dirty = false;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.innerHTML = `
      <div class="row">
        <input type="checkbox" id="ws-enabled" />
        <label for="ws-enabled">Persistent storage</label>
      </div>
      <span class="hint">Keeps a private directory for this agent across restarts,
        redeploys and version updates. Without it, anything the agent writes is lost
        when its container is replaced.</span>
      <div class="path" id="ws-path-field" hidden>
        <input type="text" id="ws-path" autocomplete="off" placeholder="/workspace" />
        <span class="hint">Optional mount location. Pick a directory the image doesn't
          already use — the mount hides whatever it ships there, so mounting over the
          agent's own code stops it starting.</span>
      </div>
    `;

    const enabled = this.querySelector('#ws-enabled');
    const pathField = this.querySelector('#ws-path-field');

    enabled.addEventListener('change', () => {
      pathField.hidden = !enabled.checked;
      this.#dirty = true;
    });
    this.querySelector('#ws-path').addEventListener('input', () => {
      this.#dirty = true;
    });
  }

  get value() {
    return {
      writable: this.querySelector('#ws-enabled')?.checked ?? false,
      writablePath: this.querySelector('#ws-path')?.value.trim() ?? '',
    };
  }

  /** Prefilling from a stored agent is not a user edit, so `dirty` resets. */
  set value({ writable = false, writablePath = '' } = {}) {
    const enabled = this.querySelector('#ws-enabled');
    const path = this.querySelector('#ws-path');
    if (!enabled || !path) return;
    enabled.checked = !!writable;
    path.value = writablePath || '';
    this.querySelector('#ws-path-field').hidden = !writable;
    this.#dirty = false;
  }

  get dirty() {
    return this.#dirty;
  }
}

customElements.define('writable-storage-field', WritableStorageField);
