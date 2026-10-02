/**
 * Token optimisation: what the optimiser saved on agents that have it on (canvas "TokenOps ·
 * Optimise section"). A placeholder on sample data until the savings endpoint exists; the badge
 * says so. Loading, error and empty states come with the real query.
 */
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Panel } from '@/components/shared/panel'
import { AgentLink } from '@/features/agents/components/AgentLink'
import { fmtInt, fmtMoney, fmtPct, fmtTokens } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { OptimisationView } from '../optimisation'
import { CELL, ChartTable, HEAD, NUM, ROW_HEAD, STICKY_HEAD } from './ChartTable'

export function OptimisationPanel({ data }: { data: OptimisationView }) {
  return (
    <Panel
      title="Savings on optimised agents"
      subtitle="Tokens the optimiser removed before each call reached the model, on agents where it is turned on. Cost saved is estimated at API list price."
      labelledBy="optimisation-title"
      actions={
        <Badge variant="outline" className="border-dashed text-muted-foreground">
          Preview · sample data
        </Badge>
      }
    >
      <dl className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-3">
        <Figure label="Tokens saved" value={fmtPct(data.savedPct)}>
          <span className="font-mono text-foreground">{fmtTokens(data.tokensSaved)}</span> of{' '}
          {fmtTokens(data.tokensBefore)} input tokens
        </Figure>
        <Figure label="Est. cost saved (API list price)" value={fmtMoney(data.costSaved)}>
          {Math.round(data.costSavedPct)}% off what these agents would have spent (output tokens
          aren&apos;t trimmed)
        </Figure>
        <Figure
          label="Optimised agents"
          value={
            <>
              {fmtInt(data.optimisedCount)}
              <span className="ml-1.5 text-base font-normal text-muted-foreground">
                of {fmtInt(data.totalAgents)}
              </span>
            </>
          }
        >
          They made {Math.round(data.optimisedSharePct)}% of fleet spend
        </Figure>
      </dl>

      <ChartTable className="max-h-none">
        <caption className="sr-only">Savings per optimised agent</caption>
        <TableHeader className={STICKY_HEAD}>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className={HEAD}>
              Agent
            </TableHead>
            <TableHead scope="col" className={cn(HEAD, 'text-right')}>
              Calls
            </TableHead>
            <TableHead scope="col" className={cn(HEAD, 'text-right')}>
              Input tokens (before → after)
            </TableHead>
            <TableHead scope="col" className={cn(HEAD, 'w-1/3')}>
              Tokens saved
            </TableHead>
            <TableHead scope="col" className={cn(HEAD, 'text-right')}>
              Est. saved
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((r) => (
            <TableRow key={r.id}>
              <TableHead scope="row" className={ROW_HEAD}>
                <AgentLink id={r.id} name={r.name} className="font-medium">
                  {r.name}
                </AgentLink>
              </TableHead>
              <TableCell className={cn(CELL, NUM)}>{fmtInt(r.calls)}</TableCell>
              <TableCell className={cn(CELL, NUM, 'font-mono')}>
                {fmtTokens(r.before)} <span className="text-muted-foreground">→</span>{' '}
                {fmtTokens(r.after)}
              </TableCell>
              <TableCell className={CELL}>
                <div className="flex items-center gap-2.5">
                  <div className="h-2 flex-1 overflow-hidden rounded-xs bg-muted" aria-hidden>
                    <div className="h-full bg-chart-1" style={{ width: `${r.barPct}%` }} />
                  </div>
                  <span className="w-12 text-right font-semibold tabular-nums">
                    {fmtPct(r.savedPct)}
                  </span>
                </div>
              </TableCell>
              <TableCell className={cn(CELL, NUM, 'font-medium')}>
                {fmtMoney(r.costSaved)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </ChartTable>

      {data.unoptimisedCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md bg-muted px-3 py-2.5 text-sm">
          <p>
            {fmtInt(data.unoptimisedCount)}{' '}
            {data.unoptimisedCount === 1 ? "agent doesn't" : "agents don't"} have optimisation on.
            They made <strong>{fmtMoney(data.unoptimisedSpend)}</strong> (
            {Math.round(data.unoptimisedSharePct)}%) of fleet spend.
            {data.topUnoptimised ? (
              <>
                {' '}
                The biggest is <strong>{data.topUnoptimised.agent_name}</strong>.
              </>
            ) : null}
          </p>
          <Button asChild variant="outline" size="sm">
            <Link to="/agents">
              Turn on for an agent <span aria-hidden>→</span>
            </Link>
          </Button>
        </div>
      ) : null}
    </Panel>
  )
}

function Figure({
  label,
  value,
  children,
}: {
  label: string
  value: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-card p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex flex-col gap-1.5">
        <span className="text-2xl font-semibold tabular-nums sm:text-3xl">{value}</span>
        <span className="text-xs text-muted-foreground">{children}</span>
      </dd>
    </div>
  )
}
