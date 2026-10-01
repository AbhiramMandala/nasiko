/**
 * Page- and section-level states on shadcn `Alert` and `Empty` (plan §8 Phase 1): what happened,
 * then what to do about it. Never a bare "No items found". Feature code maps its errors onto these
 * (observability `ErrorState`, agents `ErrorNote`, TokenOps `ServerDown`); the look lives here once.
 */
import { AlertTriangle, Info, ServerOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty'
import { cn } from '@/lib/utils'

export type StateTone = 'info' | 'warning' | 'error'

const ICON = { info: Info, warning: AlertTriangle, error: ServerOff } as const
// On the Alert, not the icon: the primitive's `[&>svg]:text-current` outranks a class on the svg itself.
const COLOR = {
  info: '[&>svg]:text-info',
  warning: '[&>svg]:text-warning',
  error: '[&>svg]:text-destructive',
} as const

/** Info is announced politely (`status`); warning and error interrupt (`alert`). */
export function StateCard({
  tone = 'info',
  title,
  children,
  fix,
  action,
  className,
}: {
  tone?: StateTone
  title: ReactNode
  children?: ReactNode
  /** The next step, in plain words or a command. */
  fix?: ReactNode
  action?: ReactNode
  className?: string
}) {
  const Icon = ICON[tone]
  return (
    <Alert
      role={tone === 'info' ? 'status' : 'alert'}
      className={cn('gap-y-2 p-5', COLOR[tone], className)}
    >
      <Icon aria-hidden />
      <AlertTitle className="line-clamp-none">{title}</AlertTitle>
      {children || fix || action ? (
        <AlertDescription className="max-w-prose gap-2">
          {children ? <div>{children}</div> : null}
          {fix ? <div>{fix}</div> : null}
          {action}
        </AlertDescription>
      ) : null}
    </Alert>
  )
}

/** Nothing to show yet: a dashed `Empty` with a title, an optional line and an optional action. */
export function EmptyState({
  title,
  children,
  action,
  className,
}: {
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <Empty className={cn('gap-2 border border-border px-4 py-8 md:p-8', className)}>
      <EmptyHeader className="gap-1">
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        {children ? <EmptyDescription className="text-xs">{children}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}
