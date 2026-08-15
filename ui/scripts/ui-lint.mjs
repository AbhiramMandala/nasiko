#!/usr/bin/env node
/**
 * Architectural lint for the UI layer (`ui/`).
 *
 * There is no bundler, no type checker and no ESLint here, so every rule in
 * AGENTS.md and ARCHITECTURE.md is currently a convention that a person has to
 * remember. This makes the load-bearing ones mechanical.
 *
 * ─── Why it ratchets instead of failing outright ───────────────────────────
 * A lint that reports 1,200 pre-existing violations on day one gets switched off
 * by the end of the week, and then it protects nothing. So each rule declares how
 * it is enforced:
 *
 *   enforce: 'zero'    — must never occur. Any finding fails.
 *   enforce: 'ratchet' — a recorded baseline count that may go DOWN but never up.
 *
 * The baseline is checked in (`ui-lint-baseline.json`) and is a deliberately
 * uncomfortable document: it is the measured debt, per rule, and every number in
 * it is a thing someone chose not to fix yet. Lower one and re-run with
 * `--update-baseline`.
 *
 * Usage:
 *   node ui/scripts/ui-lint.mjs
 *   node ui/scripts/ui-lint.mjs --update-baseline
 *   node ui/scripts/ui-lint.mjs --rule=layer-direction   # one rule, verbose
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'node:fs/promises';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const UI = resolve(SCRIPTS, '..');
const REPO = resolve(UI, '..');
const BASELINE_PATH = resolve(SCRIPTS, 'ui-lint-baseline.json');

// ── Layer model (ARCHITECTURE.md). Lower number = lower layer. ───────────────
const LAYER = { PLATFORM: 0, DESIGN_SYSTEM: 1, COMPONENT: 2, DOMAIN: 3, APPLICATION: 4 };

/** Design-system primitives: reusable, no domain knowledge. */
const PRIMITIVES = new Set([
  'app-button', 'app-badge', 'app-skeleton', 'app-empty-state', 'app-stat-card',
  'app-modal', 'app-tabs', 'app-loading-bar', 'app-action-menu', 'app-code-snippet',
  'app-line-chart', 'app-card', 'app-stack', 'app-row', 'app-grid', 'app-toolbar',
  'app-toast', 'autocomplete', 'base-layout', 'dropdown-controller',
]);

function layerOf(rel) {
  // Vendored third-party ESM sits below everything: it is a dependency, not a
  // layer of ours. Without this, utils/markdown.js importing marked, and
  // core/element.js importing Lit, both read as upward imports.
  if (rel.includes('/vendor/')) return -1;
  if (rel.startsWith('ui/common/core/') || rel.startsWith('ui/common/services/') ||
      rel.startsWith('ui/common/state/') || rel.startsWith('ui/common/utils/')) {
    return LAYER.PLATFORM;
  }
  if (rel.startsWith('ui/common/styles/') || rel === 'ui/common/global.css') {
    return LAYER.DESIGN_SYSTEM;
  }
  if (rel.startsWith('ui/common/components/')) {
    const name = basename(rel).replace(/\.(js|css)$/, '');
    return PRIMITIVES.has(name) ? LAYER.DESIGN_SYSTEM : LAYER.COMPONENT;
  }
  // Enterprise page components: Domain layer. They import downward into the
  // shared design system and platform; nothing in ui/oss/ or ui/common/ may import them.
  if (rel.startsWith('ui/ee/components/')) return LAYER.DOMAIN;
  if (rel.startsWith('ui/ee/web/services/') || rel.startsWith('ui/oss/')) return LAYER.APPLICATION;
  if (rel.startsWith('ui/ee/')) return LAYER.APPLICATION;
  return LAYER.COMPONENT;
}

/** Resolve an import specifier to a repo-relative path, or null if not local. */
function resolveSpec(fromRel, spec) {
  if (spec.startsWith('/common/')) return 'ui/common/' + spec.slice('/common/'.length);
  // The EE components mount (`EeComponents` in ee/server/src/main.rs). Mapping it
  // here is what lets `oss-must-not-import-ee` see an oss/ file reaching for it.
  if (spec.startsWith('/components/')) return 'ui/ee/components/' + spec.slice('/components/'.length);
  if (spec.startsWith('.')) {
    return relative(REPO, resolve(dirname(resolve(REPO, fromRel)), spec)).replace(/\\/g, '/');
  }
  return null;
}

