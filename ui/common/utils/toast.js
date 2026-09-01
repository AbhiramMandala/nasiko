/**
 * Global toast notification manager.
 *
 * Matched to Figma "Design System V2" › ↳Toast › Toast (node 760:8266). Figma
 * models one axis of five Types — Loading, Info, Success, Warning, Error — plus
 * four booleans: showDescription, showActions, secondaryAction, showClose.
 *
 * Consolidated from the former inline-style `showToast()` and the richer
 * `components/app-toast.js` (which was never a custom element). Lives here in
 * the utils layer so platform code can import it without a layer-direction
 * violation — which is also why the action buttons are plain `<button>`s styled
 * from the same tokens rather than `<app-button>`: importing a design-system
 * component from Platform is upward. See the CSS header.
 *
 * @global toast.success(message | opts, duration?) - Green, auto-dismiss (3 s)
 * @global toast.error(message | opts, duration?)   - Red
 * @global toast.warning(message | opts, duration?) - Orange
 * @global toast.info(message | opts, duration?)    - Cream
 * @global toast.loading(message | opts, duration?) - Neutral + spinner, PERSISTENT
 *   by default (duration 0); keep the returned handle and call `.close()`.
 *
 * `opts` is `{ title, description, actions, duration }`, where `actions` is up
 * to two `{ label, onClick, variant }` (`variant`: `primary` | `secondary`).
 * Every form returns `{ close() }`.
 */
import { icons } from './icons.js';
import { escHtml } from '/common/utils/escape.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`@scope (.app-toast-container) {
  /*
    Figma Toast (760:8266). Layout: horizontal-gap 8, padding 12/12, radius 8,
    icon 16, content-gap 8, action-gap 4, width 303 (max 420).
    Type → surface / border / icon:
      Loading  bg/default/surface #ede7dc  border/default/primary  fg/default/secondary
      Info     bg/feedback/information #fdf7e6  border/default/primary
               fg/feedback/information #695104  (= --fg-caution-emphasis here:
               Figma's "information" role is the warm yellow-800, NOT this repo's
               blue --fg-information)
      Success  #dcfce7 / #86efac / #16a34a
      Warning  #ffedd5 / #fdba74 / #ea580c
      Error    #fee2e2 / #fecaca / #dc2626
    Close icon is fg/default/icon-secondary #bb8f06 in every type.

    The two action buttons are Figma's own sm Primary and Secondary buttons, so
    the rules below are deliberately the same tokens app-button's .is-primary /
    .is-secondary + .is-sm resolve to (28px, px 12, gap 6, radius 6, 13/18 at
    weight 500, tracking 0.16). app-button is the source of truth — it cannot be
    imported here (Platform may not import Design System), so figma-parity.test
    asserts these against the same numbers to catch drift.
  */
  :scope {
    position: fixed;
    bottom: var(--s-24);
    right: var(--s-24);
    z-index: 9999;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--s-12);
    pointer-events: none;
  }

  .app-toast {
    display: flex;
    align-items: flex-start;
    gap: var(--s-8);
    width: 303px;
    max-width: 420px;
    padding: var(--s-12);
    background: var(--bg-surface);
    border: var(--bw-1) solid var(--border-primary);
    border-radius: var(--r-8);
    box-shadow: var(--shadow-lg);
    pointer-events: auto;
  }

  .toast-icon {
    flex-shrink: 0;
    display: flex;
    color: var(--fg-secondary);
  }

  .toast-content {
    flex: 1 0 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-8);
  }

  /* body/secondary-bold — 13/18 at weight 700. */
  .toast-title {
    font-size: var(--font-size-sm);
    line-height: var(--font-body-sm-line);
    font-weight: var(--fw-bold);
    color: var(--fg-primary);
    overflow-wrap: break-word;
  }

  /* body/tertiary — 12/16. */
  .toast-description {
    font-size: var(--font-size-tertiary);
    line-height: var(--font-body-tertiary-line);
    color: var(--fg-secondary);
    overflow-wrap: break-word;
  }

  .toast-actions {
    display: flex;
    gap: var(--s-4);
  }

  .toast-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--s-6);
    height: var(--control-h-sm);
    padding: 0 var(--s-12);
    border: var(--bw-1) solid var(--border-primary);
    border-radius: var(--r-6);
    font-family: inherit;
    font-size: var(--font-button-sm-size);
    line-height: var(--font-button-sm-line);
    font-weight: var(--fw-medium);
    letter-spacing: var(--tracking-title);
    white-space: nowrap;
    cursor: pointer;
    transition: background var(--transition-fast), border-color var(--transition-fast);
  }

  .toast-action.is-primary {
    background: var(--fg-constant-black-secondary);
    color: var(--fg-on-action);

    &:hover {
      background: var(--fg-constant-black);
      border-color: var(--border-hover);
    }
  }

  .toast-action.is-secondary {
    background: var(--bg-secondary-brand);
    color: var(--fg-primary);

    &:hover {
      background: var(--bg-secondary-brand-hover);
      border-color: var(--border-secondary);
    }
  }

  .toast-close {
    flex-shrink: 0;
    display: flex;
    padding: 0;
    background: none;
    border: 0;
    color: var(--fg-icon-secondary);
    cursor: pointer;

    &:hover { color: var(--fg-icon-hover); }
  }

  /* ── Type ──────────────────────────────────────────────────────────────── */
  .is-loading .toast-icon { animation: toast-spin 1s linear infinite; }

  .is-info {
    background: var(--bg-caution-subtle);

    & .toast-icon { color: var(--fg-caution-emphasis); }
  }

  .is-success {
    background: var(--bg-success);
    border-color: var(--border-success);

    & .toast-icon { color: var(--fg-success); }
  }

  .is-warning {
    background: var(--bg-warning);
    border-color: var(--border-warning);

    & .toast-icon { color: var(--fg-warning); }
  }

  .is-error {
    background: var(--bg-error);
    border-color: var(--border-error);

    & .toast-icon { color: var(--fg-error); }
  }

  @keyframes toast-spin {
    to { transform: rotate(360deg); }
  }
}
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/** Figma Type → the 16px leading glyph. */
const ICONS = {
  loading: () => icons.loader('', 16),
  info:    () => icons.info('', 16),
  success: () => icons.check('', 16),
  warning: () => icons.alertTriangle('', 16),
  error:   () => icons.alertTriangle('', 16),
};

