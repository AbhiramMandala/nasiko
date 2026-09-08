/**
 * A materialized tree in, real design-system elements out.
 *
 * Clear and rebuild per pass, matching the full re-walk in materialize.js.
 * There is no reconciler: at one dashboard's size the cost is nothing, and the
 * alternative is a diffing layer whose bugs all look like "the screen is
 * subtly wrong" rather than "the screen is missing".
 *
 * Every value here arrived over the wire from a model, so the whole surface of
 * this file is `createElement`, `setAttribute`, `textContent` and property
 * assignment — never `innerHTML`, never a handler named in the spec. `ui-lint`
 * enforces that rather than trusting it, because the shortcut is always
 * available and always tempting.
 *
 * How a component takes its data is a per-component fact read from the
 * catalog, not a guess:
 *
 *   - `app-table` wants a fetcher on its `dataFn` property. Rows are wrapped in
 *     one. The alternative — registering a synthetic source in the app-wide
 *     `core/data-sources.js` registry and pointing `data-fn` at it — is what
 *     the prototype did, and it leaked: a new registration every render pass,
 *     never unregistered, in a namespace shared with real sources.
 *   - `app-chart` wants its data on a `data` property, and its two shapes
 *     (Chart.js `{labels, datasets}` for canvas forms, a bare row array for
 *     `hbar`/`progress`) are passed through unchanged. Coercing between them is
 *     how a chart silently renders blank.
 *
 * @module common/surface/render
 */

import { toText } from './coerce.js';

/** Attributes a surface may never set, whatever a catalog says. */
const DENIED = new Set(['style', 'class', 'id', 'part', 'is', 'slot']);

/**
 * The event an Action binds to. A component that declares its own `change` or
 * `input` event means that, not a click — derived from the catalog rather than
 * hand-listed, so a new form control does not need remembering.
 */
function triggerEvent(def) {
  if (def.actionEvent) return def.actionEvent;
  const names = (def.events || []).map((e) => (typeof e === 'string' ? e : e.name));
  for (const preferred of ['change', 'input']) if (names.includes(preferred)) return preferred;
  return 'click';
}

/**
 * @typedef {object} RenderDeps
 * @property {Document} [doc] Injected for tests; defaults to the real document.
 * @property {(action: object, el: Element, ev: Event) => void} [onAction] Called
 *   when an action-bearing element fires. The DOM event travels with it because
 *   `$event` is the only way an Action can read what the user actually typed —
 *   `@Set($query, $query)` just re-sets a variable to itself.
 *   The renderer never interprets an Action
 *   itself — it only wires the trigger.
 * @property {(d: {source: string, code: string, message: string, pointer?: string}) => void} [onDiagnostic]
 */

/**
 * Render a tree into a container, replacing whatever was there.
 *
 * @param {object|null} root
 * @param {Element} container
 * @param {{components: Record<string, any>}} catalog
 * @param {RenderDeps} [deps]
 */
export function render(root, container, catalog, deps = {}) {
  container.replaceChildren();
  if (!root) return;
  const el = renderNode(root, catalog, deps);
  if (!el) return;
  // The append is outside renderNode's own try, so it needs its own: attaching
  // the root is where a connectedCallback finally runs for the whole tree.
  try {
    container.appendChild(el);
  } catch (err) {
    deps.onDiagnostic?.({
      source: 'render',
      code: 'component_threw',
      message: `<${root.tag}> threw on attach: ${err?.message ?? err}`,
      pointer: root.statementId,
    });
  }
}

/**
 * @param {object} node
 * @param {{components: Record<string, any>}} catalog
 * @param {RenderDeps} deps
 * @returns {Element|null}
 */
export function renderNode(node, catalog, deps = {}) {
  // The boundary. Everything below can throw for reasons that are not this
  // renderer's fault: `createElement` runs a custom element's constructor
  // synchronously, `appendChild` runs its connectedCallback, and both are
  // component code meeting an attribute combination a person would never have
  // written. Without a catch, one such component takes down the whole surface
  // — and because the throw escapes the paint, every later chunk dies the same
  // way, so a dashboard that was 95% correct becomes a permanently blank box.
  //
  // Per node, so the blast radius is the node. Its children go with it, which
  // is unavoidable — they were arguments to a thing that does not exist — but
  // its siblings and its parent survive.
  try {
    return buildNode(node, catalog, deps);
  } catch (err) {
    deps.onDiagnostic?.({
      source: 'render',
      code: 'component_threw',
      message: `<${node?.tag}> threw while rendering: ${err?.message ?? err}`,
      pointer: node?.statementId,
    });
    return null;
  }
}

