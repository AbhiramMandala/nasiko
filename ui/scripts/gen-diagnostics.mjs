#!/usr/bin/env node
/**
 * Generate `ui/common/surface/diagnostics.json` — every diagnostic code the
 * surface runtime can emit, and how seriously to take it.
 *
 * Why this exists. The runtime emits ~45 codes from six modules and nothing
 * enumerated them. The only place severity lived was a three-entry literal in
 * eval-generations.mjs, so every other code failed an eval case by omission
 * rather than by decision — and two of those three entries were added
 * *reactively*, after a new code turned a correct surface red and someone had
 * to work out by hand whether the dashboard was actually broken. That is the
 * bad direction to fail in: it costs the eval its credibility exactly when it
 * should be trusted.
 *
 * So the map below is required, not defaulted. A code with no entry fails
 * generation, and an entry naming a code that no longer exists fails too —
 * the same fail-on-unexpected-pass idea the eval's knownFailure annotations
 * use, applied to the vocabulary instead of the cases.
 *
 * Usage: node ui/scripts/gen-diagnostics.mjs [--check]
 *   --check  exit 1 if diagnostics.json is out of date, without writing (CI)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SURFACE = resolve(UI, 'common/surface');
const OUT = resolve(SURFACE, 'diagnostics.json');

/** Modules outside common/surface/ that also emit into the same channel. */
const EXTRA = [resolve(UI, 'common/features/weave-surface/weave-surface.js')];

/**
 * The three things a diagnostic can mean. The binary the eval used before
 * collapsed the last two, which is why a failed upstream fetch and a malformed
 * Action read the same to it.
 *
 *   fatal     the generation is wrong. Something the model asked for is not on
 *             the page, or is on it wrongly. An eval case carrying one fails.
 *   advisory  the model wrote something odd and the runtime corrected it. The
 *             surface is right; the mistake is still worth fixing upstream, so
 *             it is reported and never fails a case.
 *   runtime   nothing to do with the generation — a data source that failed, a
 *             dropped stream, a host that wired no navigator, a user
 *             double-clicking. Shown to the user, never a verdict on the DSL.
 */
