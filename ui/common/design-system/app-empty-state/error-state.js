/**
 * The shared "couldn't load this" block, and the Retry wiring that goes with
 * it.
 *
 * Lives in the design system, beside the element it renders, rather than in
 * `utils/`. It emits `app-empty-state` and `app-button` as markup, and a
 * template literal is invisible to every gate we have: `check-imports` sees no
 * specifier, the layering rules see no edge, and renaming either element would
 * leave this file linting clean while it quietly produced dead markup. Sitting
 * here, the dependency is a real import that both can see. NAS-741.
 *
 * Importing this module also DEFINES both elements, so a caller cannot forget
 * to. That was the standing hazard: every call site had to remember two
 * side-effect imports, and the one that didn't would render an undefined
 * element — the permanent-skeleton bug, with no error anywhere.
 */
import './app-empty-state.js';
import '../app-button/app-button.js';
import { escAttr } from '../../utils/escape.js';

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
