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
 *   node ui/scripts/eval-generations.mjs --record --repair   # ...and measure the repair turn
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
const { repairableDiagnostics, buildRepairPrompt } = await import(new URL('../common/surface/repair.js', import.meta.url).href);
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
  // The composition case, and the one that has earned its keep. Every recording
  // of this prompt through three catalogs tried to nest a chart inside a card
  // and failed a different way — the chart into `name`, nineteen arguments at a
  // fifteen-argument card, the card and the chart as unconnected statements
  // with both orphaned. None of those was a model that could not compose; it
  // was a model reaching for a shape the grammar had no room for. app-card
  // leads with children now and this passes on the first recording after.
  { id: 'by-model-chart', prompt: 'Usage by model, with a chart',
    expect: { minQueries: 1, tags: ['app-chart'] } },
  // The case this suite did not have, and the gap that let a real complaint go
  // unmeasured. Every other prompt here names ONE thing — a table, a chart, a
  // toggle — so a model that reaches for the same shape every time still
  // passes them all. The dashboard that prompted the component and catalog
  // work was this request, and what was wrong with it was breadth: two line
  // charts side by side, answering a time question and a volume question with
  // the same mark, and nothing else.
  //
  // `minChartKinds: 2` is the assertion, and it is a floor rather than a
  // preference for any particular chart. Line for the trend and anything else
  // for the breakdown both pass; two lines do not. Both tokenops breakdown
  // sources (by agent, by model) are in scope, so the data for a second shape
  // is there to be asked for — this is not a case that can only be satisfied
  // by inventing something.
  //
  // Failing on arrival, and recorded as such rather than tuned until it
  // passes. The first recording answered "comprehensive" with ONE query
  // (fetchTokenopsDashboard) and two bar charts over the same x-axis — cost
  // by agent beside tokens by agent, from the same rows. That is one chart
  // drawn twice, and a dashboard that never looks at the time dimension at
  // all, which is what both assertions are for. The prompt rules added for
  // exactly this (13b on panels, 14b on picking a chart type) did not move it,
  // which is the finding: they are unproven, not proven.
  //
  // knownFailure rather than a looser expectation, because the mechanism
  // clears itself — a known failure that starts passing fails the run and
  // asks for the annotation to be removed, so whatever finally fixes this
  // cannot land unnoticed.
  { id: 'comprehensive', prompt: 'create a comprehensive tokenops dashboard with charts',
    knownFailure: 'answers breadth with one data source and one chart shape repeated',
    expect: { minQueries: 2, minComponents: 6, minChartKinds: 2 } },
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

/**
 * Every source the scope allows. Anything else must not survive to the client.
 *
 * Read from the generated manifest rather than kept by hand. The hand-kept
 * version listed five and went stale the day NAS-582 widened the scope to
 * seven, so a generation that correctly used fetchSpendTimeseries — a source
 * the manifest offers and the model was told about — failed the eval for
 * naming it. A checker that disagrees with the contract it is checking is
 * worse than no checker: it teaches you to distrust a red.
 */
const MANIFEST = JSON.parse(
  readFileSync(new URL('../common/surface/data-manifest.json', import.meta.url), 'utf8'),
);
export const ALLOWED_SOURCES = new Set(
  Object.values(MANIFEST.scopes ?? {}).flat().map((s) => (typeof s === 'string' ? s : s.name)),
);

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
  // Which SHAPES of chart, not how many charts. A dashboard answering three
  // different questions with three line plots has drawn one chart three
  // times: the reader learns nothing from the second that the first did not
  // already teach them to read. `type` is unset more often than not, and an
  // unset one is a line — the component's own default (app-chart.js:550).
  const chartKinds = new Set();
  if (container.children[0]) {
    walk(container.children[0], (el) => {
      tags.push(el.tag);
      if (el.tag === 'app-chart') chartKinds.add(el.attrs.type ?? 'line');
    });
  }

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
    chartKinds: [...chartKinds],
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
  if (e.minChartKinds && r.chartKinds.length < e.minChartKinds) {
    fail.push(`${r.chartKinds.length} kind(s) of chart (${r.chartKinds.join(', ') || 'none'}), `
      + `expected at least ${e.minChartKinds} — the same shape repeated answers one question twice`);
  }

  return { fail, advisory, runtime, r };
}

