#!/usr/bin/env node
/**
 * Does the generator write DSL this client can actually render?
 *
 * The 209 unit tests prove the parser, materializer, renderer and reactivity
 * are correct. None of them says anything about whether the *model* produces
 * good DSL — so until now the only feedback loop on a prompt change or a
 * catalog change was opening a browser and forming an impression. That is not
 * a feedback loop you can iterate on, and it means a regression is found by
 * whoever hits it.
 *
 * This runs real prompts through the real endpoint and puts the real pipeline
 * behind them. It asserts nothing about *taste* — whether a bar chart was the
 * right call is not checkable — only about the things that are objectively
 * broken:
 *
 *   - the DSL parses, and every statement in it parses
 *   - materializing produces no diagnostics
 *   - nothing references a name that does not exist
 *   - every Query names a source the scope actually allows
 *   - there is a root, and it resolves to a component
 *   - the tree renders without a single component being dropped
 *
 * Every one of those has been a real bug in this pipeline at least once.
 *
 * Usage:
 *   node ui/scripts/eval-generations.mjs                 # against the endpoint
 *   node ui/scripts/eval-generations.mjs --record        # save responses as fixtures
 *   node ui/scripts/eval-generations.mjs --offline       # replay saved fixtures, no network
 *   node ui/scripts/eval-generations.mjs --case spend    # one case
 *
 * `--offline` is what CI runs: recorded generations, replayed, so a change to
 * the runtime or the catalog is checked against real model output on every
 * commit without spending a token or depending on a model being up. Re-record
 * deliberately when the prompt changes — the diff in `fixtures/` is then the
 * review artifact showing what the model started writing differently.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = resolve(UI, 'tests/fixtures/generations');
const CATALOG = resolve(UI, 'common/surface/dsl-catalog.json');

const { parseBuffer } = await import(new URL('../common/surface/parser.js', import.meta.url).href);
const { materialize, buildComponentIndex } = await import(new URL('../common/surface/materialize.js', import.meta.url).href);
const { render } = await import(new URL('../common/surface/render.js', import.meta.url).href);

const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
const index = buildComponentIndex(catalog);

/**
 * The prompts.
 *
 * Chosen to exercise the grammar rather than to flatter it: each names a shape
 * the model has to get structurally right, and several are phrased the way a
 * real person asks rather than the way the examples in agent.yaml are written.
 *
 * `expect` is deliberately thin. Asserting a specific component would make
 * this a test of the model's taste, which changes with every prompt tweak and
 * is not a regression when it does. Asserting *at least one Query* or *a table
 * somewhere* catches the failure that matters: a generation that looks fine
 * and contains no real data.
 */
export const CASES = [
  { id: 'spend-14d', prompt: 'Show me spend and request volume for the last 14 days',
    expect: { minQueries: 1, minComponents: 3 } },
  { id: 'agents-table', prompt: 'Which agents cost the most? Table, with a cost breakdown',
    expect: { minQueries: 1, tags: ['app-table'] } },
  { id: 'switchable', prompt: 'Give me a cost dashboard I can switch between cost and operations',
    expect: { minQueries: 1, minActions: 1, minStates: 1 } },
  // The one case that names a component, and it earns it: the prompt says
  // "with a chart", so a tree without one did not answer the question. It has
  // already caught the failure it was written for — a generation that wrote
  // two AppCharts and left the row holding them unreferenced, which the
  // orphaned_statement diagnostic now names directly.
  //
  // Known-failing as of the current recording, and deliberately left that way:
  // the generation wraps its chart in `AppCard([chartContainer], "Cost by
  // Model")`, but app-card takes children through slots — its first positional
  // is `name`. The whole subtree goes into a string attribute, the chart never
  // reaches the page, and until `component_as_attribute` landed nothing said
  // so. This is the composition failure the layout grammar work exists to fix,
  // so this case is the measure of it: when the model learns which components
  // nest and how, this passes and the annotation has to come off.
  { id: 'by-model-chart', prompt: 'Usage by model, with a chart',
    expect: { minQueries: 1, tags: ['app-chart'] },
    knownFailure: 'wraps the chart in AppCard, which has no children parameter — awaiting the composition grammar' },
  { id: 'kpis-only', prompt: 'Just the headline numbers, nothing else',
    expect: { minQueries: 1 } },
  { id: 'filter-days', prompt: 'History chart with buttons to switch between 7 and 30 days',
    expect: { minQueries: 1, minActions: 1, minStates: 1 } },
  { id: 'vague', prompt: 'how are we doing on cost',
    expect: { minQueries: 1 },
  },
  { id: 'terse', prompt: 'spend',
    expect: { minQueries: 1 } },
  // Interactive controls are where a model leaves things unnamed. Three rounds
  // of prompt edits could not make it fill AppSearch's aria-label when it had
  // already written a placeholder saying the same thing, so app-search now
  // names itself from the placeholder and the catalog says so. What this case
  // still catches is a control with neither.
  { id: 'interactive-controls', prompt: 'Cost dashboard with a search box and buttons to change the window',
    expect: { minQueries: 1, minActions: 1 } },
  // Not a dashboard request. agent.yaml rule 11 says answer in plain text, so
  // the correct outcome is prose and *no* DSL — a generator that builds a
  // dashboard here is broken in a way no other case would catch.
  { id: 'greeting', prompt: 'hey, what can you do?',
    expect: { noSurface: true } },
  // Names a source that is not in the tokenops scope. The line filter should
  // drop it, so the correct outcome is either no Query or a refusal — never a
  // Query naming something that does not exist.
  { id: 'out-of-scope', prompt: 'Show me our AWS bill by service',
    expect: { allowNoSurface: true } },
];

