#!/usr/bin/env node
/**
 * Generate `ui/common/design-system/catalog.json` by walking the design system.
 *
 * This is the contract a UI generator reads: the components it may name, the
 * attributes it may set on each, and the values those attributes accept. It is
 * layer 3 of the stack in `docs/TRD-runtime-generated-ui.md` §2.5 — the last
 * thing the generator *reads* before it writes a spec.
 *
 * Why generated rather than hand-written: two files describing one set of
 * components drift, and the drift is silent. That is the exact failure the old
 * hand-written `PRIMITIVES` list in ui-lint.mjs had — nine components were
 * missing from it and nothing noticed. `--check` makes it impossible here, the
 * same way `gen-tokens.mjs --check` does for tokens.
 *
 * Two invariants this enforces, not merely documents:
 *
 *   1. NO STYLING ATTRIBUTES. The A2UI constraint is "structure and data, never
 *      styling". A catalog that exposed `class`, `style` or a colour would let a
 *      generator draw outside the design system, so the emitter refuses to.
 *   2. THE JSDoc IS THE SOURCE OF TRUTH, AND IT MUST MATCH THE CODE. Every
 *      attribute in `observedAttributes` needs an `@attr`, and vice versa. An
 *      attribute the code reads but the catalog omits is invisible to the
 *      generator; one the catalog advertises but the code ignores is a lie.
 *
 * Usage: node ui/scripts/gen-catalog.mjs [--check]
 *   --check  exit 1 if catalog.json is out of date, without writing (for CI)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DS = resolve(UI, 'common/design-system');
const OUT = resolve(DS, 'catalog.json');
const CATALOG_VERSION = '1.0';

/**
 * Components outside `design-system/` that a spec is nonetheless allowed to
 * name. `smart-table` is the only one: it is the sanctioned way to render a
 * collection, and a dashboard without a table is not much of a dashboard.
 * Listed explicitly — a generator's vocabulary should be a decision, not a
 * side effect of where a file happens to live.
 */
const EXTRA = [{ dir: resolve(UI, 'common/features'), name: 'smart-table' }];

/**
 * Attributes a spec may never set, whatever the JSDoc says. These are the
 * styling escape hatches; see invariant 1 above.
 */
const FORBIDDEN = new Set(['class', 'style', 'part', 'exportparts']);

/** Attribute names whose value is a data-source key, not a literal (layer 6). */
const DATA_SOURCE_ATTRS = new Set(['data-fn']);

/** Attribute names whose value is an in-app route, validated against the router. */
const ROUTE_ATTRS = new Set(['href']);

/**
 * Attributes that take a raw CSS length. The components keep them — hand-written
 * pages have legitimate uses — but they are withheld from the catalog, because a
 * spec that can say `height="500vh"` can draw outside the design system, which is
 * the one thing "structure and data, never styling" exists to prevent. Withheld
 * rather than deleted, and reported in `excludedFromCatalog` so the omission is a
 * visible decision instead of a silent gap.
 */
const CSS_VALUED = new Set(['max-width', 'min-width', 'width', 'height', 'max-height', 'min-height']);

/**
 * Attributes that control appearance or layout. Every one of these that IS in the
 * catalog must resolve to a closed set — an enum over design-system vocabulary, or
 * a plain count. The moment one becomes a free string, a generator can express an
 * arbitrary value and the constraint is gone, so the build fails instead.
 */
const CONSTRAINED = new Set(['gap', 'padding', 'align', 'justify', 'radius', 'size', 'variant', 'type', 'trend']);

/** Pull the JSDoc block that contains `@element`. */
function docBlock(src) {
  for (const m of src.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
    if (m[1].includes('@element')) return m[1];
  }
  return null;
}

/** Strip the leading ` * ` from a JSDoc body and join wrapped continuation lines. */
function docLines(block) {
  const raw = block.split('\n').map((l) => l.replace(/^\s*\*ractice?\s?/, '').replace(/^\s*\*\s?/, ''));
  /** @type {string[]} */
  const out = [];
  for (const line of raw) {
    // A line that does not open a new tag continues the previous one — several
    // @attr descriptions wrap across two or three lines.
    if (/^\s*@\w+/.test(line) || out.length === 0) out.push(line.trimEnd());
    else out[out.length - 1] += ' ' + line.trim();
  }
  return out;
}

