/**
 * Wraps an async action with button loading state.
 * Disables the button, swaps text to `loadingText`, restores on completion.
 *
 *   import { withLoading } from '/common/utils/async-button.js';
 *   btn.addEventListener('click', withLoading(btn, 'Saving…', async () => { ... }));
 *
 * Works on a plain `<button>` and on `<app-button>`. The two need different
 * treatment: an app-button renders an inner `<button>` wrapper, so assigning
 * `textContent` would wipe it and leave a bare unstyled text node — relabel
 * through its `label` setter instead and let it draw its own spinner.
 */
export function withLoading(btn, loadingText, fn) {
  return async (...args) => {
    const isAppButton = btn.localName === 'app-button';
    const original = isAppButton
      ? (btn.querySelector('.content')?.textContent ?? btn.textContent)
      : btn.textContent;
    btn.disabled = true;
    if (isAppButton) {
      btn.toggleAttribute('loading', true);
      btn.label = loadingText;
    } else {
      btn.textContent = loadingText;
    }
    try {
      return await fn(...args);
    } finally {
      btn.disabled = false;
      if (isAppButton) {
        btn.removeAttribute('loading');
        btn.label = original;
      } else {
        btn.textContent = original;
      }
    }
  };
}
