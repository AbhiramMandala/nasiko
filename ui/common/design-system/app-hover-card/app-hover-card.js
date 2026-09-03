/**
 * Non-modal card that opens when the pointer rests on its trigger.
 *
 * Ported from nasiko_ui `NasikoHoverCard`: the rich, interactive cousin of the
 * tooltip — a profile preview on an @mention, an agent summary on a name.
 * Opens `open-delay` (700ms) after the pointer enters the trigger; leaving
 * before that cancels. Stays open while the pointer is over the trigger OR the
 * card, with `close-delay` (300ms) of grace to cross the gap. Never steals
 * focus. Because it is hover-driven it is mouse-only by design — keep the
 * essential information reachable another way (a link, a tooltip, inline text).
 * Keyboard users who focus the trigger get the card too, as a courtesy.
 *
 * @element app-hover-card
 * @attr {string} side - `bottom` (default) | `top` | `left` | `right`
 * @attr {string} align - `start` | `center` (default) | `end`
 * @attr {number} open-delay - ms before opening (default 700).
 * @attr {number} close-delay - ms of grace after leaving (default 300).
 * @attr {string} width - CSS width for the card, e.g. `280px`. Default: content.
 * @attr {boolean} disabled - Never opens.
 * @slot default - The trigger (first child).
 * @slot [data-slot="content"] - The card content.
 * @fires hovercard-toggle - `{ open }` after every open/close. Bubbles.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-hover-card.css', import.meta.url));
import { positionAnchored, followAnchor, supportsPopover } from '../../utils/anchor.js';
import { escStyleValue } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppHoverCard extends HTMLElement {
  static get observedAttributes() { return ['side', 'align', 'open-delay', 'close-delay', 'width', 'disabled']; }

  #trigger = null;
  #card = null;
  #built = false;
  #openTimer = null;
  #closeTimer = null;
  #unfollow = null;
  #open = false;

  connectedCallback() { this.#build(); }

  disconnectedCallback() {
    this.#clearTimers();
    this.#hide();
  }

  attributeChangedCallback(name) {
    if (!this.#built) return;
    if (name === 'width') this.#applyWidth();
    if (name === 'disabled' && this.hasAttribute('disabled')) this.#hide();
    else if (this.#open) this.#place();
  }

  #build() {
    if (this.#built) return;
    this.#built = true;
    const content = this.querySelector(':scope > [data-slot="content"]');
    this.#trigger = [...this.children].find((el) => el !== content) ?? this;

    // The card is the content element itself, kept inside the host (see
    // app-popover for why): the Popover API lifts it to the top layer from here.
    const card = content ?? document.createElement('div');
    card.classList.add('app-hover-card-surface');
    card.hidden = true;
    if (supportsPopover) card.popover = 'manual';
    if (!content) this.append(card);
    this.#card = card;
    this.#applyWidth();

    const enter = () => { if (!this.hasAttribute('disabled')) this.#scheduleOpen(); };
    const leave = () => this.#scheduleClose();
    this.#trigger.addEventListener('pointerenter', enter);
    this.#trigger.addEventListener('pointerleave', leave);
    this.#trigger.addEventListener('focusin', enter);
    this.#trigger.addEventListener('focusout', leave);
    card.addEventListener('pointerenter', () => this.#clearTimers());
    card.addEventListener('pointerleave', leave);
  }

  #applyWidth() {
    const w = this.getAttribute('width');
    this.#card.style.width = w ? escStyleValue(w) : '';
  }

  #delay(name, fallback) {
    const v = Number(this.getAttribute(name));
    return Number.isFinite(v) && this.hasAttribute(name) ? Math.max(0, v) : fallback;
  }

  #clearTimers() {
    clearTimeout(this.#openTimer); clearTimeout(this.#closeTimer);
    this.#openTimer = this.#closeTimer = null;
  }

  #scheduleOpen() {
    clearTimeout(this.#closeTimer);
    if (this.#open || this.#openTimer) return;
    this.#openTimer = setTimeout(() => { this.#openTimer = null; this.#show(); }, this.#delay('open-delay', 700));
  }

  #scheduleClose() {
    clearTimeout(this.#openTimer); this.#openTimer = null;
    if (!this.#open) return;
    clearTimeout(this.#closeTimer);
    this.#closeTimer = setTimeout(() => { this.#closeTimer = null; this.#hide(); }, this.#delay('close-delay', 300));
  }

  #place() {
    const { side } = positionAnchored(this.#card, this.#trigger, {
      side: this.getAttribute('side') || 'bottom',
      align: this.getAttribute('align') || 'center',
      gap: 8,
    });
    this.#card.dataset.side = side;
  }

  #show() {
    if (this.#open) return;
    this.#open = true;
    this.#card.hidden = false;
    if (supportsPopover) this.#card.showPopover();
    this.#place();
    this.#unfollow = followAnchor(() => this.#place());
    this.dispatchEvent(new CustomEvent('hovercard-toggle', { bubbles: true, detail: { open: true } }));
  }

  #hide() {
    if (!this.#open) return;
    this.#open = false;
    this.#unfollow?.(); this.#unfollow = null;
    if (supportsPopover && this.#card.matches(':popover-open')) this.#card.hidePopover();
    this.#card.hidden = true;
    this.dispatchEvent(new CustomEvent('hovercard-toggle', { bubbles: true, detail: { open: false } }));
  }
}
customElements.define('app-hover-card', AppHoverCard);
