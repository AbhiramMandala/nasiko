/**
 * Label, description and error treatment for any form control.
 *
 * Ported from nasiko_ui `NasikoField`. `<app-input>`, `<app-select>` and
 * `<app-search>` already carry their own `label`/`hint`/`state="error"`, so
 * they do not need this. It exists for the controls that have no label row of
 * their own — `<app-slider>`, `<app-otp-input>`, `<app-toggle-group>`,
 * `<app-textarea>`, a group of checkboxes, a `<textarea>` from a library —
 * so a form reads as one system whatever sits in the control slot.
 *
 * The helper line shows `description`, or `error` when present — error
 * replaces the description rather than stacking under it. Both are wired to
 * the control with `aria-describedby` when the control is a native input or
 * one of ours exposing `.input`.
 *
 * @element app-field
 * @attr {string} label - Label text above the control.
 * @attr {boolean} required - Red `*` after the label.
 * @attr {string} description - Helper line under the control.
 * @attr {string} error - Error message; replaces the description and turns the
 *   line red. Also sets `state="error"` on an `app-*` control in the slot.
 * @attr {boolean} disabled - Dims the label and helper (the control handles itself).
 * @slot default - The control.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-field.css', import.meta.url));
import { escHtml } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

let uid = 0;

export class AppField extends HTMLElement {
  static get observedAttributes() { return ['label', 'required', 'description', 'error', 'disabled']; }

  #id = `app-field-${++uid}`;
  #control = null;

  connectedCallback() { this.render(); }

  #captured = false;

  /** The control is a live element the page owns; it is moved, never cloned. */
  #capture() {
    if (this.#captured) return;
    this.#captured = true;
    this.#control = [...this.children].find((el) => !el.matches('.af-label, .af-help, .af-control')) ?? null;
  }

  attributeChangedCallback() { if (this.isConnected) this.render(); }

  render() {
    // Captured lazily from render(), not connectedCallback: during upgrade the
    // browser runs attributeChangedCallback (with isConnected already true)
    // BEFORE connectedCallback, so the first render can happen before a
    // connect-time capture — and would wipe the children it needed.
    this.#capture();
    const label = this.getAttribute('label');
    const required = this.hasAttribute('required');
    const description = this.getAttribute('description');
    const error = this.getAttribute('error');
    const disabled = this.hasAttribute('disabled');
    const help = error ?? description;
    const helpId = `${this.#id}-help`;

    this.classList.toggle('is-disabled', disabled);
    this.classList.toggle('is-error', error !== null);

    this.innerHTML = `
      ${label === null ? '' : `<label class="af-label" for="${this.#id}">${escHtml(label)}${required ? '<span class="req" aria-hidden="true"> *</span>' : ''}</label>`}
      <div class="af-control"></div>
      ${help === null ? '' : `<div class="af-help${error !== null ? ' is-error' : ''}" id="${helpId}"${error !== null ? ' role="alert"' : ''}>${escHtml(help)}</div>`}`;

    const control = this.#control;
    if (!control) return;
    this.querySelector('.af-control').appendChild(control);

    // Wire the label and helper to whatever is actually focusable inside.
    const target = control.matches('input, select, textarea, button') ? control
      : control.input ?? control.querySelector('input, select, textarea, [tabindex]');
    if (target) {
      if (!target.id) target.id = this.#id;
      else this.querySelector('.af-label')?.setAttribute('for', target.id);
      help === null ? target.removeAttribute('aria-describedby') : target.setAttribute('aria-describedby', helpId);
      if (error !== null) target.setAttribute('aria-invalid', 'true'); else target.removeAttribute('aria-invalid');
    }
    // Our own controls paint their error border from `state="error"`.
    if (control.localName.startsWith('app-')) {
      error !== null ? control.setAttribute('state', 'error')
        : control.getAttribute('state') === 'error' && control.removeAttribute('state');
    }
  }
}
customElements.define('app-field', AppField);