const IMPORT_RES = [
  /(?:^|\s)(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/gm,
  /(?:^|\s)import\s*['"]([^'"]+)['"]/gm,
  /import\(\s*['"]([^'"]+)['"]/gm,
];

function importsOf(source) {
  const out = new Set();
  for (const re of IMPORT_RES) for (const m of source.matchAll(re)) out.add(m[1]);
  return [...out];
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

// ─────────────────────────────────────────────────────────────────────────────
//  Rules
// ─────────────────────────────────────────────────────────────────────────────

const rules = [
  {
    id: 'layer-direction',
    enforce: 'zero',
    why: 'Dependencies must point downward: Application -> Domain -> Components -> Design System -> Platform. ' +
         'An upward import is what makes a component library un-reusable.',
    check({ rel, source, isJs }) {
      if (!isJs) return [];
      const from = layerOf(rel);
      const out = [];
      for (const spec of importsOf(source)) {
        const target = resolveSpec(rel, spec);
        if (!target) continue;
        const to = layerOf(target);
        if (to > from) {
          out.push({
            file: rel,
            line: lineOf(source, source.indexOf(spec)),
            message: `imports ${spec} (layer ${to}) from layer ${from} — that is upward`,
          });
        }
      }
      return out;
    },
  },

  {
    id: 'oss-must-not-import-ee',
    enforce: 'zero',
    why: 'oss/ is synced verbatim to the public repo (CLAUDE.md). An ee/ reference there breaks the public build ' +
         'and leaks enterprise code.',
    check({ rel, source, isJs }) {
      if (!isJs || !rel.startsWith('oss/')) return [];
      return importsOf(source)
        .filter((s) => (resolveSpec(rel, s) || '').startsWith('ee/'))
        .map((s) => ({ file: rel, line: lineOf(source, source.indexOf(s)), message: `imports ${s}` }));
    },
  },

  {
    id: 'no-private-escape-helper',
    enforce: 'ratchet',
    why: 'There were 38 of these in four mutually incompatible families, two of which did not escape quotes and ' +
         'were used in attribute position. Import escHtml/escAttr from utils/escape.js, or use a Lit template.',
    check({ rel, source, isJs }) {
      if (!isJs || rel.includes('/utils/escape.js')) return [];
      const re = /(?:^|\s)(?:#?esc(?:ape)?(?:Html|Attr)?)\s*(?:\(|=\s*\()/gm;
      const out = [];
      for (const m of source.matchAll(/^\s*(#?esc\w*)\s*\(([^)]*)\)\s*\{/gm)) {
        out.push({ file: rel, line: lineOf(source, m.index), message: `defines ${m[1]}()` });
      }
      return out;
    },
  },

  {
    id: 'no-window-data-function',
    enforce: 'ratchet',
    why: 'Assigning window.fetchX makes the dependency invisible and resolution order-dependent; a missing name ' +
         'used to render an empty view forever. Register with core/data-sources.js instead.',
    check({ rel, source, isJs }) {
      if (!isJs) return [];
      if (rel.endsWith('.preview.js') || rel.includes('/.preview/')) return [];
      const out = [];
      // The shell contract, not a data source: <app-header> and <app-module-nav>
      // read these by name and they are documented as such in AGENTS.md.
      const SHELL_CONTRACT = new Set(['fetchNavigation', 'fetchModuleNav']);
      for (const m of source.matchAll(/^window\.(\w+)\s*=/gm)) {
        if (SHELL_CONTRACT.has(m[1])) continue;
        if (/^(fetch|delete|update|save|create|generate|run|retry|cancel|transcribe)[A-Z]/.test(m[1])) {
          out.push({ file: rel, line: lineOf(source, m.index), message: `assigns window.${m[1]}` });
        }
      }
      return out;
    },
  },

  {
    id: 'teardown-required',
    enforce: 'zero',
    why: 'A component that registers a document/window listener or an interval without a disconnectedCallback ' +
         'keeps itself (and its closures) alive after removal. Three such leaks existed. NasikoElement handles ' +
         'this via listen()/interval(); hand-written components must do it themselves.',
    check({ rel, source, isJs }) {
      if (!isJs || !rel.includes('/components/')) return [];
      if (!/customElements\.define|extends\s+(HTMLElement|NasikoElement|LitElement)/.test(source)) return [];
      // Only count registrations inside a class body — a module-scope listener has
      // no element to leak (login-page.js does this deliberately).
      const classStart = source.search(/class\s+\w+\s+extends/);
      if (classStart < 0) return [];
      const body = source.slice(classStart);
      const registrations = [...body.matchAll(/\b(?:document|window)\.addEventListener\(|\bsetInterval\(/g)];
      if (!registrations.length) return [];
      if (/disconnectedCallback\s*\(/.test(source)) return [];
      if (/extends\s+NasikoElement/.test(source)) return []; // base class tears down for you
      return [{
        file: rel,
        line: lineOf(source, classStart + registrations[0].index),
        message: `${registrations.length} outside registration(s) in a class with no disconnectedCallback`,
      }];
    },
  },

  {
    id: 'scope-required',
    enforce: 'ratchet',
    why: 'Every component sheet must wrap its rules in @scope (element-name) so specificity stays local ' +
         'without !important. An unscoped component sheet leaks document-wide.',
    check({ rel, source, isJs }) {
      if (isJs || !rel.startsWith('ui/common/components/')) return [];
      if (!source.trim()) return [];
      if (/@scope\s*\(/.test(source)) return [];
      return [{ file: rel, line: 1, message: 'component stylesheet has no @scope wrapper' }];
    },
  },

  {
    id: 'not-defined-belongs-in-not-defined-css',
    enforce: 'zero',
    why: 'A :not(:defined) rule in a component sheet does not exist at first paint (the sheet is adopted by its ' +
         'module), so it cannot reserve geometry — and if it contradicts the linked rule it causes the exact ' +
         'layout shift the contract prevents. voice-input cost ~82px of CLS this way.',
    check({ rel, source, isJs }) {
      if (isJs || !rel.startsWith('ui/common/components/')) return [];
      const out = [];
      for (const m of source.matchAll(/:not\(:defined\)/g)) {
        out.push({ file: rel, line: lineOf(source, m.index), message: 'declares :not(:defined) — move it to styles/not-defined.css' });
      }
      return out;
    },
  },

  {
    id: 'no-hardcoded-color',
    enforce: 'ratchet',
    why: 'Colours must come from design tokens or a re-skin cannot be mechanical. Syntax highlighting and brand ' +
         'marks are the legitimate exceptions and are in the baseline.',
    check({ rel, source, isJs }) {
      if (!rel.startsWith('ui/oss/') && !rel.startsWith('ui/ee/')) return [];
      if (rel.includes('/vendor/') || rel === 'ui/common/global.css') return [];
      const out = [];
      for (const m of source.matchAll(/#[0-9a-fA-F]{6}\b|rgba?\(\s*\d+\s*,/g)) {
        out.push({ file: rel, line: lineOf(source, m.index), message: `hardcoded colour ${m[0]}` });
      }
      return out;
    },
  },

  {
    id: 'url-policy',
    enforce: 'zero',
    why: 'A URL is copied, logged, screenshotted and sent to third parties in Referer; in-memory state is not. ' +
         'Write view state with setSearchParams() from utils/url-policy.js, which allowlists the keys.',
    check({ rel, source, isJs }) {
      if (!isJs || rel.includes('url-policy') || rel.endsWith('.preview.js')) return [];
      const out = [];
      for (const m of source.matchAll(/\blocation\.search\s*=|\.searchParams\.set\(\s*['"](\w+)['"]/g)) {
        const key = m[1];
        if (key && ALLOWED_URL_KEYS.has(key)) continue;
        out.push({ file: rel, line: lineOf(source, m.index), message: key ? `writes ?${key}` : 'assigns location.search directly' });
      }
      return out;
    },
  },

  {
    id: 'ee-element-in-shared-css',
    enforce: 'ratchet',
    why: 'ui/oss/ and ui/common/ are synced to the public repo. An enterprise-only element name in a shared stylesheet ships ' +
         'selectors for a page the OSS binary cannot serve, and is a layering violation the compiler cannot catch. ' +
         'Now zero: those components live in ui/ee/components/ and their host geometry in ' +
         'ui/ee/components/ee-page-layout.css. Keep it there.',
    check({ rel, source, isJs }) {
      if (isJs || !rel.startsWith('ui/common/')) return [];
      const out = [];
      for (const el of EE_ONLY_ELEMENTS) {
        const i = source.indexOf(el);
        if (i >= 0) out.push({ file: rel, line: lineOf(source, i), message: `references EE-only element ${el}` });
      }
      return out;
    },
  },
];

// Keep in sync with utils/url-policy.js ALLOWED_PARAMS.
const ALLOWED_URL_KEYS = new Set([
  'id', 'agent_id', 'agent_name', 'session_id', 'context_id', 'trace_id', 'span_id',
  'exec', 'name', 'owner', 'tab', 'page', 'period', 'return_to', 'token', 'run_error',
  // Pagination/query params sent to the API, not written to the address bar.
  'limit', 'offset', 'cursor', 'q', 'status',
]);

const EE_ONLY_ELEMENTS = [
  'users-page', 'teams-page', 'departments-page', 'access-control-page',
  'team-access-page', 'group-mappings-page', 'runtime-page',
];

// ─────────────────────────────────────────────────────────────────────────────

const SEARCH = [
  'ui/common/**/*.{js,css}',
  'ui/oss/*.{js,css,html}',
  'ui/ee/components/**/*.{js,css}',
  'ui/ee/web/**/*.{js,css,html}',
];
const SKIP = (p) => p.includes('/vendor/') || p.includes('/tests/') || p.includes('/node_modules/');

const findings = new Map(rules.map((r) => [r.id, []]));
let fileCount = 0;

for (const pattern of SEARCH) {
  for await (const entry of glob(pattern, { cwd: REPO })) {
    const rel = entry.replace(/\\/g, '/');
    if (SKIP(rel)) continue;
    fileCount++;
    const source = readFileSync(resolve(REPO, rel), 'utf8');
    const isJs = /\.(js|mjs)$/.test(rel);
    for (const rule of rules) {
      for (const f of rule.check({ rel, source, isJs })) findings.get(rule.id).push(f);
    }
  }
}

const only = process.argv.find((a) => a.startsWith('--rule='))?.split('=')[1];
const updating = process.argv.includes('--update-baseline');
const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : { counts: {} };

if (updating) {
  const counts = {};
  for (const r of rules) counts[r.id] = findings.get(r.id).length;
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        _comment:
          'Measured architectural debt, per rule. Every number here is something someone chose not to fix yet. ' +
          "Counts may go down but never up. Regenerate with `node ui/scripts/ui-lint.mjs --update-baseline`.",
        counts,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('baseline updated:');
  for (const r of rules) console.log(`  ${String(counts[r.id]).padStart(5)}  ${r.id}`);
  process.exit(0);
}

let failed = false;
console.log(`ui-lint: ${fileCount} files, ${rules.length} rules\n`);

for (const rule of rules) {
  if (only && rule.id !== only) continue;
  const found = findings.get(rule.id);
  const base = baseline.counts?.[rule.id] ?? 0;
  const limit = rule.enforce === 'zero' ? 0 : base;
  const over = found.length > limit;
  if (over) failed = true;

  const status = over ? 'FAIL' : found.length < base ? 'improved' : 'ok';
  const budget = rule.enforce === 'zero' ? 'must be 0' : `baseline ${base}`;
  console.log(`[${status.padEnd(8)}] ${rule.id}  ${found.length} (${budget})`);

  if (over || only) {
    console.log(`            ${rule.why}`);
    const show = over ? found.slice(0, 15) : found.slice(0, 30);
    for (const f of show) console.log(`            ${f.file}:${f.line}  ${f.message}`);
    if (found.length > show.length) console.log(`            … and ${found.length - show.length} more`);
  }
  if (found.length < base && !only) {
    console.log(`            ${base - found.length} fewer than baseline — run --update-baseline to lock it in`);
  }
}

if (failed) {
  console.error(
    '\nui-lint failed. A `must be 0` rule was violated, or a ratcheted count went up.\n' +
      'Fix the finding — do not raise the baseline. The baseline exists to stop existing debt\n' +
      'from blocking you, not to absorb new debt.\n',
  );
  process.exit(1);
}
console.log('\nui-lint passed.');
