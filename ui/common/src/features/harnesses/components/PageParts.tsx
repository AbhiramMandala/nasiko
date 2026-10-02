/**
 * The Harnesses page's building blocks (plan §6), shared by the OSS page and the EE layer's org page: the header, the
 * summary, the Individual level in its full form (usage endpoint) and its degraded form (live fallback).
 */
import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Toggle } from '@/components/ui/toggle'
import { harnessNarrative } from '@/features/narrative/harness'
import type { ResolvedWindow } from '@/features/tokenops/window'
import { PageHeader } from '@/components/shared/page-header'
import { Panel } from '@/components/shared/panel'
import { StateCard } from '@/components/shared/state-card'
import { TimeControl } from '@/components/shared/time-control'
import { copy } from '../copy'
import { LIVE_SESSION_LIMIT, RECENT_SESSIONS_SHOWN } from '../constants'
import { panelItems, preview, serverOrigin, type SetSearch } from '../level'
import type { LiveIndividual } from '../liveIndividual'
import { unconnectedHarnesses } from '../rollup'
import type { HarnessesSearch } from '../search'
import type { HarnessTotals, UsageResponse } from '../types'
import { Crumbs, type Crumb } from './Crumbs'
import { HarnessPanels, type PanelItem } from './HarnessPanels'
import { ActivityStrip, ConnectPanel, SessionsList, TopModels } from './IndividualView'
import { Trend } from './Trend'

export function Summary({
  sentences,
  callout,
  loading,
}: {
  sentences: string[]
  callout: string | null
  loading: boolean
}) {
  return (
    <section aria-labelledby="harness-summary" className="flex flex-col gap-2">
      <h2 id="harness-summary" className="sr-only">
        Summary
      </h2>
      {loading ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          <span className="sr-only">Loading summary</span>
          <Skeleton className="h-6 w-4/5" />
          <Skeleton className="h-6 w-2/5" />
        </div>
      ) : (
        <div className="flex max-w-[70ch] flex-col items-start gap-2">
          <p className="text-xl leading-7 font-medium" data-testid="harness-summary">
            {sentences.join(' ')}
          </p>
          {callout ? (
            <Badge variant="outline" className="text-xs">
              {callout}
            </Badge>
          ) : null}
        </div>
      )}
    </section>
  )
}

export interface Notice {
  problem: string
  action: string
}

function StatusLine({ notice }: { notice: Notice | null }) {
  if (!notice) return null
  return (
    <p role="status" data-testid="status-line" className="text-sm text-muted-foreground">
      {notice.problem} {notice.action}
    </p>
  )
}

