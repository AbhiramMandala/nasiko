/**
 * Static validation: a spec plus the catalog, in — diagnostics out.
 *
 * The split with `bind.js` is deliberate and worth stating, because putting a
 * check on the wrong side of it produces either a false alarm or a miss.
 *
 *   - **Static** (here): everything decidable from the spec and the catalog
 *     alone — is the type real, is the attribute real, is the enum value legal,
 *     is the data source one we expose, does the child exist. All of it holds
 *     before a single byte of data arrives, so it can be reported while the
 *     stream is still open and fed back to the generator as a repair.
 *   - **Dynamic** (`bind.js`): everything that needs the data — did the path
 *     resolve, is the value a scalar. A binding's value is unknowable here, so
 *     this file must not guess at it: a bound enum attribute is checked for a
 *     *declared* bind, not for a legal value.
 *
 * Codes are stable strings, identical on both sides of the wire, so Weave can
 * act on them without matching prose.
 *
 * @module features/weave-surface/validate
 */

import { isBinding, parseBinding } from './bind.js';

/**
 * Attributes a surface may never set, whatever the catalog says.
 * `style` and `class` are the styling escape; `id` belongs to the renderer,
 * since node identity comes from the spec.
 */
export const DENIED_ATTRS = new Set(['style', 'class', 'id', 'part', 'is']);

/**
 * Attributes whose contract *is* markup, so the component writes them out
 * unescaped on purpose.
 *
 * Escaping them would break the components; letting a generated surface set
 * them would hand an untrusted spec an HTML sink and make the rest of §9
 * decorative. So they are simply not part of the vocabulary a spec may use —
 * the equivalent slot accepts a real element, which the renderer can build
 * safely. Keyed `element.attribute`.
 *
 * This list is hand-kept today. It should be a flag the catalog generator
 * emits, read off the same JSDoc that documents the attribute as markup —
 * a hand-kept list of dangerous names is the failure mode this codebase has
 * already paid for once.
 */
export const MARKUP_SINKS = new Set(['app-empty-state.icon']);

const err = (code, pointer, message) => ({ level: 'error', code, pointer, message });
const warn = (code, pointer, message) => ({ level: 'warn', code, pointer, message });

/**
 * @typedef {object} ValidateOptions
 * @property {Set<string>|string[]} [exposed] Data-source names a spec may name.
 *   Omit to skip the check — useful before the manifest exists, but a surface
 *   validated without it has not had its one real boundary checked.
 * @property {Set<string>|string[]} [routes] Registered router paths.
 * @property {number} [maxDepth] Nesting cap for sub-surfaces.
 */

/** @param {Set<string>|string[]|undefined} v */
const asSet = (v) => (v instanceof Set ? v : Array.isArray(v) ? new Set(v) : null);

/**
 * Validate one spec against one catalog.
 *
 * Reports everything it finds rather than stopping at the first problem: the
 * repair loop on the generator side is far more useful with the whole list, and
 * a surface with three bad nodes should degrade three nodes, not refuse.
 *
 * @param {{data?: Record<string, any>, nodes?: Record<string, any>}} spec
 * @param {{components: Record<string, any>}} catalog
 * @param {ValidateOptions} [options]
 * @returns {{level: string, code: string, pointer?: string, message?: string}[]}
 */
export function validateSpec(spec, catalog, options = {}) {
  const out = [];
  const components = catalog?.components ?? {};
  const nodes = spec?.nodes ?? {};
  const data = spec?.data ?? {};
  const exposed = asSet(options.exposed);
  const routes = asSet(options.routes);

  // ── data declarations ──────────────────────────────────────────────────
  for (const [bind, decl] of Object.entries(data)) {
    if (!decl || typeof decl.source !== 'string' || !decl.source) {
      out.push(err('malformed_data_declaration', bind, 'a data declaration needs a source name'));
      continue;
    }
    if (exposed && !exposed.has(decl.source)) {
      out.push(err('source_not_allowlisted', bind,
        `"${decl.source}" is not a data source a generated surface may name`));
    }
  }

  // ── structure ──────────────────────────────────────────────────────────
  const ids = Object.keys(nodes);
  if (ids.length && !nodes.root) out.push(err('no_root', undefined, 'no node has the id "root"'));

  for (const [id, node] of Object.entries(nodes)) {
    for (const child of node?.children ?? []) {
      if (!nodes[child]) out.push(err('dangling_child', id, `child "${child}" was never declared`));
    }
  }
  for (const id of ids) {
    if (nodes[id]?.repeat === undefined) continue;
    // A repeat inside a repeat multiplies rows by rows. The one case that
    // needs it is a table, which is a single component.
    for (const ancestor of ancestorsOf(id, nodes)) {
      if (nodes[ancestor]?.repeat !== undefined) {
        out.push(err('nested_repeat', id, `repeat inside the repeat on "${ancestor}"`));
        break;
      }
    }
  }

  // ── nodes ──────────────────────────────────────────────────────────────
  for (const [id, node] of Object.entries(nodes)) {
    out.push(...validateNode(id, node, components, { data, exposed, routes }));
  }

  return out;
}

/** Ids on the path from root to `id`, nearest last. Cycles terminate. */
function ancestorsOf(id, nodes) {
  /** @type {Record<string, string>} */
  const parent = {};
  for (const [pid, node] of Object.entries(nodes)) {
    for (const child of node?.children ?? []) if (!parent[child]) parent[child] = pid;
  }
  const chain = [];
  const seen = new Set([id]);
  let cur = parent[id];
  while (cur && !seen.has(cur)) {
    chain.push(cur);
    seen.add(cur);
    cur = parent[cur];
  }
  return chain;
}

