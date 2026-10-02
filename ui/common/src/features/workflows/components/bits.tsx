import { Link } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { copy } from '../copy'
import type { Tone } from '../logic'

const VARIANT = {
  success: 'success',
  error: 'destructive',
  warning: 'warning',
  info: 'info',
  neutral: 'muted',
} as const satisfies Record<Tone, string>

/** Text plus colour, never a colour alone. */
export function ToneBadge({ tone, children }: { tone: Tone; children: string }) {
  return (
    <Badge variant={VARIANT[tone]} data-tone={tone}>
      {children}
    </Badge>
  )
}

/** A quiet fact chip (steps, runs, tokens, durations). */
export function Chip({ children }: { children: string }) {
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      {children}
    </Badge>
  )
}

const SECTIONS = [
  { to: '/workflows', label: copy.nav.deployed },
  { to: '/workflows/drafts', label: copy.nav.drafts },
  { to: '/workflows/runs', label: copy.nav.runs },
] as const

/** Deployed · Drafts · Runs: the three lists are one module (the React nav's three items). */
export function SectionNav({ current }: { current: (typeof SECTIONS)[number]['to'] }) {
  return (
    <nav aria-label={copy.nav.label} className="flex flex-wrap gap-1">
      {SECTIONS.map((s) => (
        <Button
          key={s.to}
          asChild
          size="sm"
          variant={s.to === current ? 'secondary' : 'ghost'}
          className={s.to === current ? 'font-medium' : 'font-normal text-muted-foreground'}
        >
          <Link to={s.to} aria-current={s.to === current ? 'page' : undefined}>
            {s.label}
          </Link>
        </Button>
      ))}
    </nav>
  )
}