class ToastManager {
  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'app-toast-container';
    document.body.appendChild(this.container);
  }

  /**
   * @param {{title: string, description?: string, type?: string, duration?: number,
   *          actions?: Array<{label: string, onClick?: Function, variant?: string}>}} opts
   */
  show({ title, description, type = 'info', duration = 3000, actions = [] }) {
    const el = document.createElement('div');
    el.className = `app-toast is-${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    // Figma allows a Primary and a Secondary; more than two would wrap the row.
    const shown = actions.slice(0, 2);
    el.innerHTML = `
      <span class="toast-icon">${(ICONS[type] ?? ICONS.info)()}</span>
      <div class="toast-content">
        <span class="toast-title">${escHtml(title)}</span>
        ${description ? `<span class="toast-description">${escHtml(description)}</span>` : ''}
        ${shown.length ? `<div class="toast-actions">${shown.map((a, i) => `
          <button type="button" data-action="${i}"
            class="toast-action is-${a.variant === 'secondary' || i > 0 ? 'secondary' : 'primary'}"
          >${escHtml(a.label)}</button>`).join('')}</div>` : ''}
      </div>
      <button type="button" class="toast-close" aria-label="Dismiss">${icons.x('', 16)}</button>`;

    // Declared before `close` so it is never read in its temporal dead zone.
    let timer = null;
    const close = () => { clearTimeout(timer); el.remove(); };
    el.querySelector('.toast-close').addEventListener('click', close);
    // querySelectorAll types as Element, which has no dataset — the JSDoc build
    // reads this file, so the cast is what keeps `just check-types` green.
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (el.querySelectorAll('.toast-action'))) {
      btn.addEventListener('click', () => {
        shown[Number(btn.dataset.action)]?.onClick?.();
        close();
      });
    }

    this.container.appendChild(el);
    // duration 0 = persistent. The Loading type defaults to it: a spinner that
    // vanishes on a timer says "done" when nothing finished.
    if (duration > 0) timer = setTimeout(close, duration);
    return { close };
  }
}

let manager = null;

/** `toast.error('msg')`, `toast.error('msg', 5000)`, and `toast.error({title, …})`. */
function emit(arg, type, duration) {
  if (!manager) manager = new ToastManager();
  const opts = typeof arg === 'string' ? { title: arg } : { ...arg };
  opts.type = type;
  if (duration !== undefined) opts.duration = duration;
  else if (opts.duration === undefined && type === 'loading') opts.duration = 0;
  return manager.show(opts);
}

export const toast = {
  show:    (arg, type = 'info', duration) => emit(arg, type, duration),
  success: (arg, duration) => emit(arg, 'success', duration),
  error:   (arg, duration) => emit(arg, 'error', duration),
  warning: (arg, duration) => emit(arg, 'warning', duration),
  info:    (arg, duration) => emit(arg, 'info', duration),
  loading: (arg, duration) => emit(arg, 'loading', duration),
};

/** Backwards-compatible one-argument alias used by ~20 importers. */
export function showToast(message) {
  toast.info(message);
}