const SEVERITY = {
  // ── materialize.js ────────────────────────────────────────────────────────
  cycle: ['fatal', 'the statement resolves to null, so the component is absent'],
  bad_each: ['fatal', '@Each yields [] — the whole repeated section is missing'],
  unknown_builtin: ['fatal', 'the statement drops'],
  unknown_component_type: ['fatal', 'nothing is rendered for it'],
  excess_arguments: ['fatal', 'a non-null argument the model meant is discarded'],
  excess_null_padding: ['advisory', 'the extras are all null — nothing was lost, only written'],
  bad_query: ['fatal', 'no data reaches the component'],
  bad_mutation: ['fatal', 'the mutation can never fire'],
  bad_action_step: ['fatal', 'that step never runs'],
  bad_slot: ['fatal', 'the child is lost'],
  root_not_a_component: ['fatal', 'nothing renders at all'],
  orphaned_statement: ['fatal', 'the model built something and never put it on the page'],
  uncontrolled_input: ['fatal', 'the box empties as the user types — its Action repaints and its value is not read back from state'],
  default_is_whole_response: ['advisory', 'the pre-fetch placeholder is the wrong shape; the real value arrives correct'],
  default_misses_a_read_field: ['advisory', 'the field is blank until the fetch lands, and stays blank if it returns nothing'],

  // ── render.js ─────────────────────────────────────────────────────────────
  component_threw: ['fatal', "the component's own code failed mid-render"],
  denied_attribute: ['fatal', 'a surface may never set style/class/id — the prompt should have prevented it'],
  unknown_attribute: ['fatal', 'the value is dropped, so what it was for is missing'],
  component_as_attribute: ['fatal', 'a whole subtree went into a string slot and is gone from the page'],
  enum_violation: ['fatal', 'falls back to the default, which is not the value asked for'],
  template_not_allowed: ['fatal', 'the grid reflows responsively instead of holding the ratio intended'],
  non_route_value: ['advisory', 'an argument one position out of step; the slot ends up unset either way'],
  route_not_allowed: ['fatal', 'a link that goes nowhere'],
  no_data_property: ['fatal', 'a catalog inconsistency, not a generation one — and it breaks every use of that component'],
  data_not_rows: ['fatal', 'the component renders blank'],
  value_in_the_wrong_slot: ['fatal', 'a boolean landed in a text slot, so the component shows the word "true" or "false"'],
  missing_accessible_name: ['fatal', 'the renderer refuses the control outright'],
  unknown_slot: ['fatal', 'the child lands nowhere'],
  children_have_nowhere_to_land: ['fatal', 'the child is dropped when the parent renders — it has no default slot'],

  // ── repair.js / surface-stream.js ─────────────────────────────────────────
  // The loop narrating itself. `runtime` on all three, and that is the whole
  // classification argument: none of them is a verdict on the DSL. The
  // diagnostics that ARE the verdict were already reported by the turn that
  // produced them, and counting the machine's response to them a second time
  // would double every fault in the telemetry.
  //
  // Reported at all — rather than kept quiet — because this spends a round
  // trip nobody asked for and changes what is on screen. Something that acts
  // on its own says so.
  repair_started: ['runtime', 'the runtime is handing the last turn back to the generator to patch'],
  repair_applied: ['runtime', 'the generator patched its own output; the diagnostics above are the pre-repair set'],
  repair_no_better: ['runtime', 'the repair did not reduce the fault count, so the pre-repair surface was restored'],

  // ── queries.js ────────────────────────────────────────────────────────────
  arg_enum_violation: ['fatal', 'the argument is not a value that source accepts, so the data never arrives'],
  query_failed: ['runtime', 'the data source failed; the DSL naming it is fine'],
  mutation_failed: ['runtime', 'the upstream call failed'],
  mutation_in_flight: ['runtime', 'a repeat while one is running — someone clicked twice'],

  // ── actions.js ────────────────────────────────────────────────────────────
  action_in_flight: ['runtime', 'a repeat while one is running'],
  bad_set: ['fatal', '@Set has no target, so the filter never moves'],
  bad_reset: ['fatal', '@Reset names nothing'],
  bad_run: ['fatal', '@Run names nothing'],
  bad_to_assistant: ['fatal', '@ToAssistant has no message'],
  action_halted: ['runtime', 'the consequence of an upstream failure, not of the DSL'],
  run_unknown: ['fatal', '@Run points at a statement that is not a Query or Mutation'],
  no_navigator: ['runtime', 'the route is allowed; this host wired no navigator'],
  unknown_step: ['fatal', 'not an Action step at all'],

  // ── surface-stream.js ─────────────────────────────────────────────────────
  // All transport and environment. None of these is a statement about the DSL,
  // and every one of them can happen to a perfect generation.
  paint_failed: ['runtime', 'our own render pass threw'],
  catalog_version_mismatch: ['runtime', 'the generator and this client are on different catalogs'],
  catalog_version_unverifiable: ['runtime', 'the stream carried no catalog version to check'],
  weave_direct: ['runtime', 'talking to Weave directly rather than through the control plane'],
  http_error: ['runtime', 'the upstream returned a non-2xx'],
  not_an_event_stream: ['runtime', 'the response was not text/event-stream'],
  stream_interrupted: ['runtime', 'the connection dropped mid-surface'],
  stream_resumed: ['runtime', 'reconnected from Last-Event-ID'],
  stream_restarted: ['runtime', 'reconnected without replay, so the surface restarts'],
  unknown_frame: ['runtime', 'an SSE event this client does not know'],
  malformed_frame: ['runtime', 'a frame carried unparseable JSON'],

  // ── weave-surface.js (source: host) ───────────────────────────────────────
  request_failed: ['runtime', 'the request never left, or threw before any frame'],
};

/**
 * Every diagnostic code literal in one file, with the `source` it is emitted
 * under. Two shapes exist and both are matched rather than normalised, because
 * normalising the call sites first would be a bigger diff than this script:
 *
 *   report('code', …) / note('code', …) / diag('code', …)   the helper form
 *   { source: 'x', code: 'code', … }                        the inline form
 *
 * Regex rather than a parser. The alternative is a JS parser dependency in a
 * repo with no build step, to read literals that are always written flat.
 * A code assembled from a variable would be missed — nothing does that today,
 * and the required-entry check below would catch it the moment something did,
 * because the code would show up unclassified in the eval instead.
 */
