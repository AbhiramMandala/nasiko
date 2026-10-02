/** Token optimisation section: pure summary of the (proposed) savings payload, plus its sample. */
import type { OptimisationSummary } from './types'

// ponytail: sample payload until the savings endpoint exists; swap for a useQuery in api.ts then.
export const SAMPLE_OPTIMISATION: OptimisationSummary = {
  agents: [
    {
      agent_id: 'sample-1',
      agent_name: 'Support Bot',
      calls: 8214,
      input_tokens_before: 4_920_000,
      input_tokens_after: 3_710_000,
      est_cost_saved_usd: 91,
    },
    {
      agent_id: 'sample-2',
      agent_name: 'Research Agent',
      calls: 2903,
      input_tokens_before: 3_880_000,
      input_tokens_after: 3_240_000,
      est_cost_saved_usd: 53,
    },
    {
      agent_id: 'sample-3',
      agent_name: 'Code Reviewer',
      calls: 1477,
      input_tokens_before: 2_610_000,
      input_tokens_after: 2_240_000,
      est_cost_saved_usd: 38,
    },
    {
      agent_id: 'sample-4',
      agent_name: 'Doc Writer',
      calls: 960,
      input_tokens_before: 1_490_000,
      input_tokens_after: 1_300_000,
      est_cost_saved_usd: 17,
    },
  ],
  total_agents: 22,
  fleet_spend_usd: 4812,
  optimised_spend_usd: 1608,
  top_unoptimised: { agent_id: 'sample-5', agent_name: 'Sales Assistant', spend_usd: 1492 },
}

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0)

export function summarizeOptimisation(s: OptimisationSummary) {
  const rows = s.agents
    .map((a) => ({
      id: a.agent_id,
      name: a.agent_name,
      calls: a.calls,
      before: a.input_tokens_before,
      after: a.input_tokens_after,
      savedPct: pct(a.input_tokens_before - a.input_tokens_after, a.input_tokens_before),
      costSaved: a.est_cost_saved_usd,
    }))
    .sort((a, b) => b.savedPct - a.savedPct)
  const maxPct = rows[0]?.savedPct ?? 0
  const tokensBefore = rows.reduce((n, r) => n + r.before, 0)
  const tokensSaved = rows.reduce((n, r) => n + r.before - r.after, 0)
  const costSaved = rows.reduce((n, r) => n + r.costSaved, 0)
  return {
    rows: rows.map((r) => ({ ...r, barPct: pct(r.savedPct, maxPct) })),
    tokensBefore,
    tokensSaved,
    savedPct: pct(tokensSaved, tokensBefore),
    costSaved,
    /** Off what the optimised agents would have been billed without it. */
    costSavedPct: pct(costSaved, s.optimised_spend_usd + costSaved),
    optimisedCount: rows.length,
    totalAgents: s.total_agents,
    optimisedSharePct: pct(s.optimised_spend_usd, s.fleet_spend_usd),
    unoptimisedCount: Math.max(0, s.total_agents - rows.length),
    unoptimisedSpend: Math.max(0, s.fleet_spend_usd - s.optimised_spend_usd),
    unoptimisedSharePct: pct(s.fleet_spend_usd - s.optimised_spend_usd, s.fleet_spend_usd),
    topUnoptimised: s.top_unoptimised,
  }
}

export type OptimisationView = ReturnType<typeof summarizeOptimisation>
