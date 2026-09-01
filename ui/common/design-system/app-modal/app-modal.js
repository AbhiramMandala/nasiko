/**
 * Accessible dialog modal with heading, body, footer slot, backdrop dismiss, and ESC/X close.
 *
 * @element app-modal
 * @attr {string} heading - Modal title shown in the header
 * @attr {boolean} hide-footer - Hides the footer container even when a footer slot exists
 * @method open() - Opens the modal (calls showModal on the internal dialog)
 * @method close() - Closes the modal
 * @slot default - Body content
 * @slot [data-slot="footer"] - Footer action row (flex-end, e.g. Cancel / Save buttons)
 * @note The internal <dialog> is a regular DOM child (no Shadow DOM). The `close` event fires
 *       on the internal <dialog> and does NOT bubble — listen on `el.querySelector('dialog')`.
 * @note Backdrop click and the X button are handled internally.
 * @note `confirmDialog()` at the bottom of this file is the imperative form of this
 *       same component — a yes/no <app-modal> built in JS. It is not a second modal.
 */
import { icons } from "../../utils/icons.js";
import { escHtml } from "../../utils/escape.js";
import "../app-button/app-button.js";
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-modal.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

// global.css already handles: border:none, border-radius, padding:0, box-shadow,
// background, color, max-width:90vw, max-height:90vh, margin:auto, ::backdrop


const CLOSE = icons.x("", 14);

let uid = 0;

export class AppModal extends HTMLElement {
  #dialog;
  #footer = null;
  #initialized = false;
  #titleId = `app-modal-title-${++uid}`;

  static get observedAttributes() {
    return ["heading", "hide-footer"];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === "heading" && this.#dialog) {
      const titleEl = this.#dialog.querySelector("header > .title");
      if (titleEl) {
        titleEl.textContent = newValue || "";
      }
    }
    if (name === "hide-footer") this.#syncFooterVisibility();
  }

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    const footer = [...this.children].find(
      (el) => el.dataset.slot === "footer",
    );
    const bodyNodes = [...this.childNodes].filter((n) => n !== footer);

    const dialog = document.createElement("dialog");
    dialog.className = "app-modal";
    // The heading is the dialog's accessible name — without the wiring, a
    // screen reader announces an unnamed dialog and the user has to guess.
    dialog.setAttribute("aria-labelledby", this.#titleId);
    dialog.innerHTML = `
      <header>
        <h4 class="title" id="${this.#titleId}"></h4>
        <button type="button" aria-label="Close">${CLOSE}</button>
      </header>
      <div class="body"></div>
      ${footer ? "<footer></footer>" : ""}`;

    const titleEl = dialog.querySelector("header > .title");
    if (titleEl) {
      titleEl.textContent = this.getAttribute("heading") || "";
    }

    bodyNodes.forEach((n) => dialog.querySelector(".body").appendChild(n));
    if (footer) {
      this.#footer = dialog.querySelector("footer");
      this.#footer.appendChild(footer);
    }

    dialog
      .querySelector("header > button")
      .addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });

    this.appendChild(dialog);
    this.#dialog = dialog;
    this.#syncFooterVisibility();
  }

  #syncFooterVisibility() {
    if (!this.#footer) return;
    this.#footer.hidden = this.hasAttribute("hide-footer");
  }

  open() {
    this.#dialog?.showModal();
  }
  close() {
    this.#dialog?.close();
  }
}
if (!customElements.get("app-modal")) customElements.define("app-modal", AppModal);

/**
 * Imperative <app-modal>: a yes/no confirmation (replaces browser `confirm()`).
 * Returns a Promise that resolves `true` on confirm, `false` on cancel/close.
 *
 * No markup or styles of its own — the footer slot is display:contents so the
 * modal's own <footer> lays the buttons out, and app-button paints them.
 *
 * @param {object} opts
 * @param {string} opts.title - Modal heading
 * @param {string} opts.message - Body text. Escaped — this is a JS API whose
 *   callers pass strings built from server data (an agent name, a team name),
 *   and "supports HTML" made every one of those an injection point for a
 *   sentence nobody thinks of as markup. Nothing in the tree was passing HTML.
 * @param {string} [opts.confirmLabel='Confirm'] - Primary button label
 * @param {string} [opts.cancelLabel='Cancel'] - Secondary button label
 * @param {boolean} [opts.danger=false] - Styles the confirm button as destructive
 */
export function confirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
}) {
  return new Promise((resolve) => {
    const modal = document.createElement("app-modal");
    modal.setAttribute("heading", title ?? "");

    // Every interpolated string goes through escHtml. There is no attribute
    // interpolation to guard: `danger` is a boolean picking between two
    // literals, so it cannot carry a value at all.
    modal.innerHTML = `
      <p style="margin:0; font-size:var(--font-size-sm); color:var(--color-text-muted); line-height:1.5;">${escHtml(message ?? "")}</p>
      <div data-slot="footer" style="display:contents">
        <app-button variant="tertiary" data-role="cancel">${escHtml(cancelLabel)}</app-button>
        <app-button variant="${danger ? "danger" : "primary"}" data-role="confirm">${escHtml(confirmLabel)}</app-button>
      </div>
    `;

    document.body.appendChild(modal);
    let resolved = false;

    const cleanup = (result) => {
      if (resolved) return;
      resolved = true;
      modal.close();
      modal.remove();
      resolve(result);
    };

    modal.querySelector('[data-role="cancel"]').addEventListener("click", () => cleanup(false));
    modal.querySelector('[data-role="confirm"]').addEventListener("click", () => cleanup(true));
    modal.querySelector("dialog")?.addEventListener("close", () => cleanup(false));

    modal.open();
  });
}
