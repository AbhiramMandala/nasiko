/**
 * The Overview's Setup guide for returning users (spec §4): the header button and the empty-fleet card's body. Both
 * reopen the guide at the first step not done yet.
 */
import { BookOpen, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAgentsDirectory } from '@/features/agents/api'
import { useConfigs } from '@/features/router/api'
import { cn } from '@/lib/utils'
import { openGuide, useGuide } from './api'
import { copy } from './copy'
import { firstOpenStep, ticks as tick, type Ticks } from './logic'

function useTicks(): Ticks {
  const { persona } = useGuide()
  const configs = useConfigs().data?.length ?? 0
  const agents = useAgentsDirectory().data?.length ?? 0
  return tick({ persona, configs, agents })
}

export function SetupGuideButton({ className }: { className?: string }) {
  const t = useTicks()
  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      onClick={() => openGuide(firstOpenStep(t))}
    >
      <BookOpen aria-hidden /> {copy.card.title}
    </Button>
  )
}

const ROWS = [
  ['role', copy.steps.role],
  ['model', copy.steps.model],
  ['agent', copy.steps.agent],
] as const

export function GuideSteps({ buttonClassName }: { buttonClassName?: string }) {
  const t = useTicks()
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{copy.card.intro}</p>
      <ul className="flex flex-col gap-2">
        {ROWS.map(([id, s]) => (
          <li key={id} className="flex items-center gap-3 text-sm">
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full',
                t[id] ? 'bg-primary text-primary-foreground' : 'border',
              )}
            >
              {t[id] ? <Check aria-hidden className="size-3" /> : null}
            </span>
            <span className="flex-1">
              <span className="font-medium">{s.title}</span>{' '}
              <span className="text-muted-foreground">· {s.sub}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              {t[id] ? copy.card.done : copy.card.todo}
            </span>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        className={cn('self-start', buttonClassName)}
        onClick={() => openGuide(firstOpenStep(t))}
      >
        {copy.card.resume}
      </Button>
    </div>
  )
}
