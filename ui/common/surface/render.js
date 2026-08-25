/**
 * Walks a materialized element tree and builds real DOM out of the actual
 * design-system custom elements — no reconciler, clear-and-rebuild per pass
 * (matches the full-re-walk decision in materialize.js).
 *
 * app-table/app-select/etc. special case: any attribute typed `"dataSource"`
 * (only `app-table.data-fn` today) is resolved internally from the
 * `dataParam` value via a synthetic registered source — never a literal
 * the model controls directly (see `dsl-overrides.json`'s
 * `dslExcludeAttributes`, which already strips these from the catalog the
 * model is shown). `type: "json"` attributes are JSON.stringify'd, not
 * naively `String()`'d. `propAssignments`-listed params are set as real JS
 * properties (`el.data = value`), not attributes — needed for `app-chart`,
 * whose real dataset is a property setter, not an HTML attribute (confirmed
 * directly against its source). A materialized prop shaped `{type:'action',
 * steps}` is wired as an event listener via `triggerAction`, never
 * `setAttribute`d. A node with `.slot` set gets the parent's mapped slot
 * attribute (e.g. `data-slot="footer"`) before being appended.
 *
 * `app-modal` special case: its real `open()`/`close()` are imperative JS
 * methods, not an attribute (confirmed directly against its source — it
 * starts closed; simply being in the tree does nothing visible). Since we
 * always want a materialized `AppModal(...)` to actually be visible once
 * rendered (no DSL-level "closed" concept exists yet), `render()` calls
 * `.open()` on every app-modal element once the whole tree is attached to
 * the document (`showModal()`-style APIs require connection first) — a
 * real, deliberate simplification: a "click to open" modal isn't supported
 * yet, only "show this modal now" is.
 */

import { register } from '../core/data-sources.js';

/**
 * @param {object|null} root materialized element tree from materialize.js
 * @param {HTMLElement} container mount point
 * @param {object} catalog the merged dsl-catalog.json (or an equivalent
 *   object shaped `{components: {...}}`)
 * @param {object} [actionCtx] passed straight to `renderNode` for wiring
 *   `Action` listeners; omit to render without interactivity (e.g. tests)
 */
export function render(root, container, catalog, actionCtx = null) {
  try {
    container.innerHTML = '';
    if (!root) return;
    const postAppend = [];
    container.appendChild(renderNode(root, catalog, actionCtx, postAppend));
    for (const el of postAppend) el.open?.();
  } catch (err) {
    // Render-level fallback: never blank the container on a thrown error —
    // leave whatever was last successfully rendered in place (the plain-DOM
    // equivalent of an error boundary that keeps last-good children).
    console.error('render.js: render() threw, keeping last good tree:', err);
    actionCtx?.onError?.([{ source: 'render', code: 'render-threw', message: String(err) }]);
  }
}

function renderNode(node, catalog, actionCtx, postAppend) {
  const el = document.createElement(node.tag);
  const def = catalog.components[node.tag] || { attributes: {} };
  const propAssignments = new Set(def.propAssignments || []);
  if (node.tag === 'app-modal') postAppend.push(el);

  for (const [key, value] of Object.entries(node.props)) {
    if (value === null || value === undefined) continue;

    if (value && typeof value === 'object' && value.type === 'action') {
      wireAction(el, def, key, value, actionCtx);
      continue;
    }

    if (propAssignments.has(key)) {
      el[toPropertyName(key)] = value;
      continue;
    }

    const attrDef = def.attributes[key];
    if (attrDef?.type === 'boolean') {
      if (value) el.setAttribute(key, '');
    } else if (attrDef?.type === 'json') {
      el.setAttribute(key, JSON.stringify(value));
    } else {
      el.setAttribute(key, String(value));
    }
  }

  if (typeof node.text === 'string') {
    // textParam component (e.g. app-button/app-badge/app-tag): the real
    // visible label is plain light-DOM text content, confirmed directly
    // against each component's own source — never an attribute.
    el.textContent = node.text;
  }

  if (propAssignments.has('data')) {
    // e.g. app-chart: its real dataset is a JS property, not an attribute,
    // and may legitimately be an array OR a {labels, datasets} object —
    // materialize.js already skips the array-only coercion for this case.
    if (node.data !== null && node.data !== undefined) el.data = node.data;
  } else if (Array.isArray(node.data)) {
    // app-table-style dataParam: always a row array, resolved via a
    // synthetic one-off registered data source (its `data-fn` attribute
    // names a function, not a literal — see core/data-sources.js).
    const sourceName = `__surface_${node.statementId || 'anon'}`;
    register(sourceName, async () => ({ data: node.data, total: node.data.length }), { replace: true });
    el.setAttribute('data-fn', sourceName);
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (!child || typeof child !== 'object' || child.type !== 'element') continue;
      const childEl = renderNode(child, catalog, actionCtx, postAppend);
      if (child.slot) {
        const slotAttr = def.slots?.[child.slot];
        if (slotAttr) childEl.setAttribute(slotAttr, child.slot);
        else console.warn(`render.js: ${node.tag} has no mapped slot "${child.slot}" — appending as a plain child`);
      }
      el.appendChild(childEl);
    }
  }

  return el;
}

/** `key` is either a real attribute name or the synthetic `"action"` slot
 * (`dsl-overrides.json`'s `actionParam`). Either way, wire it to the
 * component's configured trigger event (default `"click"`). */
function wireAction(el, def, key, actionValue, actionCtx) {
  if (!actionCtx) return; // no context supplied — render without interactivity
  const triggerEvent = def.actionEvent || def.events?.[0]?.name || 'click';
  el.addEventListener(triggerEvent, () => {
    actionCtx.triggerAction(actionValue, actionCtx.evalCtx(), actionCtx.deps());
  });
}

function toPropertyName(attrKey) {
  return attrKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