function scan(path, text) {
  const found = new Map();
  const sources = [...text.matchAll(/source:\s*'([a-z]+)'/g)].map((m) => m[1]);
  for (const m of text.matchAll(/\b(?:report|note|diag)\(\s*'([a-z_]+)'/g)) {
    found.set(m[1], sources[0] ?? null);
  }
  // The inline form carries its own source, usually on the line above.
  for (const m of text.matchAll(/source:\s*'([a-z]+)',\s*\n?\s*code:\s*'([a-z_]+)'/g)) {
    found.set(m[2], m[1]);
  }
  for (const m of text.matchAll(/\bcode:\s*'([a-z_]+)'/g)) {
    if (!found.has(m[1])) found.set(m[1], sources[0] ?? null);
  }
  return [...found].map(([code, source]) => ({ code, source, module: path }));
}

const files = [
  ...readdirSync(SURFACE).filter((f) => f.endsWith('.js')).sort().map((f) => resolve(SURFACE, f)),
  ...EXTRA,
];

// A code emitted from two modules carries a different `source` from each —
// route_not_allowed is `render` from the renderer and `actions` from @OpenUrl,
// and a consumer filtering on source needs both, not whichever was scanned
// first. So the pairing is what is recorded.
/** @type {Map<string, {module: string, source: string|null}[]>} */
const codes = new Map();
for (const file of files) {
  const rel = file.slice(UI.length + 1);
  for (const { code, source, module } of scan(rel, readFileSync(file, 'utf8'))) {
    const emitters = codes.get(code) ?? [];
    if (!emitters.some((e) => e.module === module)) emitters.push({ module, source });
    codes.set(code, emitters);
  }
}

// Both directions. An unclassified code is the failure this script exists to
// prevent; a stale entry is the annotation outliving the problem, which is how
// a classification quietly starts hiding a real regression.
const problems = [];
for (const code of codes.keys()) {
  if (!SEVERITY[code]) {
    problems.push(`${code} is emitted by ${codes.get(code).map((e) => e.module).join(', ')} but has no severity.`);
  }
}
for (const code of Object.keys(SEVERITY)) {
  if (!codes.has(code)) problems.push(`${code} has a severity but nothing emits it any more.`);
}
for (const [code, entry] of Object.entries(SEVERITY)) {
  if (!['fatal', 'advisory', 'runtime'].includes(entry[0])) {
    problems.push(`${code}: "${entry[0]}" is not fatal | advisory | runtime.`);
  }
}
if (problems.length) {
  console.error('gen-diagnostics: the severity map and the code do not agree.\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nEvery code needs a decision. Edit SEVERITY in ui/scripts/gen-diagnostics.mjs.');
  process.exit(1);
}

/**
 * Fatal codes the model cannot act on, and why.
 *
 * The surface runtime can hand its diagnostics back to the generator as a
 * repair turn (common/surface/repair.js): the DSL is patchable by statement
 * name, so fixing one is a line or two rather than a new dashboard. That only
 * works for a mistake the model made and can see. The rest are ours.
 *
 * Listed as exceptions rather than opted into one by one, because the default
 * is the safe direction: a fatal means the model wrote something wrong, and a
 * new code that turns out not to be repairable costs one wasted turn, while a
 * repairable one left off an allowlist stays broken forever. Every key is
 * still checked against a real fatal code below, so this cannot rot.
 */
const NOT_REPAIRABLE = {
  component_threw: "the component's own code threw — the message is a JS stack, not something a DSL edit addresses",
  no_data_property: 'a catalog inconsistency; the DSL naming the component is correct',
};

const diagnostics = {};
for (const code of [...codes.keys()].sort()) {
  const [severity, why] = SEVERITY[code];
  diagnostics[code] = {
    severity,
    why,
    // Only a fatal or an advisory says anything about the DSL at all.
    ...(severity !== 'runtime' && !NOT_REPAIRABLE[code] && { repairable: true }),
    ...(NOT_REPAIRABLE[code] && { notRepairable: NOT_REPAIRABLE[code] }),
    emitters: codes.get(code),
  };
}

for (const code of Object.keys(NOT_REPAIRABLE)) {
  if (!codes.has(code)) {
    console.error(`gen-diagnostics: NOT_REPAIRABLE names "${code}", which nothing emits.`);
    process.exit(1);
  }
  if (SEVERITY[code][0] === 'runtime') {
    console.error(`gen-diagnostics: NOT_REPAIRABLE names "${code}", which is runtime — no repair was ever offered.`);
    process.exit(1);
  }
}

const counts = { fatal: 0, advisory: 0, runtime: 0, repairable: 0 };
for (const d of Object.values(diagnostics)) {
  counts[d.severity]++;
  if (d.repairable) counts.repairable++;
}

const payload = {
  _generated: 'by ui/scripts/gen-diagnostics.mjs from ui/common/surface/*.js — do not hand-edit',
  contract: [
    'Every diagnostic the surface runtime can emit. `fatal` means the generation',
    'is wrong and an eval case carrying one fails; `advisory` means the runtime',
    'corrected a real mistake and the surface is still right; `runtime` means the',
    'event says nothing about the DSL at all. A new code with no entry in this',
    "script's SEVERITY map fails generation rather than defaulting to anything.",
    '`repairable` means the runtime can hand this one back to the generator as a',
    'repair turn — see common/surface/repair.js.',
  ].join(' '),
  counts,
  diagnostics,
};

const next = `${JSON.stringify(payload, null, 2)}\n`;
const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
const summary = `${Object.keys(diagnostics).length} codes — `
  + `${counts.fatal} fatal, ${counts.advisory} advisory, ${counts.runtime} runtime`
  + `, ${counts.repairable} repairable`;

if (process.argv.includes('--check')) {
  if (current !== next) {
    console.error('gen-diagnostics: common/surface/diagnostics.json is out of date.');
    console.error('A diagnostic was added, removed or reclassified without regenerating.');
    console.error('Run: node ui/scripts/gen-diagnostics.mjs');
    process.exit(1);
  }
  console.log(`gen-diagnostics: diagnostics.json up to date (${summary})`);
} else {
  writeFileSync(OUT, next);
  console.log(`gen-diagnostics: wrote diagnostics.json — ${summary}`);
}