/**
 * Where generation is reached, and as whom.
 *
 * Weave is no longer a process this script talks to. It is a deployed agent —
 * a normal `agents` row with `is_internal = true`, seeded by the control plane
 * from WEAVE_AGENT_IMAGE — and `ee/server/src/weave_surface.rs` is the only
 * way in: it resolves that agent, speaks A2A `message/stream` to it, and
 * translates the frames back into the same SSE contract this script already
 * reads. So the wire format below is unchanged; only the host and the auth
 * moved.
 *
 * Which means the old shared secret is gone. `/api/weave/surface` is behind
 * `require_auth` like any other control-plane route, so this logs in as a real
 * user. A platform capability every logged-in user gets, not a resource with
 * its own key.
 */
const CP_BASE = process.env.NASIKO_CP_BASE_URL || 'http://localhost:8082';

let cachedToken = null;

/** A bearer token for the control plane, fetched once per run. */
async function login() {
  if (cachedToken) return cachedToken;
  const username = process.env.NASIKO_ADMIN_USERNAME;
  const password = process.env.NASIKO_ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error('NASIKO_ADMIN_USERNAME / NASIKO_ADMIN_PASSWORD are not set in this shell');
  }
  const res = await fetch(`${CP_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new Error(`login to ${CP_BASE} returned ${res.status} — are the admin credentials right?`);
  }
  cachedToken = (await res.json()).token;
  if (!cachedToken) throw new Error(`login to ${CP_BASE} returned no token`);
  return cachedToken;
}

/** Read one generation off the control plane, concatenating its dsl-chunks. */
async function generate(prompt, { currentSurface } = {}) {
  const base = CP_BASE;
  const token = await login();
  const res = await fetch(`${base}/api/weave/surface`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      prompt,
      context: {
        catalogVersion: catalog.catalogVersion,
        // A repair turn patches by statement name, which only works if the
        // generator can see what it is patching. The browser sends this on
        // every turn (surface-stream.js); without it here the model would
        // have to reproduce the whole dashboard to change one line.
        ...(currentSurface && { currentSurface }),
      },
    }),
  });
  // 503 is the route's own "no running agent by that name" — worth separating
  // from a transport failure, because the fix is a deployment, not a retry.
  if (res.status === 503) {
    throw new Error(
      'the control plane has no running weave agent — set WEAVE_AGENT_IMAGE in '
      + 'ee/server/.env and restart it, then check `docker ps` for the container it seeds');
  }
  if (res.status === 404) {
    throw new Error(
      `${base} has no /api/weave/surface route — that route is EE-only, so this `
      + 'has to be the EE server (`just run`), not the OSS one');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}/api/weave/surface`);

  let text = '';
  let generatorCatalog = null;
  // The stream says why it produced nothing, and this used to drop it on the
  // floor: everything that was not a dsl-chunk was skipped, so an agent that
  // failed outright reported as "answered with nothing at all" and the actual
  // message — an executor failure, a refused model call — never left the wire.
  const failures = [];
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
      if (event === 'fail') {
        try {
          const f = JSON.parse(data);
          failures.push(f.message ? `${f.code ?? 'fail'}: ${f.message}` : JSON.stringify(f));
        } catch { failures.push(data); }
        continue;
      }
      if (event !== 'dsl-chunk') continue;
      try { text += JSON.parse(data).text ?? ''; } catch { /* a truncated frame is the client's problem too */ }
    }
  }
  // A failure frame with no DSL behind it is the whole answer, so it is raised
  // rather than returned — the per-case "no root, 0 queries" lines underneath
  // describe the symptom and this is the cause.
  if (!text.trim() && failures.length) {
    throw new Error(`the generator failed — ${failures.join('; ')}`);
  }
  return { text, generatorCatalog, failures };
}