/** Title, breadcrumb, window, Compare, the preview badge, at most one status line, and the refresh alert. */
export function HarnessHeader({
  search,
  setSearch,
  from,
  today,
  compare,
  crumbs,
  notice,
  refreshFailed,
  onRetry,
  extra,
}: {
  search: HarnessesSearch
  setSearch: SetSearch
  from: string | undefined
  today: string
  compare: boolean
  crumbs: Crumb[]
  notice: Notice | null
  refreshFailed: boolean
  onRetry: () => void
  /** A layer's own header controls (EE: the mock persona switcher). */
  extra?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title={copy.title}
        description={copy.subtitle}
        // A lone, unlinked crumb says nothing: show the trail only once it has a path (review 4c).
        breadcrumb={
          crumbs.length > 1 || search.harness ? (
            <Crumbs
              items={crumbs}
              harness={search.harness}
              onClearHarness={() => setSearch({ harness: undefined }, { replace: true })}
            />
          ) : undefined
        }
        actions={
          <>
            <TimeControl
              preset={search.preset}
              from={from}
              to={search.to}
              today={today}
              onChange={(n) => setSearch({ preset: n.preset, from: n.from, to: n.to })}
            />
            {/* Static label: the pressed state carries on/off (review 4d). */}
            <Toggle
              variant="outline"
              size="sm"
              pressed={compare}
              className="px-3"
              onPressedChange={() => setSearch({ compare: !compare }, { replace: true })}
            >
              Compare
            </Toggle>
            {preview ? (
              <Badge variant="outline" className="border-warning/50 text-warning">
                {copy.previewBadge}
              </Badge>
            ) : null}
            {extra}
          </>
        }
      />
      <StatusLine notice={notice} />
      {refreshFailed ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {copy.refreshFailed}
            <Button size="sm" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

/** The viewer lookup failed. */
export function ViewerError({ header, fix }: { header: ReactNode; fix: string }) {
  return (
    <div className="flex flex-col gap-4">
      {header}
      <StateCard tone="error" title="Couldn't identify you" fix={fix} />
    </div>
  )
}

export function LevelLoading({ header, compare }: { header: ReactNode; compare: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      {header}
      <Summary sentences={[]} callout={null} loading />
      <HarnessPanels items={[]} compare={compare} onToggle={() => {}} loading />
    </div>
  )
}

/** The first page failed (not a bare 404 or a coded one). */
export function UsageError({ header, onRetry }: { header: ReactNode; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      {header}
      <StateCard
        tone="error"
        title="Couldn't load harness usage"
        action={
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        }
      />
    </div>
  )
}

/** Live fallback: the viewer's own Individual level rebuilt from existing endpoints (degraded form, plan §5). */
export function LiveFallbackLevel({
  header,
  live,
  windowLabel,
  compare,
  selected,
  onToggle,
  name,
}: {
  header: ReactNode
  live: { data: LiveIndividual | undefined; loading: boolean; error: unknown; refetch: () => void }
  windowLabel: string
  compare: boolean
  selected: string | undefined
  onToggle: (harness: string) => void
  /** The viewer's display name, if the server has one. */
  name: string | null | undefined
}) {
  const d = live.data
  const items: PanelItem[] = (d?.harnesses ?? []).map((h) => ({
    harness: h.harness,
    totals: {
      scope_devs: 1,
      active_devs: h.active ? 1 : 0,
      registered_devs: h.registered ? 1 : 0,
      idle_seats: h.registered && !h.active ? 1 : 0,
      sessions: d?.sessions.filter((s) => s.harness === h.harness).length ?? 0,
      turns: h.turns,
      tokens: h.tokens,
      cost_usd: h.cost_usd,
      unpriced_calls: 0,
      delta_pct: h.delta_pct,
    },
  }))
  const t = (k: keyof HarnessTotals) => items.reduce((n, i) => n + (i.totals[k] as number), 0)
  const sentences = d
    ? harnessNarrative({
        windowLabel,
        res: {
          totals: {
            scope_devs: 1,
            active_devs: d.totals.active ? 1 : 0,
            registered_devs: d.totals.registered ? 1 : 0,
            idle_seats: d.totals.idle,
            sessions: t('sessions'),
            turns: d.totals.turns,
            tokens: d.totals.tokens,
            cost_usd: d.totals.cost_usd,
            unpriced_calls: 0,
            delta_pct: null,
          },
          by_harness: items.map((i) => ({ ...i.totals, harness: i.harness, top_models: [] })),
        },
        individual: { self: true, name: name ?? 'You' },
      })
    : []
  const unconnected = unconnectedHarnesses(
    (h) => !!d?.harnesses.some((x) => x.harness === h && x.registered),
  )
  return (
    <div className="flex flex-col gap-4">
      {header}
      {live.error ? (
        <StateCard
          tone="error"
          title="Couldn't load your harness usage"
          fix="The existing finops and catalog endpoints failed."
          action={
            <Button size="sm" variant="outline" onClick={live.refetch}>
              Retry
            </Button>
          }
        />
      ) : (
        <>
          <Summary sentences={sentences} callout={null} loading={live.loading || !d} />
          <HarnessPanels
            items={items}
            compare={compare}
            prevUnavailable={d?.prevUnavailable}
            onToggle={onToggle}
            selected={selected}
            perHarnessUnpricedKnown={false}
            sessionsKnown={false}
            showTopModel={false}
            loading={live.loading || !d}
          />
          {d ? <p className="text-xs text-muted-foreground">{copy.removedHarnesses}</p> : null}
          {d ? (
            <SessionsList
              title={copy.lastSessions(LIVE_SESSION_LIMIT)}
              note={copy.sessionsOwnOnly}
              linkable={!preview}
              items={d.sessions}
              initial={RECENT_SESSIONS_SHOWN}
              emptyText={copy.noRecentSessions}
            />
          ) : null}
          {d ? (
            <ConnectPanel unconnected={unconnected} self name={name ?? ''} server={serverOrigin} />
          ) : null}
        </>
      )}
    </div>
  )
}

/** The Individual level in full (usage endpoint): cards, recent sessions, daily strip, top models, trend, connect help. */
export function UserLevel({
  res,
  self,
  viewerIsSuperuser,
  win,
  days,
  today,
  harnesses,
  compare,
  stale,
  selected,
  onToggle,
  onWiden,
}: {
  res: UsageResponse
  /** The developer is the viewer. */
  self: boolean
  viewerIsSuperuser: boolean
  win: Pick<ResolvedWindow, 'label'>
  days: string[]
  today: string
  harnesses: string[]
  compare: boolean
  /** Placeholder data from the previous level is showing. */
  stale: boolean
  selected: string | undefined
  onToggle: (harness: string) => void
  onWiden: (() => void) | undefined
}) {
  const unconnected = unconnectedHarnesses((h) =>
    res.by_harness.some((x) => x.harness === h && x.registered_devs > 0),
  )
  return (
    <>
      <Summary
        sentences={harnessNarrative({
          windowLabel: win.label,
          res,
          individual: { self, name: res.scope.label },
        })}
        callout={null}
        loading={false}
      />
      {/* HarnessPanels only shows a Δ with Compare on; while placeholder data shows, it is the old level's. */}
      <HarnessPanels
        items={panelItems(res)}
        selected={selected}
        onToggle={onToggle}
        compare={compare}
        prevUnavailable={stale}
      />
      <div className="grid items-start gap-4 lg:grid-cols-[1.15fr_1fr]">
        {/* Mocked usage carries seed session ids the real Sessions page doesn't have. */}
        <SessionsList
          title="Recent sessions"
          note={self || viewerIsSuperuser ? undefined : copy.sessionsOwnOnly}
          linkable={!preview && (self || viewerIsSuperuser)}
          items={res.recent_sessions ?? []}
          initial={RECENT_SESSIONS_SHOWN}
        />
        <Panel
          title="Daily activity"
          subtitle="Active days (UTC), shaded by est. cost"
          labelledBy="activity-title"
        >
          <div className="flex flex-col gap-3">
            <ActivityStrip series={res.series} days={days} />
            <TopModels byHarness={res.by_harness} />
          </div>
        </Panel>
      </div>
      <Trend
        series={res.series}
        harnesses={harnesses}
        days={days}
        today={today}
        windowLabel={win.label}
        onWiden={onWiden}
        defaultMode="cost"
      />
      <ConnectPanel
        unconnected={unconnected}
        self={self}
        name={res.scope.label}
        server={serverOrigin}
      />
    </>
  )
}
