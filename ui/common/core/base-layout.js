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
   * Map a `gap`/`padding` token name onto the spacing scale, and repair the
   * `justify` shorthand names.
   *
   * BaseLayout mirrors the raw attribute value into the custom property, which
   * meant the documented token names never worked: `gap="sm"` produced
   * `--stack-gap: sm`, so `gap: sm` was invalid at computed-value time, the
   * declaration was dropped, and the element fell back to `gap: normal` — i.e.
   * 0, which is *less* gap than omitting the attribute (the sheets default to
   * --s-16). Same for `padding`, and `justify="between"` produced the invalid
   * `justify-content: between`. Anything not a known token passes through, so a
   * raw length (`gap="10px"`) still works.
   * @type {Record<string, Record<string, string>>}
   */
  static tokenMaps = {
    gap: {
      xs: 'var(--s-4)', sm: 'var(--s-8)', md: 'var(--s-16)',
      lg: 'var(--s-24)', xl: 'var(--s-32)',
    },
    padding: {
      xs: 'var(--s-4)', sm: 'var(--s-8)', md: 'var(--s-16)',
      lg: 'var(--s-24)', xl: 'var(--s-32)',
    },
    justify: {
      start: 'flex-start', center: 'center', end: 'flex-end',
      between: 'space-between', around: 'space-around', evenly: 'space-evenly',
    },
  };

  /**
   * @param {string} name
   * @param {string} value
   */
  updateProperty(name, value) {
    const map = /** @type {typeof BaseLayout} */ (this.constructor).tokenMaps[name];
    const resolved = map?.[value] ?? value;
    this.style.setProperty(`--${this.#prefix}-${name}`, resolved);
  }
}