/**
 * How seriously to take each diagnostic — read from the generated manifest, not
 * hand-kept here.
 *
 * This was a three-entry literal, and two of the three were added *reactively*,
 * after a new code turned a correct surface red. That is the wrong direction to
 * fail in: it teaches people to ignore the checker. `gen-diagnostics.mjs` now
 * requires a decision per code and `--check` refuses an unclassified one, so
 * the next code cannot arrive fatal-by-omission.
 *
 *   fatal     the generation is wrong — something asked for is missing or wrong
 *   advisory  the runtime corrected a real mistake; the surface is still right
 *   runtime   a failed source, a dropped stream, a host gap. Says nothing about
 *             the DSL, and should not appear offline at all — if one does, the
 *             harness is what is broken, so it is printed under its own heading
 *             rather than folded in with the model's mistakes.
 */
const SEVERITY = JSON.parse(
  readFileSync(new URL('../common/surface/diagnostics.json', import.meta.url), 'utf8'),
).diagnostics;

/** Unknown means unclassified means fatal — the gate should have caught it. */
const severityOf = (code) => SEVERITY[code]?.severity ?? 'fatal';

/** Every source the scope allows. Anything else must not survive to the client. */
export const ALLOWED_SOURCES = new Set([
  'fetchTokenopsDashboard', 'fetchUsageSummary', 'fetchUsageHistory',
  'fetchUsageByAgent', 'fetchUsageByModel',
]);

/** A recording element — the same shape the renderer tests use. */
function makeEl(tag) {
  return {
    tag, attrs: {}, children: [], listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    replaceChildren() { this.children.length = 0; },
  };
}

function walk(el, fn) {
  fn(el);
  for (const c of el.children) walk(c, fn);
}

/**
 * Everything the client would do with this text, and everything it complained
 * about on the way. No network, no DOM — the same modules the browser runs.
 */
