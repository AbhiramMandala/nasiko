/**
 * One panel per harness (plan §6, G2): name → active / registered + adoption bar → idle →
 * Est. cost · per active dev · per session · sessions → Δ → top model. Only the name row is
 * the harness-filter toggle (shadcn `Toggle`, aria-pressed); the card is a container, so the term
 * tooltips are never nested inside a button.
 */
import { Check, Filter } from 'lucide-react'
import { m } from 'motion/react'
import type { CSSProperties } from 'react'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Toggle } from '@/components/ui/toggle'
import { POLARITY } from '@/lib/delta'
import { fmtInt } from '@/lib/format'
import { Delta } from '@/components/shared/delta'
import { cn } from '@/lib/utils'
import { copy } from '../copy'
import { costPerActiveDev, costPerSession, costView, harnessStyle } from '../rollup'
import type { HarnessTotals } from '../types'
import { CostFigure, HarnessLabel, Ratio, Term } from './bits'

export interface PanelItem {
  harness: string
  totals: HarnessTotals
  topModel?: string
}

export function HarnessPanels({
  items,
  selected,
  onToggle,
  compare,
  prevUnavailable,
  perHarnessUnpricedKnown = true,
  sessionsKnown = true,
  showTopModel = true,
  loading,
}: {
  items: PanelItem[]
  selected?: string
  onToggle: (harness: string) => void
  compare: boolean
  prevUnavailable?: boolean
  /** False in the live fallback: per-harness unpriced counts don't exist there (N9). */
  perHarnessUnpricedKnown?: boolean
  /** False in the live fallback: the own-only session list is capped, not windowed, so no count. */
  sessionsKnown?: boolean
  showTopModel?: boolean
  loading?: boolean
}) {
  if (loading) {
    return (
      <div
        aria-busy="true"
        className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]"
      >
        <span className="sr-only">Loading harnesses</span>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-40 w-full rounded-lg" />
        ))}
      </div>
    )
  }
  return (
    // Columns follow the card count: five harnesses share one row on wide screens, one column on
    // phones, and one or two cards never stretch past a third of the row (QA ISSUE-001).
    <section
      aria-label="Harnesses"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(var(--lg-cols),minmax(0,1fr))] xl:grid-cols-[repeat(var(--xl-cols),minmax(0,1fr))]"
      style={
        {
          '--lg-cols': Math.min(Math.max(items.length, 3), 4),
          '--xl-cols': Math.max(items.length, 3),
        } as CSSProperties
      }
    >
      {items.map((it, i) => {
        const t = it.totals
        const s = harnessStyle(it.harness)
        const pressed = selected === it.harness
        const adoptionPct =
          t.registered_devs > 0 ? Math.min(100, (t.active_devs / t.registered_devs) * 100) : 0
        const view = costView(t, perHarnessUnpricedKnown)
        const priced = view.kind === 'value'
        return (
          <m.div
            key={it.harness}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: i * 0.03 }}
          >
            {/* The card is a container; only the name row is the filter toggle, so the focusable
                term tooltips below are never nested inside a button. */}
            <Card
              className={cn(
                'h-full min-h-44 w-full gap-2 rounded-lg p-3 text-left text-sm shadow-none transition-colors',
                pressed ? 'border-foreground/50 ring-1 ring-foreground/20' : 'border-border',
              )}
            >
              <Toggle
                pressed={pressed}
                aria-label={`Filter by ${s.known ? s.name : `${s.name} (${it.harness})`}`}
                onPressedChange={() => onToggle(it.harness)}
                className="-m-1 h-auto min-h-8 justify-between p-1 text-left text-foreground hover:bg-muted/60 hover:text-foreground data-[state=on]:bg-transparent data-[state=on]:text-foreground max-sm:min-h-11"
              >
                <HarnessLabel id={it.harness} className="font-medium" />
                {pressed ? (
                  <Check className="size-4 text-foreground" aria-hidden />
                ) : (
                  <Filter className="size-3.5 text-muted-foreground" aria-hidden />
                )}
              </Toggle>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-2xl font-semibold tabular-nums">
                  {fmtInt(t.active_devs)}{' '}
                  <span className="text-base font-normal text-muted-foreground">
                    / {fmtInt(t.registered_devs)}
                  </span>
                </span>
                {t.idle_seats > 0 ? (
                  <span className="text-sm font-medium text-warning tabular-nums">
                    {fmtInt(t.idle_seats)} {copy.idle}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-col gap-1">
                <Progress
                  aria-hidden
                  value={adoptionPct}
                  className="h-1.5 bg-muted [&>[data-slot=progress-indicator]]:rounded-full [&>[data-slot=progress-indicator]]:bg-(--bar)"
                  style={{ '--bar': s.edge } as CSSProperties}
                />
                <span className="text-xs text-muted-foreground">
                  active / <Term tip={copy.registeredTip}>{copy.registered.toLowerCase()}</Term>
                </span>
              </div>
              <dl className="mt-auto grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border pt-2 text-xs">
                <div>
                  <dt className="text-muted-foreground">
                    <Term tip={copy.estCostTip}>{copy.estCost}</Term>
                  </dt>
                  <dd className="font-medium">
                    <CostFigure view={view} />
                  </dd>
                </div>
                {/* Ratios follow the total: a mostly-unpriced cost has no meaningful per-dev figure. */}
                <div>
                  <dt className="text-muted-foreground">per active dev</dt>
                  <dd>
                    <Ratio value={priced ? costPerActiveDev(t) : null} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">per session</dt>
                  <dd>
                    <Ratio value={priced && sessionsKnown ? costPerSession(t) : null} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">sessions</dt>
                  <dd className="tabular-nums">
                    {sessionsKnown ? (
                      fmtInt(t.sessions)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </dd>
                </div>
              </dl>
              <div className="flex items-center justify-between gap-2 text-xs">
                {compare ? (
                  prevUnavailable ? (
                    <span className="text-muted-foreground">{copy.deltaUnavailable}</span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      turns{' '}
                      <Delta
                        changePct={t.delta_pct}
                        polarity={POLARITY.operations}
                        current={t.turns}
                      />
                    </span>
                  )
                ) : (
                  <span />
                )}
                {showTopModel && it.topModel ? (
                  <span
                    className="truncate text-muted-foreground"
                    title={`Top model: ${it.topModel}`}
                  >
                    {it.topModel}
                  </span>
                ) : null}
              </div>
              {/* The line's space is kept on every card (invisible when empty) so the metrics above line up across the row. */}
              {perHarnessUnpricedKnown ? (
                <span
                  className={cn(
                    'text-xs text-muted-foreground',
                    !(t.unpriced_calls > 0 && priced) && 'invisible',
                  )}
                  aria-hidden={!(t.unpriced_calls > 0 && priced) || undefined}
                >
                  {copy.unpricedCount(t.unpriced_calls)}
                </span>
              ) : null}
            </Card>
          </m.div>
        )
      })}
    </section>
  )
}
