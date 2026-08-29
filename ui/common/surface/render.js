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

    if (node.tag === 'app-action-menu' && key === 'items' && Array.isArray(value)) {
      wireActionMenuItems(el, value, actionCtx);
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
      el.setAttribute(key, JSON.stringify(sanitizeForJson(value)));
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
 * component's configured trigger event (default `"click"`).
 *
 * Also extracts a real value from the triggering DOM event and exposes it
 * to that one Action's evaluation as `$event` (materialize.js's `StateRef`
 * case special-cases this reserved name) — without this, `@Set($x, ...)`
 * had no way to reference "what the user just typed/picked", only a
 * self-referential `@Set($x, $x)` no-op (confirmed live: a search box's
 * typed text never actually reached its own bound `$variable`). */
function wireAction(el, def, key, actionValue, actionCtx) {
  if (!actionCtx) return; // no context supplied — render without interactivity
  const triggerEvent = def.actionEvent || def.events?.[0]?.name || 'click';
  el.addEventListener(triggerEvent, (nativeEvent) => {
    const evalCtx = actionCtx.evalCtx();
    evalCtx.eventValue = extractEventValue(nativeEvent);
    actionCtx.triggerAction(actionValue, evalCtx, actionCtx.deps());
  });
}

/** Real event contracts, confirmed against each component's own source:
 * app-chatbox's `chatbox-submit` carries `detail: {value, files}`; app-search/
 * app-input/app-select bubble the native `input`/`change` from their inner
 * `<input>`/`<select>`, whose `.value` (or `.checked` for checkbox/radio) is
 * the real live value. Returns `undefined` (not `null`) when nothing
 * meaningful is extractable, matching "no event context" in `evaluateExpr`. */
function extractEventValue(evt) {
  if (evt?.detail && typeof evt.detail === 'object' && 'value' in evt.detail) return evt.detail.value;
  const t = evt?.target;
  if (t instanceof HTMLInputElement && (t.type === 'checkbox' || t.type === 'radio')) return t.checked;
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) {
    return t.value;
  }
  return undefined;
}

/** app-action-menu's real contract (confirmed against its source): `items`
 * is a plain `{id, label}` array, and it fires ONE `action-select` event
 * with `detail: {id}` for whichever item was clicked — not a per-item
 * listener. Our DSL lets the model attach a per-item `action` field
 * instead (`{label, action: someAction}`), which is not part of the real
 * component's contract at all, so previously nothing ever read it: clicking
 * any item did nothing but open/close the menu. This assigns each item a
 * synthetic `id`, strips the non-serializable `action` field before it
 * reaches the real component, and listens for the real event to dispatch
 * back to the right one. */
function wireActionMenuItems(el, items, actionCtx) {
  let warnedWrongShape = false;
  const actionsById = new Map();
  const cleaned = items.map((item, i) => {
    const id = `item-${i}`;
    // The correct shape is a plain `{label, action}` object literal. Two
    // observed real-model variants, both handled defensively: (1) a bare
    // `Action(...)` reference used directly as the item, with no label at
    // all — the action still wires up, using a positional fallback label
    // since none exists anywhere to recover; (2) a whole component
    // reference (e.g. AppButton) — never rendered as a real DOM child here
    // (no children slot for one), so its own action can't be recovered, but
    // its visible text/label is used as a fallback so the item isn't blank.
    let action = null;
    if (item?.type === 'action') action = item;
    else if (item?.action?.type === 'action') action = item.action;
    if (action) actionsById.set(id, action);

    const label = item?.label ?? item?.text ?? item?.props?.label ?? (action ? `Action ${i + 1}` : undefined);
    if ((label === undefined || action === null) && !warnedWrongShape) {
      warnedWrongShape = true;
      console.warn(
        'render.js: an AppActionMenu item is not a plain {label, action} object — see ' +
          "agent.yaml's AppActionMenu worked example for the correct shape.",
      );
    }
    return { id, label: label ?? '' };
  });
  el.setAttribute('items', JSON.stringify(cleaned));
  if (!actionCtx) return;
  el.addEventListener('action-select', (e) => {
    const action = actionsById.get(e.detail?.id);
    if (!action) return;
    actionCtx.triggerAction(action, actionCtx.evalCtx(), actionCtx.deps());
  });
}

/** Defensive: a JSON-typed attribute (e.g. app-card's `tags`) is meant to
 * hold plain data, but the model can accidentally nest a real component
 * call inside one (confirmed live: `AppCard(..., [AppTag("x")])` passed as
 * a `tags` value materializes each `AppTag` into a full `{type:'element',
 * tag:'app-tag', ...}` node, which isn't the `{label}` shape the real
 * component expects and renders as garbage). Strips any materialized
 * element/action node found anywhere inside the value, replacing it with
 * `null`, so a mistake like this renders visibly empty instead of garbled —
 * and warns once per render pass so it's diagnosable instead of silent. */
function sanitizeForJson(value, warned = { done: false }) {
  if (Array.isArray(value)) return value.map((v) => sanitizeForJson(v, warned));
  if (value && typeof value === 'object') {
    if (value.type === 'element' || value.type === 'action') {
      if (!warned.done) {
        warned.done = true;
        console.warn(
          'render.js: a real component/action was nested inside a plain JSON-typed attribute ' +
            '(e.g. AppCard\'s `tags`) — dropped, since that attribute expects plain data, not a ' +
            'DSL expression. Use a plain string/object literal there instead.',
        );
      }
      return null;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeForJson(v, warned);
    return out;
  }
  return value;
}

function toPropertyName(attrKey) {
  return attrKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