/**
 * Validate one node's type and props against the catalog.
 *
 * @param {string} id
 * @param {any} node
 * @param {Record<string, any>} components
 * @param {{data: Record<string, any>, exposed: Set<string>|null, routes: Set<string>|null}} ctx
 */
export function validateNode(id, node, components, ctx) {
  const out = [];
  const spec = components[node?.type];

  if (!spec) {
    out.push(err('unknown_component_type', id, `"${node?.type}" is not in the catalog`));
    return out;
  }
  // Present in the file but deliberately not part of the vocabulary — the
  // generator needs to hear that as its own thing, not as "no such component",
  // or it will keep proposing something that does exist.
  if (spec.excludedFromCatalog) {
    out.push(err('component_not_offered', id, `"${node.type}" exists but is excluded from the catalog`));
    return out;
  }

  const attrs = spec.attributes ?? {};
  const props = node.props ?? {};

  for (const [name, value] of Object.entries(props)) {
    if (DENIED_ATTRS.has(name)) {
      out.push(err('styling_attribute', `${id}.${name}`, `"${name}" may never be set from a spec`));
      continue;
    }
    if (MARKUP_SINKS.has(`${node.type}.${name}`)) {
      out.push(err('markup_sink_attribute', `${id}.${name}`,
        `"${name}" is written as raw markup by ${node.type} and may not be set from a spec`));
      continue;
    }
    const attr = attrs[name];
    if (!attr) {
      out.push(warn('unknown_attribute', `${id}.${name}`, `${node.type} has no "${name}" attribute`));
      continue;
    }
    out.push(...validateAttribute(id, name, value, attr, ctx));
  }

  for (const [name, attr] of Object.entries(attrs)) {
    if (attr.required && props[name] === undefined) {
      out.push(err('missing_required_attribute', `${id}.${name}`, `${node.type} requires "${name}"`));
    }
  }

  return out;
}

/**
 * @param {string} id
 * @param {string} name
 * @param {unknown} value
 * @param {any} attr Catalog entry for the attribute.
 * @param {{data: Record<string, any>, exposed: Set<string>|null, routes: Set<string>|null}} ctx
 */
function validateAttribute(id, name, value, attr, ctx) {
  const out = [];
  const pointer = `${id}.${name}`;

  if (isBinding(value)) {
    // A bound value is unknown until the data lands, so the only static thing
    // worth saying is whether the bind could ever resolve.
    const { segments, error } = parseBinding(/** @type {string} */ (value));
    if (error) return [err(error, pointer, `"${value}" is not a valid binding`)];
    const head = segments[0];
    if (head !== 'item' && head !== 'index' && !Object.prototype.hasOwnProperty.call(ctx.data, String(head))) {
      out.push(err('unresolved_bind', pointer, `"${value}" names no declared data source`));
    }
    if (attr.type === 'dataSource') {
      // The name of a data source is a contract, not a datum: binding it means
      // the allowlist cannot be checked until runtime, which defeats it.
      out.push(err('bound_data_source', pointer, 'a data-source attribute must be a literal name'));
    }
    return out;
  }

  switch (attr.type) {
    case 'enum':
      if (attr.values?.length && !attr.values.includes(String(value))) {
        out.push(warn('enum_violation', pointer,
          `"${value}" is not one of ${attr.values.join(', ')}${attr.default ? ` — using "${attr.default}"` : ''}`));
      }
      break;
    case 'number':
      if (value !== '' && Number.isNaN(Number(value))) {
        out.push(warn('type_violation', pointer, `"${value}" is not a number`));
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean' && !['true', 'false', '', null].includes(/** @type {any} */ (value))) {
        out.push(warn('type_violation', pointer, `"${value}" is not a boolean`));
      }
      break;
    case 'json':
      try {
        JSON.stringify(value);
      } catch {
        out.push(err('type_violation', pointer, 'value is not serialisable as JSON'));
      }
      break;
    case 'dataSource':
      if (typeof value !== 'string' || !value) {
        out.push(err('type_violation', pointer, 'a data-source attribute needs a registered name'));
      } else if (ctx.exposed && !ctx.exposed.has(value)) {
        out.push(err('source_not_allowlisted', pointer,
          `"${value}" is not a data source a generated surface may name`));
      }
      break;
    case 'route':
      if (ctx.routes && !ctx.routes.has(String(value))) {
        // There is no field for an external URL, so an unknown route is either
        // a typo or an attempt to reach outside the app. Both are refusals.
        out.push(err('unknown_route', pointer, `"${value}" is not a registered route`));
      }
      break;
    default:
      break;
  }
  return out;
}

/**
 * The value to actually set, once validation has had its say.
 *
 * Shared with the renderer so the substitution rule lives in one place: a bad
 * enum falls back to the catalog default rather than being dropped, because a
 * layout attribute with no value collapses the component's geometry.
 *
 * @param {unknown} value
 * @param {any} attr
 * @returns {{ set: boolean, value?: string }}
 */
export function coerceAttribute(value, attr) {
  if (value === undefined || value === null) return { set: false };
  if (attr?.type === 'boolean') {
    const on = value === true || value === 'true' || value === '';
    // A boolean attribute is present or absent. Setting `search="false"` makes
    // hasAttribute() true, which is the opposite of what the spec asked for.
    return on ? { set: true, value: '' } : { set: false };
  }
  if (attr?.type === 'enum' && attr.values?.length && !attr.values.includes(String(value))) {
    return attr.default ? { set: true, value: String(attr.default) } : { set: false };
  }
  if (attr?.type === 'json') {
    return { set: true, value: typeof value === 'string' ? value : JSON.stringify(value) };
  }
  return { set: true, value: String(value) };
}
