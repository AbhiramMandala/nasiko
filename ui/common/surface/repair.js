/**
 * Handing the runtime's diagnostics back to the generator.
 *
 * ## Why this exists
 *
 * The renderer already knows, precisely and in machine-readable form, most of
 * what is wrong with a generated surface: which statement, which component,
 * which attribute, and what the correct shape would have been. All 52 codes
 * carry that. And until now every one of them went to a red box that a person
 * reads — the one participant in the loop who cannot fix the DSL.
 *
 * The model can. So this turns the observation into an action: after a turn
 * that rendered something broken, the diagnostics go back as a second,
 * automatic turn, and the model repairs its own output before the person is
 * asked to care. Observe, then act, on the runtime's evidence rather than on
 * the model's memory of what it meant to write.
 *
 * ## Why it is cheap here specifically
 *
 * This is not "generate the dashboard again and hope". The DSL is patchable by
 * name — rule 8, same name overwrites — and the previous surface is already
 * sent as context on every turn. So a repair is one or two lines:
 *
 *     tabs = AppTabs([costPanel, opsPanel], false, [...], "cost", null, "Views")
 *
 * not a new dashboard. One short round trip, a handful of output tokens, and
 * the statement is replaced in place. That property is what makes an automatic
 * repair affordable at all; without it this would be a retry loop, which is a
 * different and much worse thing.
 *
 * ## Why not just improve the prompt
 *
 * The prompt is 474 lines and 19 numbered rules, and rule 10 already says, in
 * bold, that every operable component needs a name. The surface that prompted
 * this module shipped an unnamed `AppTabs` anyway. Past a certain length each
 * new rule competes with the others for attention rather than adding to them,
 * and the failures being legislated against are a long tail — there is always
 * a next one. A rule is a prediction about what the model will get wrong. This
 * is a measurement of what it actually got wrong, which is strictly better
 * information and does not cost anything until something is already broken.
 *
 * The prompt still matters for everything the runtime cannot see — whether a
 * donut was the right chart, whether the heading says what the data is. That
 * is the division: teach judgement, detect mechanics.
 *
 * ## What this module is and is not
 *
 * Pure. It decides *whether* a repair is worth asking for and *what to say*;
 * it does not send anything. The loop — how many rounds, when to stop, what to
 * do if the repair is worse — lives in surface-stream.js, and the eval harness
 * drives these same two functions down its own path. Keeping the prompt text
 * out of the transport is what lets a test assert on it.
 */

/** Nothing below this is worth a round trip. */
const MIN_TO_REPAIR = 1;

/**
 * How many problems to name in one repair turn.
 *
 * A surface with thirty diagnostics is not a surface with thirty small
 * mistakes; it is usually one wrong idea reported thirty times (a Query
 * default of the wrong shape, read by every component on the page). Listing
 * all of them buries the pattern and invites the model to patch thirty call
 * sites instead of the one line that produced them. Twelve is enough for the
 * shape to be visible and short enough to stay an instruction.
 */
const MAX_LISTED = 12;

/**
 * The diagnostics from one turn that a repair turn could actually fix.
 *
 * @param {Array<{code?: string, severity?: string, message?: string, pointer?: string}>} diagnostics
 * @param {object|null} table the `diagnostics` map out of diagnostics.json —
 *   what `catalog-load.js#severities()` returns. Null before it has loaded, in
 *   which case nothing is repairable: a repair turn built on a guess about
 *   which codes mean what is worse than no repair turn.
 * @param {{includeAdvisory?: boolean}} [opts]
 * @returns {Array<object>} in report order, deduplicated by statement+code+message
 */
export function repairableDiagnostics(diagnostics, table, { includeAdvisory = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const d of diagnostics || []) {
    const entry = table?.[d?.code];
    // An unknown code is not repaired. A code this build has never heard of
    // comes from a runtime that is not this one, and guessing that the model
    // can fix it is how a repair loop starts talking to itself.
    if (!entry?.repairable) continue;
    if (entry.severity === 'advisory' && !includeAdvisory) continue;
    const key = `${d.pointer ?? ''}|${d.code}|${d.message ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * The repair turn's prompt, or null when there is nothing worth asking for.
 *
 * Written as an instruction to the generator, not as a report to a person: it
 * names the statements, states the remedy the runtime already worked out, and
 * says explicitly what NOT to do. The three prohibitions are all mistakes a
 * revision turn makes by default — re-emitting `root` when the component set
 * has not changed (which drops anything the old root reached and the new one
 * forgets), rebuilding the whole dashboard, and wrapping the answer in the
 * intro/summary sentences rule 19 asks for on a real turn. None of those are
 * wanted here: nobody typed this prompt and nobody is going to read the reply.
 *
 * @param {Array<{code?: string, message?: string, pointer?: string}>} diagnostics
 *   already filtered by {@link repairableDiagnostics}
 * @returns {string|null}
 */
export function buildRepairPrompt(diagnostics) {
  const items = diagnostics || [];
  if (items.length < MIN_TO_REPAIR) return null;

  const listed = items.slice(0, MAX_LISTED);
  const lines = listed.map((d) => {
    const where = d.pointer ? `\`${d.pointer}\`` : 'an unnamed statement';
    return `- ${where}: ${d.message ?? d.code}`;
  });
  const elided = items.length - listed.length;

  return [
    'The surface you just produced was rendered, and the runtime found '
      + `${items.length === 1 ? 'a problem' : `${items.length} problems`} with it. `
      + 'Each line below names the statement and what is wrong with it.',
    '',
    ...lines,
    ...(elided
      ? ['', `(and ${elided} more of the same kinds — if they share one cause, `
          + 'fix the cause rather than each place it surfaced)']
      : []),
    '',
    'Re-emit ONLY the statements named, with the SAME names, so each one '
      + 'replaces the version already on the page. Do not rebuild the dashboard. '
      + 'Do not re-emit `root` unless a fix changes which components are on the '
      + 'page. Do not write an opening or closing sentence for this turn — no '
      + 'one asked for it and no one is reading it. Output the corrected '
      + 'statements and nothing else.',
  ].join('\n');
}
