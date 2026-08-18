/**
 * Abstract base class for layout custom elements — not a custom element itself.
 *
 * Extend `BaseLayout` and pass a CSS prefix to `super(prefix)`. Every observed
 * attribute is mirrored onto the host as `--<prefix>-<attr>`, so a layout
 * element's API is attributes in and custom properties out, with no per-element
 * plumbing. Observed attributes are applied on connect as well as on change.
 *
 * Lives in core/ rather than design-system/ because it is a base class, a peer
 * of NasikoElement in core/element.js — nothing renders it.
 */
export class BaseLayout extends HTMLElement {
  #prefix;

  /** @param {string} prefix - CSS custom-property prefix, e.g. `stack`. */
  constructor(prefix) {
    super();
    this.#prefix = prefix;
  }

  connectedCallback() {
    // `observedAttributes` is declared by the concrete subclass, so it is not on
    // HTMLElement's constructor type. The cast is the narrowest way to say that.
    const observed =
      /** @type {{ observedAttributes?: string[] }} */ (this.constructor).observedAttributes ?? [];
    for (const attr of observed) {
      const val = this.getAttribute(attr);
      if (val !== null) this.updateProperty(attr, val);
    }
  }

  /**
   * @param {string} name
   * @param {string|null} oldVal
   * @param {string|null} newVal
   */
  attributeChangedCallback(name, oldVal, newVal) {
    if (this.isConnected) {
      if (newVal !== null) {
        this.updateProperty(name, newVal);
      } else {
        this.style.removeProperty(`--${this.#prefix}-${name}`);
      }
    }
  }

  /**
   * @param {string} name
   * @param {string} value
   */
  updateProperty(name, value) {
    this.style.setProperty(`--${this.#prefix}-${name}`, value);
  }
}