// ── main ────────────────────────────────────────────────────────────────────
// Guarded so the checker above can be imported and tested without a model, a
// network, or a process exit.

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!invokedDirectly) { /* imported for its checker */ } else {

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const record = args.includes('--record');
/**
 * Also measure the repair turn (common/surface/repair.js).
 *
 * Off by default because it doubles the requests on a run that is already
 * slow, and because the fixtures this records are FIRST-PASS output — that is
 * what the offline gate should keep judging. The repair number is reported
 * separately and answers a different question: not "is the model good", but
 * "when it is wrong, can it fix itself from what the renderer told it".
 *
 * Advisories are included here and excluded in the browser, deliberately. A
 * live user should not wait a round trip to tidy a pre-fetch placeholder;
 * an eval measuring whether the loop works should absolutely count them,
 * since default_is_whole_response is the single most common thing it has to
 * repair.
 */
const withRepair = args.includes('--repair');
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

// Credentials for the control plane, checked once rather than per case.
if (!offline && !(process.env.NASIKO_ADMIN_USERNAME && process.env.NASIKO_ADMIN_PASSWORD)) {
  console.error('eval: NASIKO_ADMIN_USERNAME / NASIKO_ADMIN_PASSWORD are not set in this shell.\n');
  console.error('  set -a && source ~/Documents/GitHub/Weave/.env && set +a\n');
  console.error('Generation goes through the control plane now, not straight at Weave:');
  console.error(`  ${process.env.NASIKO_CP_BASE_URL || 'http://localhost:8082'}/api/weave/surface`);
  console.error('so it needs a login, not the old WEAVE_INTERNAL_TOKEN. Weave itself is a');
  console.error('deployed agent the control plane seeds from WEAVE_AGENT_IMAGE — there is');
  console.error('nothing to start by hand.');
  process.exit(1);
}

/**
 * The agent has to be looking at THIS repo's catalog, not its bundled fallback.
 *
 * Checked before spending eleven model calls, because the failure is quiet at
 * both ends. Weave's catalog.py falls back to the copy inside the image when
 * WEAVE_CATALOG_URL will not resolve, and the agent runs in a container where
 * `localhost` is the container — so the control plane has to hand it a URL
 * that resolves from in there, and nothing says so when it doesn't.
 *
 * The per-case guard below compares catalog versions and catches this when
 * the bundled copy is stale. It cannot catch it when the bundle happens to be
 * current, which is exactly the state the bundle is in right after someone
 * syncs it — so the versions match, the run looks clean, and the generator
 * never once talked to this control plane. This checks reachability instead
 * of equality, which does not have that hole.
 */
async function checkCatalogReachable() {
  // Not this shell's variable any more — the control plane passes it to the
  // agent container it seeds (oss/server/src/seed.rs). Checked here anyway,
  // because what has to be true is the same: something is serving this
  // catalog, at a URL the agent can resolve.
  const url = process.env.WEAVE_CATALOG_URL
    || `${CP_BASE}/common/surface/dsl-catalog.json`;
  // Fetched from here, not from inside Weave — so this proves the URL serves a
  // catalog, not that Weave can reach it. A host.docker.internal URL is not
  // resolvable from this process at all, which is the common and correct case;
  // it is reported rather than failed.
  let hostUrl = url;
  let viaDockerHost = false;
  if (url.includes('host.docker.internal')) {
    hostUrl = url.replace('host.docker.internal', 'localhost');
    viaDockerHost = true;
  }
  try {
    const res = await fetch(hostUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const served = (await res.json()).catalogVersion;
    if (served !== catalog.catalogVersion) {
      console.error(`eval: ${hostUrl} serves catalog ${served}, this checkout has ${catalog.catalogVersion}.`);
      console.error('The control plane is running an older build of this repo — restart it.');
      process.exit(1);
    }
    console.log(`eval: catalog ${served} served at ${hostUrl}${viaDockerHost ? ' (the agent reaches it as host.docker.internal)' : ''}`);
  } catch (err) {
    console.error(`eval: the catalog at ${url} did not answer — ${err.message}.\n`);
    console.error('Start the control plane with `just run`. It binds CP_BIND from');
    console.error('ee/server/.env, and both this check and the seeded agent read from it,');
    console.error('so the port there is the one that has to be right.');
    if (viaDockerHost) {
      console.error(`\n(Tried ${hostUrl} from here — host.docker.internal only resolves`);
      console.error('inside the container, which is where it has to work.)');
    }
    process.exit(1);
  }
}

if (!offline) await checkCatalogReachable();

/** Cases whose recording was refused because the generator answered nothing. */
const skipped = [];
let failed = 0;
/** What the repair turn did, when --repair asked for one. */
const repairs = { offered: 0, cleared: 0, improved: 0, noBetter: 0, before: 0, after: 0 };
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
  // An empty answer is never a recording worth keeping. It means the generator
  // could not answer — no model credential, no skill registered, a refused
  // connection — and none of those are a sample of anything. Writing it
  // destroys a good fixture and replaces it with a file that then fails the
  // offline run for a reason that has nothing to do with the generation.
  //
  // Learned the hard way: a blank AWS_BEARER_TOKEN_BEDROCK in .env.docker
  // emptied all eleven in one command, including the prose-only cases that
  // touch neither the catalog nor the DSL.
  if (record) {
    if (text.trim()) writeFileSync(path, text);
    else skipped.push(kase.id);
  }

  const { fail, advisory, runtime, r } = check(kase, text);

  // ── The repair turn, measured ───────────────────────────────────────────
  // Hand the renderer's own diagnostics back and see whether the generator
  // can fix them. Deliberately AFTER the fixture is written, so what the
  // offline gate keeps judging is first-pass output — this measures recovery,
  // which is a different number and must not be allowed to flatter the first.
  if (withRepair && !offline && r.root) {
    const before = repairableDiagnostics(r.diagnostics, SEVERITY, { includeAdvisory: true });
    if (before.length) {
      repairs.offered++;
      repairs.before += before.length;
      try {
        const patch = await generate(buildRepairPrompt(before), { currentSurface: text });
        // The same seeding the runtime does: the delta overwrites by name, so
        // the prior surface has to be underneath it or `root` goes missing.
        const merged = `${text}\n${patch.text}`;
        const after = repairableDiagnostics(
          evaluateGeneration(merged).diagnostics, SEVERITY, { includeAdvisory: true });
        repairs.after += after.length;
        if (!after.length) { repairs.cleared++; console.log(`    repair: ${before.length} → 0`); }
        else if (after.length < before.length) { repairs.improved++; console.log(`    repair: ${before.length} → ${after.length}`); }
        else { repairs.noBetter++; console.log(`    repair: ${before.length} → ${after.length}, no better`); }
      } catch (err) {
        repairs.after += before.length;
        repairs.noBetter++;
        console.log(`    repair: failed — ${err.message}`);
      }
    }
  }

  if (kase.knownFailure) {
    if (fail.length) {
      console.log(`~ ${kase.id} — known failure: ${kase.knownFailure}`);
      for (const f of fail) console.log(`    ${f}`);
      // Printed here as well as below, because `continue` skips the tail. A
      // known-failing case was the one place an advisory was collected and
      // then thrown away — and it is the case most likely to be carrying a
      // second, unrelated mistake nobody has looked at yet.
      for (const a of advisory) console.log(`    corrected: ${a}`);
      for (const t of runtime) console.log(`    runtime: ${t}`);
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

// The one number that says whether handing diagnostics back is worth the
// round trip. Printed before the pass/fail line because it is about a
// different thing: not how good the first draft was, but how much of its own
// mess the generator can clear once it is told.
if (withRepair && !offline) {
  if (!repairs.offered) {
    console.log('\nrepair: nothing to repair — no generation carried a fixable diagnostic.');
  } else {
    console.log(`\nrepair: ${repairs.offered}/${cases.length} generations needed one; `
      + `${repairs.cleared} fully cleared, ${repairs.improved} improved, ${repairs.noBetter} no better.`);
    console.log(`        ${repairs.before} fixable diagnostics → ${repairs.after} `
      + `(${Math.round((1 - repairs.after / repairs.before) * 100)}% cleared in one turn).`);
    if (repairs.noBetter > repairs.cleared + repairs.improved) {
      console.log('        More turns wasted than helped. In the browser those roll back, so');
      console.log('        the cost is latency rather than a worse dashboard — but at this rate');
      console.log('        the repair prompt is the thing to look at, not the round count.');
    }
  }
}

// Recording captures; replaying judges. Generation is stochastic, so each
// record run samples the distribution afresh and will surface different
// things — failing the recipe on a sample turns that into whack-a-mole, and
// worse, it stops before you can look at what it just wrote. What it wrote is
// the point. The committed fixtures are what gate CI, through --offline.
// Every case answering nothing is not a bad sample, it is a broken setup —
// the generator is not generating. Said separately and first, because the
// per-case failures underneath all read as "the model wrote nothing useful"
// and none of them names the actual cause.
if (record && skipped.length === cases.length) {
  console.error(`\neval: all ${cases.length} came back empty — nothing was recorded, your fixtures are untouched.`);
  console.error('The generator answered nothing at all, including the prose-only cases, which');
  console.error('touch neither the catalog nor the DSL. That is a setup problem, not a model one.\n');
  console.error('Weave runs as an agent the control plane deploys, so its environment comes');
  console.error('from ee/server/.env by way of oss/server/src/seed.rs — not from any file in');
  console.error('the Weave repo. Check, in this order:\n');
  console.error('  1. docker logs $(docker ps -qf name=weave) — the agent says why on the');
  console.error('     first request, and it is usually a model credential.');
  console.error('  2. AWS_BEARER_TOKEN_BEDROCK in ee/server/.env — the seed forwards it,');
  console.error('     so a stale or rotated key here is silence there.');
  console.error('  3. WEAVE_FORCE_PULL=1 then restart, if the env changed since the agent');
  console.error('     was last deployed — a running container keeps the env it started with.');
  process.exit(1);
}

if (record && skipped.length) {
  console.error(`\neval: ${skipped.length} answered nothing and were NOT recorded — ${skipped.join(', ')}.`);
  console.error('Those fixtures keep whatever they had. Re-run them once the cause is fixed.');
}

if (record && failed) {
  console.error(`\neval: recorded ${cases.length - skipped.length}; ${failed} would fail as a baseline.`);
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
