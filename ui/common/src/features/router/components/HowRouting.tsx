/**
 * "How routing works" (plan §4.1): the page title's disclosure. Five numbered steps, left to right from lg (with a
 * chevron between them) and stacked below with a connecting line, then a footer with this viewer's own numbers.
 * Opens by default on a first visit with no configs; an explicit choice is remembered (prefs.ts).
 */
import { AnimatePresence, m } from 'motion/react'
import {
  ChevronDown,
  ChevronRight,
  KeyRound,
  Layers,
  RotateCw,
  Send,
  SlidersHorizontal,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { PageHeader } from '@/components/shared/page-header'
import { Button } from '@/components/ui/button'
import { transitions } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { copy } from '../copy'
import { PREF_HOW, readOpen, writeOpen } from '../prefs'
import { LinkButton } from './bits'

const ICONS: readonly LucideIcon[] = [Send, SlidersHorizontal, Layers, KeyRound, RotateCw]

export function RouterTitle({
  configsEmpty,
  onDefault,
  total,
  defaultName,
  onShowDefaults,
}: {
  configsEmpty: boolean
  /** "14" (or "at least 13") agents on the default, when there is a default. */
  onDefault?: string
  total?: string
  defaultName?: string
  /** Narrow Your agents to the ones on the default. */
  onShowDefaults?: () => void
}) {
  const [open, setOpen] = useState<boolean>(() => readOpen(PREF_HOW) ?? false)
  const [touched, setTouched] = useState(() => readOpen(PREF_HOW) !== null)
  // First visit with no configs: open by default (plan §4.1); an explicit choice always wins.
  const shown = touched ? open : open || configsEmpty
  const toggle = (next: boolean) => {
    setTouched(true)
    setOpen(next)
    writeOpen(PREF_HOW, next)
  }
  const toggleRef = useRef<HTMLButtonElement>(null)
  return (
    <div className="space-y-3">
      <PageHeader
        title={copy.title}
        actions={
          <Button
            ref={toggleRef}
            variant="ghost"
            size="sm"
            aria-expanded={shown}
            aria-controls="router-how"
            onClick={() => toggle(!shown)}
            className="pointer-coarse:min-h-11"
          >
            {copy.howItWorks}{' '}
            <ChevronDown
              className={cn(
                'size-4 transition-transform motion-reduce:transition-none',
                shown && 'rotate-180',
              )}
              aria-hidden
            />
          </Button>
        }
      />
      <AnimatePresence initial={false}>
        {shown ? (
          <m.section
            id="router-how"
            aria-labelledby="router-how-h"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={transitions.disclosure}
            className="relative rounded-lg border border-border bg-card"
          >
            <div className="flex items-center justify-between gap-2 px-4 pt-3">
              <h2
                id="router-how-h"
                className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
              >
                {copy.howTitle}
              </h2>
              <Button
                variant="ghost"
                size="sm"
                className="size-7 px-0 text-muted-foreground pointer-coarse:size-11"
                onClick={() => {
                  toggle(false)
                  toggleRef.current?.focus()
                }}
                aria-label={copy.howClose}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </div>
            <ol className="grid gap-0 px-4 pt-3 pb-4 lg:grid-cols-5 lg:gap-4">
              {copy.howSteps.map((step, i) => {
                const Icon = ICONS[i] ?? Send
                const last = i === copy.howSteps.length - 1
                return (
                  <li
                    key={step.title}
                    className="relative flex gap-3 pb-4 last:pb-0 lg:flex-col lg:gap-2 lg:pb-0"
                  >
                    {/* Stacked: a line joins the numbers. From lg: a chevron points to the next step. */}
                    {!last ? (
                      <span
                        aria-hidden
                        className="absolute top-7 bottom-0 left-3 w-px bg-border lg:hidden"
                      />
                    ) : null}
                    {!last ? (
                      <ChevronRight
                        aria-hidden
                        className="absolute top-1 -right-3 hidden size-4 text-muted-foreground/60 lg:block"
                      />
                    ) : null}
                    <span className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary-text">
                      {i + 1}
                    </span>
                    <div className="min-w-0 space-y-0.5">
                      <p className="flex items-center gap-1.5 text-sm font-medium">
                        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        {step.title}
                      </p>
                      <p className="text-xs text-muted-foreground">{step.detail}</p>
                    </div>
                  </li>
                )
              })}
            </ol>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-muted/40 px-4 py-2.5 text-xs">
              {onDefault && total ? (
                <span>
                  {copy.howCounts(onDefault, total, defaultName)}
                  {onShowDefaults ? (
                    <>
                      {' '}
                      <LinkButton className="text-xs" onClick={onShowDefaults}>
                        {copy.howShowDefaults}
                      </LinkButton>
                    </>
                  ) : null}
                </span>
              ) : null}
              <span className="text-muted-foreground">{copy.configuredNote}</span>
            </div>
          </m.section>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
