/**
 * Shared utilities for data-fetching components (app-table, data-view).
 * Reduces duplication for event tracking, debounce, and loading animation.
 */
import { escAttr } from './escape.js';

/**
 * Creates an event-listener tracker that simplifies add + cleanup.
 *
 *   const events = createEventTracker();
 *   events.add(button, 'click', handler);
 *   events.add(button, 'click', handler2, { _tag: true }); // extra metadata
 *   events.removeTagged('_tag');   // remove only tagged entries
 *   events.cleanup();              // remove all
 */
export function createEventTracker() {
  let entries = [];

  return {
    add(element, event, handler, meta) {
      element.addEventListener(event, handler);
      entries.push({ element, event, handler, ...meta });
    },

    removeTagged(tagKey) {
      entries = entries.filter(entry => {
        if (entry[tagKey]) {
          entry.element.removeEventListener(entry.event, entry.handler);
          return false;
        }
        return true;
      });
    },

    cleanup() {
      entries.forEach(({ element, event, handler }) => {
        element.removeEventListener(event, handler);
      });
      entries = [];
    },
  };
}

/**
 * Returns a debounced wrapper around `fn`.
 * Calling `.cancel()` on the returned function clears the pending timer.
 */
export function debounce(fn, delay = 300) {
  let timer = null;
  const debounced = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  debounced.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  return debounced;
}

/**
 * CSS string for a subtle opacity-pulse loading animation.
 * Pass the BEM class name that should trigger it (e.g. 'app-table__scroll--loading').
 *
 * Allowed by AGENTS.md rule 7 exception for data-loading indicators.
 */
export function loadingPulseCSS(className) {
  return `
  @keyframes data-loading-pulse {
    0%, 100% { opacity: 0.45; }
    50%      { opacity: 0.75; }
  }
  .${className} {
    animation: data-loading-pulse 1.5s ease-in-out infinite;
    pointer-events: none;
    cursor: wait;
  }
`;
}

/**
 * The one "couldn't load this" block, as markup a data component drops into
 * its own box.
 *
 * Every data component needs the same three states — loading, empty, failed —
 * and before this only `app-table` had the third. The rest either hung on
 * their skeleton forever or reused the empty-state copy, so "there is nothing
 * here" and "we could not find out" looked identical and a user reasonably
 * concluded their data did not exist. The look is `<app-empty-state>`'s, in
 * its `inline` form, so the failure a chart shows and the failure a table
 * shows are the same failure — one design, not five.
 *
 * The Retry button is markup, not a listener: the caller already re-renders
 * its own innerHTML on every state change, so a handler bound here would be
 * orphaned on the next pass. Delegate to `[data-retry]` from the host instead
 * (see `bindRetry`).
 *
 * @param {string} message - What did not load, in one line.
 * @param {{ retry?: boolean }} [opts] - `retry: false` drops the button, for
 *   a component whose owner has no way to refetch.
 * @returns {string} HTML for one `<app-empty-state inline variant="error">`.
 */
export function errorStateHtml(message, { retry = true } = {}) {
  return `<app-empty-state inline variant="error" description="${escAttr(message ?? '')}">
      ${retry ? '<app-button variant="tertiary" size="sm" data-retry>Retry</app-button>' : ''}
    </app-empty-state>`;
}

/**
 * Wire the Retry button inside an `errorStateHtml` block to one event.
 *
 * Delegated from the host element and bound once, so it survives every
 * re-render of the block underneath it — which is the whole reason the button
 * carries `data-retry` rather than a direct handler.
 *
 * @param {HTMLElement} host - The component; also what the event is fired on.
 * @param {string} eventName - `<element>-retry`, per CONVENTIONS §4.
 * @param {Function} [also] - Called before the event, for a component that can
 *   refetch on its own (app-table owns its `dataFn`; a chart does not).
 */
export function bindRetry(host, eventName, also) {
  host.addEventListener('click', (e) => {
    if (!e.target.closest('[data-retry]')) return;
    also?.();
    host.dispatchEvent(new CustomEvent(eventName, { bubbles: true }));
  });
}
