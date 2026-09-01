/**
 * "Back" that returns to where the user actually came from.
 *
 * Every detail page's back control was a plain link to its list page, so it
 * threw away whatever that list was showing: the module-nav row carried in
 * `?view=` (MCP gateway snapped back to "All", the agent card's back button
 * landed on Agent hub no matter which source page opened it), the selected
 * category tab, the scroll position. Popping history restores the URL, and the
 * browser's page cache restores the in-memory filter state with it.
 *
 * The `href` stays a real link on purpose — a deep-linked detail page has no
 * in-app history to pop, and copy-link / middle-click / ⌘-click must keep
 * working — so it is the fallback, not the primary path.
 *
 * Usage: mark the control `data-back` and import this module once in the page.
 *
 *   <app-button href="/mcp" data-back aria-label="Back">…</app-button>
 *
 * One delegated listener for the whole document (module caching means one
 * listener no matter how many pages import this), in the capture phase: the
 * router's own document click handler bails on a defaultPrevented event, so
 * this has to run ahead of it rather than race it.
 */
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const el = e.target?.closest?.('[data-back]');
  if (!el) return;
  // Nothing to pop (a detail page opened directly from a link or a new tab) —
  // let the href navigate to the list page instead.
  if (history.length <= 1) return;
  e.preventDefault();
  history.back();
}, true);
