import { animate, type AnimationPlaybackControls, useReducedMotion } from 'motion/react'
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { durations } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { copy } from './copy'
import { NasikoMark } from './NasikoMark'

/**
 * The login page's showcase: our own take on Aceternity's "Login Form With Gradient" block (a Pro block, so no
 * source copied; docs/superpowers/specs/2026-09-30-aceternity-login-design.md). Decorative only: aria-hidden, CSS
 * only, still under reduced motion. Its palette is the block's (black, dark tiles, a warm glow): the `--showcase-*`
 * tokens, the same in every theme and mode. Hidden below `md`. The headline
 * is our take on Aceternity's "Text Animation Typewriter Effect" (also Pro).
 */
const AREAS = [
  copy.nav.chat,
  copy.nav.agents,
  copy.nav.router,
  copy.nav.sessions,
  copy.nav.tokenops,
]

export function LoginShowcase() {
  return (
    <div
      aria-hidden
      data-testid="login-showcase"
      className="relative hidden aspect-7/8 flex-col items-start justify-end overflow-hidden rounded-2xl bg-showcase p-8 text-showcase-foreground md:flex"
    >
      <Tiles className="-top-48 -right-40" />
      <Tiles className="top-0 -right-10 opacity-50" />
      {/* Above the tiles, as the block's canvas is: an opaque colour field, 800 px wide from the left edge (the panel
          clips it), blurred, and masked so it shows fully in the bottom half and fades out towards the top. The blobs
          are clipped to it and let the base through, so the blur darkens its left and bottom edges and the colours
          blend as muted as the block's. Under reduced motion each blob holds its hue. */}
      <div className="pointer-events-none absolute inset-y-0 left-0 w-200 overflow-hidden bg-showcase-glow-base mask-t-from-50% blur-3xl">
        <Blob className="-top-1/4 -left-1/4 size-120 bg-showcase-glow-1" />
        <Blob className="top-0 left-1/3 size-120 bg-showcase-glow-2 [animation-delay:-3s] [animation-duration:12s]" />
        <Blob className="top-1/3 -left-1/5 size-120 bg-showcase-glow-3 [animation-delay:-6s] [animation-duration:14s]" />
        <Blob className="top-1/2 left-1/4 size-120 bg-showcase-glow-4 [animation-delay:-9s] [animation-duration:11s]" />
      </div>
      <div className="relative mb-2 flex max-w-sm flex-wrap gap-2">
        {AREAS.map((a) => (
          <Badge
            key={a}
            variant="outline"
            className="rounded-md border-transparent bg-showcase/50 px-2 py-1 font-normal text-showcase-foreground"
          >
            {a}
          </Badge>
        ))}
      </div>
      <div className="relative max-w-sm rounded-xl bg-showcase/50 p-4 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <NasikoMark className="size-5 text-showcase-accent" />
          <span className="font-medium">{copy.login.showcaseTitle}</span>
        </div>
        <Headline />
        <p className="mt-2 text-sm text-showcase-foreground/60">{copy.login.showcaseLine}</p>
      </div>
    </div>
  )
}

function Blob({ className }: { className: string }) {
  return (
    <div
      className={cn(
        'absolute animate-glow rounded-full opacity-75 motion-reduce:animate-none',
        className,
      )}
    />
  )
}

/** A rotated row of four tiles, faded out to the right (Aceternity's masked grid, in tokens). */
function Tiles({ className }: { className: string }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute grid rotate-45 grid-cols-4 gap-32 mask-r-from-50%',
        className,
      )}
    >
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="size-40 shrink-0 rounded-3xl bg-showcase-tile shadow-[inset_0_2px_0_0_var(--color-showcase-tile-edge)]"
        />
      ))}
    </div>
  )
}

const WORDS = copy.login.showcaseWords
const LONGEST = WORDS.reduce((a, b) => (b.length > a.length ? b : a))

/** "The OpenRuntime for" + each word typed and erased in turn, looping. The longest word sits
 *  invisible in the same grid cell, so the card never changes size while it types. */
function Headline() {
  const reduce = useReducedMotion()
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (reduce) return
    let stopped = false
    let current: AnimationPlaybackControls | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = (word: string, from: number, to: number, perChar: number) =>
      new Promise<void>((resolve) => {
        current = animate(from, to, {
          duration: (Math.abs(to - from) * perChar) / 1000,
          ease: 'linear',
          onUpdate: (v) => setTyped(word.slice(0, Math.round(v))),
          onComplete: resolve,
        })
      })
    // Pauses are real timers, not Motion delays: with animations skipped (tests' MotionGlobalConfig.skipAnimations)
    // every `run` completes at once, and the loop would otherwise spin without ever yielding.
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms)
      })
    const play = async () => {
      // Loops until unmount (user decision 2026-09-30).
      await pause(durations.standard)
      while (!stopped) {
        for (const word of WORDS) {
          if (stopped) return
          await run(word, 0, word.length, durations.typeChar)
          if (stopped) return
          await pause(durations.typeHold)
          if (stopped) return
          await run(word, word.length, 0, durations.eraseChar)
        }
      }
    }
    void play()
    // A stopped animation or cleared timer never resolves, so `play` just stays parked; nothing else holds it.
    return () => {
      stopped = true
      current?.stop()
      clearTimeout(timer)
    }
  }, [reduce])
  return (
    <p className="mt-3 text-2xl leading-tight font-medium tracking-tight">
      {copy.login.showcaseLead}{' '}
      <span className="inline-grid">
        <span className="invisible col-start-1 row-start-1">{LONGEST}</span>
        <span className="col-start-1 row-start-1 text-showcase-accent">
          {reduce ? WORDS[0] : typed}
          <span className="ml-0.5 inline-block h-lh w-0.5 animate-caret bg-showcase-accent align-bottom motion-reduce:hidden" />
        </span>
      </span>
    </p>
  )
}