export function evaluateGeneration(text) {
  const diagnostics = [];
  const { statements, prose } = parseBuffer(text);
  const out = materialize(statements, index, { complete: true });
  diagnostics.push(...out.diagnostics);

  const container = makeEl('div');
  render(out.root, container, catalog, {
    doc: { createElement: makeEl },
    // Every route the app has, so a link is only reported when the model
    // invented a path rather than because this harness has no router.
    routes: { has: (p) => catalog.routes.includes(String(p).split('?')[0]) },
    onDiagnostic: (d) => diagnostics.push(d),
  });

  const tags = [];
  if (container.children[0]) walk(container.children[0], (el) => tags.push(el.tag));

  return {
    statements: statements.length,
    prose,
    root: out.root,
    tags,
    queries: out.queries,
    mutations: out.mutations,
    states: out.states,
    unresolved: out.unresolved,
    actions: statements.filter((s) => /=\s*Action\(/.test(s.raw ?? '')).length,
    diagnostics,
  };
}

/** @returns {string[]} the reasons this generation is not acceptable */
export function check(kase, text) {
  const r = evaluateGeneration(text);
  const fail = [];
  /** Corrected, not broken — shown, never fatal. */
  const advisory = [];
  const runtime = [];
  const e = kase.expect ?? {};

  if (e.noSurface) {
    if (r.root) fail.push('built a dashboard for a question that should have been answered in prose (rule 11)');
    if (!r.prose.join('').trim()) fail.push('answered with nothing at all');
    return { fail, advisory, runtime, r };
  }

  if (!r.root) {
    if (e.allowNoSurface) return { fail, advisory, runtime, r };
    fail.push('no root — nothing rendered');
  }

  // These are never acceptable, whatever the case asked for.
  for (const d of r.diagnostics) {
    const line = `diagnostic ${d.source}/${d.code}: ${d.message}`;
    const severity = severityOf(d.code);
    if (severity === 'fatal') fail.push(line);
    else if (severity === 'runtime') runtime.push(line);
    else advisory.push(line);
  }
  for (const name of r.unresolved) fail.push(`references "${name}", which is not defined`);
  for (const q of r.queries) {
    if (!ALLOWED_SOURCES.has(q.source)) fail.push(`Query names "${q.source}", which the scope does not allow`);
  }
  if (r.mutations.length) fail.push(`wrote ${r.mutations.length} Mutation(s); no write-capable source exists`);

  if (e.minQueries && r.queries.length < e.minQueries) {
    fail.push(`${r.queries.length} queries, expected at least ${e.minQueries} — a dashboard with no real data`);
  }
  if (e.minComponents && r.tags.length < e.minComponents) {
    fail.push(`${r.tags.length} components, expected at least ${e.minComponents}`);
  }
  if (e.minActions && r.actions < e.minActions) {
    fail.push(`${r.actions} Actions, expected at least ${e.minActions}`);
  }
  if (e.minStates && r.states.length < e.minStates) {
    fail.push(`${r.states.length} $state variables, expected at least ${e.minStates}`);
  }
  for (const tag of e.tags ?? []) {
    if (!r.tags.includes(tag)) fail.push(`no <${tag}> anywhere in the tree`);
  }

  return { fail, advisory, runtime, r };
}

/** Read one generation off the live endpoint, concatenating its dsl-chunks. */
async function generate(prompt) {
  const base = process.env.WEAVE_BASE_URL || 'http://localhost:8801';
  const token = process.env.WEAVE_INTERNAL_TOKEN || '';
  const res = await fetch(`${base}/api/weave/surface`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(token ? { 'x-weave-internal-token': token } : {}),
    },
    body: JSON.stringify({ prompt, context: { catalogVersion: catalog.catalogVersion } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${base} — is Weave running, and is the token set?`);

  let text = '';
  let generatorCatalog = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const event = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim();
      const data = frame.match(/^data:\s*(.+)$/m)?.[1];
      if (!data) continue;
      if (event === 'surface') {
        try { generatorCatalog = JSON.parse(data).catalogVersion ?? null; } catch { /* reported below */ }
        continue;
      }
      if (event !== 'dsl-chunk') continue;
      try { text += JSON.parse(data).text ?? ''; } catch { /* a truncated frame is the client's problem too */ }
    }
  }
  return { text, generatorCatalog };
}

// ── main ────────────────────────────────────────────────────────────────────
// Guarded so the checker above can be imported and tested without a model, a
// network, or a process exit.

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!invokedDirectly) { /* imported for its checker */ } else {

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const record = args.includes('--record');
const only = args[args.indexOf('--case') + 1];
const cases = only && args.includes('--case') ? CASES.filter((c) => c.id === only) : CASES;

if (!existsSync(FIXTURES)) mkdirSync(FIXTURES, { recursive: true });

if (offline) {
  const have = new Set(readdirSync(FIXTURES).filter((f) => f.endsWith('.dsl')).map((f) => f.replace(/\.dsl$/, '')));
  const missing = cases.filter((c) => !have.has(c.id));
  if (missing.length && have.size === 0) {
    // Nothing recorded at all — there is no baseline yet, so there is nothing
    // to regress against and failing would just park CI on red for a reason
    // nobody can fix without a live model. Say so once and pass.
    console.log('eval: no recordings yet — run with --record against a live Weave to create a baseline.');
    process.exit(0);
  }
  if (missing.length) {
    // Some recordings exist and these do not, which means a case was added
    // without one. That is a gap somebody introduced, so it fails.
    console.error(`eval: no recording for ${missing.map((c) => c.id).join(', ')}, but others exist.`);
    console.error('A case without a recording is a case that never runs. Record it, or remove it.');
    process.exit(1);
  }
}

// The token lives in the Weave repo's .env and this script runs from this one,
// so "I sourced it" and "this process can see it" are different statements.
// Checked once here rather than per case, because the same message ten times
// is noise around the one line that matters.
if (!offline && !process.env.WEAVE_INTERNAL_TOKEN) {
  console.error('eval: WEAVE_INTERNAL_TOKEN is not set in this shell.\n');
  console.error('  set -a && source ~/Documents/GitHub/Weave/.env && set +a\n');
  console.error('Weave also has to be running — uvicorn on :8801, or set WEAVE_BASE_URL.');
  process.exit(1);
}

let failed = 0;
for (const kase of cases) {
  const path = resolve(FIXTURES, `${kase.id}.dsl`);
  let text;
  try {
    if (offline) {
      text = readFileSync(path, 'utf8');
    } else {
      const got = await generate(kase.prompt);
      text = got.text;
      // The generator says which catalog it built against. Judging its output
      // with a different one is judging the wrong thing — and a silent
      // fallback to a stale bundled copy looks exactly like a model that will
      // not follow a rule, which cost three rounds of prompt edits before
      // anyone thought to check.
      if (got.generatorCatalog && got.generatorCatalog !== catalog.catalogVersion) {
        console.error(`\neval: the generator built against catalog ${got.generatorCatalog}, this repo has ${catalog.catalogVersion}.`);
        console.error('Every result below would be judged against a vocabulary the generator never saw.');
        console.error('Point WEAVE_CATALOG_URL at this control plane and restart Weave.');
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`✗ ${kase.id}: ${err.message}`);
    failed++;
    continue;
  }
  if (record) writeFileSync(path, text);

  const { fail, advisory, runtime, r } = check(kase, text);

  if (kase.knownFailure) {
    if (fail.length) {
      console.log(`~ ${kase.id} — known failure: ${kase.knownFailure}`);
      for (const f of fail) console.log(`    ${f}`);
    } else {
      // A known failure that passes is a fix nobody wrote down. Failing here is
      // what stops the annotation outliving the problem and quietly hiding a
      // real regression later.
      failed++;
      console.error(`✗ ${kase.id} — marked as a known failure but it passes now.`);
      console.error(`    Remove knownFailure: "${kase.knownFailure}"`);
    }
    continue;
  }

  if (fail.length) {
    failed++;
    console.error(`✗ ${kase.id} — "${kase.prompt}"`);
    for (const f of fail) console.error(`    ${f}`);
  } else {
    const shape = r.root
      ? `${r.statements} statements, ${r.queries.length} queries, ${r.tags.length} components`
      : 'prose only';
    console.log(`✓ ${kase.id} — ${shape}`);
  }
  for (const a of advisory) console.log(`    corrected: ${a}`);
  // Offline, nothing should reach the network or the stream. One of these
  // means the harness, not the generation.
  for (const t of runtime) console.log(`    runtime: ${t}`);
}

const known = cases.filter((c) => c.knownFailure).length;
const mode = offline ? 'replayed' : 'live';

// Recording captures; replaying judges. Generation is stochastic, so each
// record run samples the distribution afresh and will surface different
// things — failing the recipe on a sample turns that into whack-a-mole, and
// worse, it stops before you can look at what it just wrote. What it wrote is
// the point. The committed fixtures are what gate CI, through --offline.
if (record && failed) {
  console.error(`\neval: recorded ${cases.length}; ${failed} would fail as a baseline.`);
  console.error('Read them, then either fix the cause or re-record for a different sample.');
  console.error('CI judges the committed fixtures — run --offline before you commit.');
  process.exit(0);
}

if (failed) {
  console.error(`\neval: ${failed} of ${cases.length} failed (${mode}).`);
  process.exit(1);
}
console.log(
  `\neval: ${cases.length} generations (${mode}), catalog ${catalog.catalogVersion}`
  + (known ? ` — ${known} known failure(s), see knownFailure in CASES.` : ', all renderable.'),
);

}