/**
 * Is this value a materialized component, or a list containing one?
 *
 * A model that calls a component with children it does not accept —
 * `AppEmptyState([chart], "No usage yet")`, where the first positional is
 * `title` — puts a whole element node into a string slot. Nothing throws:
 * `toText` flattens it, the attribute renders as noise or empty, and the chart
 * is simply absent from the page. That is the hardest kind of failure to see,
 * because the surface still looks plausible.
 *
 * The example used to be `AppCard([chart], "Cost by Model")`, which is what
 * three recorded generations actually wrote. That one is correct DSL now —
 * app-card leads with children like every other container — but the diagnostic
 * outlived its first case, because the category error is general and every
 * component with slots and no children parameter can still meet it.
 */
function isComponentValue(value) {
  if (Array.isArray(value)) return value.some(isComponentValue);
  return !!value && typeof value === 'object' && value.type === 'element';
}

/** "app-chart" / "app-chart, app-table" — for the diagnostic text. */
function describeComponents(value) {
  const list = Array.isArray(value) ? value : [value];
  const tags = list.filter((v) => v && typeof v === 'object' && v.type === 'element').map((v) => v.tag);
  return tags.length ? tags.join(', ') : 'a component';
}

/** @returns {Element|null} */
function buildNode(node, catalog, deps = {}) {
  const doc = deps.doc ?? globalThis.document;
  // Injected so this module stays testable without a router, and so a host
  // that has none refuses every route rather than allowing every route.
  const routes = deps.routes ?? null;
  const def = catalog.components?.[node.tag];
  const report = (code, message) => deps.onDiagnostic?.({ source: 'render', code, message, pointer: node.statementId });

  if (!def) {
    report('unknown_component_type', `"${node.tag}" is not in the catalog`);
    return null;
  }

  const el = doc.createElement(node.tag);
  const attrs = def.attributes || {};

  for (const [key, value] of Object.entries(node.props || {})) {
    if (value === null || value === undefined) continue;
    if (DENIED.has(key)) { report('denied_attribute', `"${key}" may not be set from a surface`); continue; }
    const spec = attrs[key];
    if (!spec) { report('unknown_attribute', `${node.tag} has no "${key}" attribute`); continue; }

    // A component is not a value. This is a category error the renderer can
    // see, so it says so rather than stringifying it: `json` is the one
    // attribute type that legitimately takes structure, and even it takes
    // data, never nodes. Dropped, because "[object Object]" in a heading is
    // not closer to the intent than an empty one, and the diagnostic names
    // both the slot and what was put in it.
    if (isComponentValue(value)) {
      report('component_as_attribute',
        `${node.tag}.${key} takes a value and was given ${describeComponents(value)}`
        + (def.childrenParam ? '' : ` — ${node.tag} takes children through slots, not as an argument`));
      continue;
    }

    if (spec.type === 'boolean') {
      // Presence is what a boolean attribute means. Writing `search="false"`
      // would read as true to every `hasAttribute` check in the component.
      if (value === true || value === 'true' || value === '') el.setAttribute(key, '');
      continue;
    }
    if (spec.type === 'enum' && spec.values?.length && !spec.values.includes(String(value))) {
      // Fall back rather than drop: a layout attribute with no value collapses
      // the component's geometry, which looks like a rendering bug.
      report('enum_violation', `"${value}" is not one of ${spec.values.join(', ')} for ${node.tag}.${key}`);
      if (spec.default === undefined) continue;
      el.setAttribute(key, String(spec.default));
      continue;
    }
    // A closed set of non-numeric values the attribute also accepts. Only
    // `app-grid.columns` today: an integer means `repeat(n, 1fr)`, a template
    // string is the one way to express a ratio anywhere in the vocabulary.
    //
    // Checked rather than passed through, because the value reaches
    // `style.setProperty('--grid-columns', …)` unfiltered and this DSL is
    // written by a model. An integer stays an integer; anything else has to be
    // one of the named proportions. Dropped rather than defaulted — a grid with
    // no template falls back to the responsive `auto-fill` default, which is a
    // worse layout but never a broken one.
    if (spec.templates?.length && !Number.isInteger(Number(value))) {
      if (!spec.templates.includes(String(value))) {
        report('template_not_allowed',
          `"${value}" is not one of ${spec.templates.join(', ')} for ${node.tag}.${key}`);
        continue;
      }
      el.setAttribute(key, String(value));
      continue;
    }
    if (spec.type === 'json') {
      el.setAttribute(key, typeof value === 'string' ? value : JSON.stringify(value));
      continue;
    }
    if (spec.type === 'route') {
      // The one attribute family that can take the user somewhere. Checked
      // against the routes this app actually registered — not a copy of them —
      // so an off-site URL, a `javascript:` scheme or a path into something the
      // user cannot see is dropped rather than rendered as a working link.
      //
      // Dropped, not defaulted: a link to the wrong place is worse than no
      // link, and the diagnostic names the path so the failure is legible.
      // A boolean here is not a bad route, it is a value in the wrong slot —
      // a model one position out of step with the signature, writing the
      // `loading` flag into `chat-href`. Calling that "not a route this app
      // has" is true and useless: it sends you looking for a route named
      // false. Nothing renders wrong, because the slot is left unset either
      // way, so this says what actually happened and stays out of the way.
      if (typeof value === 'boolean') {
        report('non_route_value',
          `${node.tag}.${key} takes a route and was given ${value} — an argument is in the wrong position`);
        continue;
      }
      const path = toText(value);
      if (!routes?.has(path)) {
        report('route_not_allowed', `"${path}" is not a route this app has — ${node.tag}.${key} was left unset`);
        continue;
      }
      el.setAttribute(key, path);
      continue;
    }
    el.setAttribute(key, toText(value));
  }

  // textParam — the component's visible text is its own child text, not an
  // attribute. textContent, so no markup can come out of it by construction.
  if (node.text !== null && node.text !== undefined && def.textParam) {
    if (isComponentValue(node.text)) {
      report('component_as_attribute', `${node.tag} takes text and was given ${describeComponents(node.text)}`);
    } else {
      el.textContent = toText(node.text);
    }
  }

  // dataParam — always a property, never an attribute. Which property, and
  // whether it wants a fetcher, is stated per component in the catalog.
  if (node.data !== null && node.data !== undefined && def.dataParam) {
    const prop = def.dataProp;
    if (!prop) report('no_data_property', `${node.tag} declares dataParam but no dataProp`);
    else if (def.dataAsFetcher) {
      const rows = Array.isArray(node.data) ? node.data : [];
      if (!Array.isArray(node.data)) report('data_not_rows', `${node.tag} needs an array of rows`);
      el[prop] = async () => ({ data: rows, total: rows.length });
    } else {
      el[prop] = node.data;
    }
  }

  // actionParam — the renderer wires the trigger and nothing else. What an
  // Action means is the action runner's business; the spec never names a
  // handler and no on* attribute is ever written.
  if (node.action && node.action.type === 'action' && def.actionParam) {
    el.addEventListener(triggerEvent(def), (ev) => deps.onAction?.(node.action, el, ev));
  }

  // ── The accessibility floor ───────────────────────────────────────────
  // A person operates this component, so it needs a name they can hear. The
  // catalog says where a name may come from (`nameFrom`) and which components
  // must have one (`requiresName`), both derived from the components
  // themselves — see gen-dsl-catalog.mjs.
  //
  // Reported, never invented. Synthesising "Button 3" would satisfy the check
  // and help nobody; a diagnostic reaches the eval harness, which fails the
  // generation, which is the only pressure that actually changes what the model
  // writes.
  if (def.requiresName) {
    const named = (def.nameFrom || []).some((src) =>
      src === 'text'
        ? node.text !== null && node.text !== undefined && String(node.text).trim() !== ''
        : node.props?.[src] !== null && node.props?.[src] !== undefined && String(node.props[src]).trim() !== '');
    if (!named) {
      report('missing_accessible_name',
        `${node.tag} is operable but has no name — set ${(def.nameFrom || []).join(' or ')}`);
    } else if (isTruthy(node.props?.['icon-only']) && !String(node.props?.['aria-label'] ?? '').trim()) {
      // An icon-only control hides its text, so text stops being its name.
      report('missing_accessible_name',
        `${node.tag} is icon-only, so its text is not its name — set aria-label`);
    }
  }

  for (const child of node.children || []) {
    if (!child || child.type !== 'element') continue;
    const childEl = renderNode(child, catalog, deps);
    if (!childEl) continue;
    if (child.slot) applySlot(childEl, child.slot, def, node.tag, report);
    el.appendChild(childEl);
  }

  return el;
}

/**
 * Mark a child as belonging to a named slot.
 *
 * Every component reads `data-slot="…"` now (CONVENTIONS.md §3), but the
 * attribute still comes from the catalog per component rather than being
 * assumed — the catalog is the contract, and the day one component differs
 * again this keeps working. A mismatch appends the child anyway and reports:
 * a misplaced footer button is a smaller failure than a missing one.
 */
/** Boolean attributes arrive as true, "true" or "" depending on the source. */
function isTruthy(v) {
  return v === true || v === 'true' || v === '';
}

function applySlot(childEl, slotName, parentDef, parentTag, report) {
  const slots = parentDef.slots || [];
  const match = slots.find((s) => (typeof s === 'string' ? s : s.name) === slotName);
  if (!match) {
    report('unknown_slot', `${parentTag} has no "${slotName}" slot`);
    return;
  }
  const attribute = typeof match === 'string' ? 'slot' : match.attribute || 'slot';
  childEl.setAttribute(attribute, slotName);
}