/**
 * Derive a type from the declared JSDoc type plus the prose.
 *
 * The prose carries more than the type annotation does: `{string} variant` is
 * really an enum, and the allowed values only exist in the description as
 * backticked alternatives. Reading them is what lets the renderer reject a bad
 * value instead of passing it through.
 */
function typeOf(name, declared, desc) {
  if (DATA_SOURCE_ATTRS.has(name)) return { type: 'dataSource' };
  if (ROUTE_ATTRS.has(name)) return { type: 'route' };

  // `a` | `b` | `c` — an enum written as backticked alternatives. For the
  // appearance-controlling family a single documented value is still a closed
  // set of one (app-button's `sm`, where omitting it means the default size).
  //
  // Only the value list is scanned, never the commentary after it: prose that
  // *mentions* a token in backticks ("`lg` is not a value") would otherwise be
  // read as an allowed value. The list ends at the first em dash or sentence
  // break, which is how every @attr in this codebase is written.
  const valueList = desc.split(/\s+—\s+|\.\s+/)[0];
  const ticked = [...valueList.matchAll(/`([A-Za-z][\w-]*)`/g)].map((m) => m[1]);
  const alternation = /`[\w-]+`(?:\s*\([^)]*\))?\s*\|/.test(valueList);
  if ((alternation && ticked.length >= 2) || (CONSTRAINED.has(name) && ticked.length >= 1)) {
    const values = [...new Set(ticked)];
    const out = { type: 'enum', values };
    const def = valueList.match(/`([\w-]+)`\s*\(default\)/);
    if (def) out.default = def[1];
    return out;
  }

  if (declared === 'boolean') return { type: 'boolean' };
  if (declared === 'number' || declared === 'string|number') {
    const out = { type: 'number' };
    const def = desc.match(/\(default:?\s*([\d.]+)\)/);
    if (def) out.default = Number(def[1]);
    return out;
  }
  // "JSON array of `{ id, label }`" — structured, not a display string. The
  // generator has to know the difference to emit anything valid.
  if (/JSON (array|object)/i.test(desc)) return { type: 'json' };

  const out = { type: 'string' };
  const def = desc.match(/\(default:?\s*["'`]?([\w-]+)["'`]?\)/);
  if (def) out.default = def[1];
  return out;
}

/** Normalise the several `@slot` spellings to a slot name. */
function slotName(raw) {
  const m = raw.match(/\[data-slot="([\w-]+)"\]|\[slot="([\w-]+)"\]|^([\w-]+)/);
  return m ? m[1] || m[2] || m[3] : null;
}

/** Parse one component file. Returns null when it defines no custom element. */
function parseComponent(file) {
  const src = readFileSync(file, 'utf8');

  const def = src.match(/customElements\.define\(\s*["']([\w-]+)["']|defineElement\(\s*["']([\w-]+)["']/);
  if (!def) return null; // exports functions, not an element (app-tooltip, confirm-dialog)
  const element = def[1] || def[2];

  const block = docBlock(src);
  if (!block) throw new Error(`${relative(UI, file)}: defines <${element}> but has no @element JSDoc block`);
  const lines = docLines(block);

  const declared = lines.find((l) => l.startsWith('@element'))?.slice('@element'.length).trim();
  if (declared !== element) {
    throw new Error(`${relative(UI, file)}: @element says "${declared}" but the code registers "${element}"`);
  }

  /** @type {Record<string, object>} */
  const attributes = {};
  /** @type {{ attribute: string, reason: string }[]} */
  const excluded = [];
  for (const line of lines) {
    const m = line.match(/^@attr\s+\{([^}]+)\}\s+([\w-]+)\s*-?\s*(.*)$/);
    if (!m) continue;
    const [, dtype, name, desc] = m;
    if (FORBIDDEN.has(name)) {
      throw new Error(
        `${relative(UI, file)}: <${element}> documents a styling attribute "${name}". ` +
          `The catalog exists to make generated UI unable to style itself — see TRD §5.1.`,
      );
    }
    if (CSS_VALUED.has(name)) {
      excluded.push({ attribute: name, reason: 'takes a raw CSS length; a spec must not set dimensions' });
      continue;
    }
    const spec = typeOf(name, dtype.trim(), desc);
    if (CONSTRAINED.has(name) && spec.type !== 'enum' && spec.type !== 'number') {
      throw new Error(
        `${relative(UI, file)}: <${element}> attribute "${name}" is appearance-controlling but resolves to ` +
          `"${spec.type}", not a closed set. Document its allowed values as backticked alternatives ` +
          `(\`a\` | \`b\`) so a generated spec cannot invent one.`,
      );
    }
    if (/\(required\)/i.test(desc)) spec.required = true;
    spec.description = desc.replace(/\s+/g, ' ').trim();
    attributes[name] = spec;
  }

  // Drift check: the code and the doc must agree on the attribute set.
  const obs = src.match(/observedAttributes\(\)\s*\{[\s\S]*?return\s*\[([^\]]*)\]/);
  if (obs) {
    const observed = [...obs[1].matchAll(/["']([\w-]+)["']/g)].map((m) => m[1]);
    const documented = new Set(Object.keys(attributes));
    const withheld = new Set(excluded.map((e) => e.attribute));
    const missing = observed.filter((a) => !documented.has(a) && !FORBIDDEN.has(a) && !withheld.has(a));
    const phantom = [...documented].filter((a) => !observed.includes(a));
    if (missing.length) {
      throw new Error(
        `${relative(UI, file)}: <${element}> observes [${missing.join(', ')}] but has no @attr for them. ` +
          `An attribute the code reads and the catalog omits is invisible to a generator.`,
      );
    }
    if (phantom.length) {
      throw new Error(
        `${relative(UI, file)}: <${element}> documents [${phantom.join(', ')}] which observedAttributes does not list. ` +
          `An attribute the catalog advertises and the code ignores is a lie to the generator.`,
      );
    }
  }

  const slots = lines
    .filter((l) => l.startsWith('@slot'))
    .map((l) => slotName(l.slice('@slot'.length).trim()))
    .filter(Boolean);

  const events = lines
    .filter((l) => /^@(fires|event)\s/.test(l))
    .map((l) => {
      const m = l.match(/^@(?:fires|event)\s+([\w-]+)\s*-?\s*(.*)$/);
      return m ? { name: m[1], description: m[2].replace(/\s+/g, ' ').trim() } : null;
    })
    .filter(Boolean);

  // First prose paragraph of the block, as the "what is this for" line.
  const summary = lines.slice(0, lines.findIndex((l) => l.startsWith('@')) < 0 ? lines.length : lines.findIndex((l) => l.startsWith('@')))
    .join(' ').replace(/\s+/g, ' ').trim();

  return {
    element,
    summary: summary.split(/(?<=\.)\s/)[0] || summary,
    source: relative(UI, file),
    attributes,
    ...(excluded.length ? { excludedFromCatalog: excluded } : {}),
    slots: [...new Set(slots)],
    events,
  };
}

function build() {
  /** @type {Record<string, object>} */
  const components = {};
  /** @type {string[]} */
  const notElements = [];

  const dirs = readdirSync(DS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ dir: DS, name: d.name }));

  for (const { dir, name } of [...dirs, ...EXTRA]) {
    const file = resolve(dir, name.endsWith('.js') ? name : `${name}/${name}.js`);
    const flat = resolve(dir, `${name}.js`);
    const path = existsSync(file) ? file : existsSync(flat) ? flat : null;
    if (!path) continue;
    const parsed = parseComponent(path);
    if (!parsed) { notElements.push(name); continue; }
    components[parsed.element] = parsed;
  }

  const names = Object.keys(components).sort();
  return {
    $comment:
      'GENERATED by ui/scripts/gen-catalog.mjs from the JSDoc in each component. Do not edit. ' +
      'This is the vocabulary a generated UI spec may use: structure and data, never styling.',
    catalogVersion: CATALOG_VERSION,
    componentCount: names.length,
    notElements: notElements.sort(),
    components: Object.fromEntries(names.map((n) => [n, components[n]])),
  };
}

const next = JSON.stringify(build(), null, 2) + '\n';

if (process.argv.includes('--check')) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (cur !== next) {
    console.error('catalog.json is out of date — run: node ui/scripts/gen-catalog.mjs');
    process.exit(1);
  }
  const n = JSON.parse(next);
  console.log(`gen-catalog: catalog.json up to date (${n.componentCount} components)`);
} else {
  writeFileSync(OUT, next);
  const n = JSON.parse(next);
  console.log(`gen-catalog: wrote ${relative(UI, OUT)} (${n.componentCount} components)`);
}
