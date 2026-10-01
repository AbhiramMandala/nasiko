import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { CircleAlert } from 'lucide-react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { copy } from '@/app/shell/copy'
import { LoginShowcase } from '@/app/shell/LoginShowcase'
import { NasikoMark } from '@/app/shell/NasikoMark'
import { LOGIN_ACCENT, pinAccent } from '@/app/shell/theme'
import {
  endServerSession,
  LOGIN_TIMEOUT_MS,
  resetQueryClient,
  type SignOutResult,
  stopChatTurns,
  stopDeployWork,
  whenSignedOut,
} from '@/app/shell/signOut'
import { lockedFor, login, safeRedirect } from '@/lib/api/auth'
import { ApiError, isTimeoutError } from '@/lib/api/client'
import {
  broadcastSession,
  bumpSignInGeneration,
  clearSignedOutMark,
  signedOutMark,
  withSessionLock,
} from '@/lib/session'
import { env } from '@/lib/env'

export const Route = createFileRoute('/login')({
  validateSearch: z.object({
    redirect: z.string().optional().catch(undefined),
    expired: z.union([z.boolean(), z.string()]).optional().catch(undefined),
    // Set by sign out when the logout call failed or timed out (plans/feat-app-shell.md eng D6).
    signout: z.literal('failed').optional().catch(undefined),
    // Set by Settings when a password change came back without a new session (plans/feat-settings.md §1.1).
    password: z.literal('changed').optional().catch(undefined),
  }),
  component: LoginPage,
})

/** The login form. No LeaveGuard: it navigates on success, and a half-typed password isn't worth guarding. */
const loginSchema = z.object({
  username: z.string().min(1, copy.login.usernameRequired),
  password: z.string().min(1, copy.login.passwordRequired),
})
type LoginValues = z.infer<typeof loginSchema>

function LoginPage() {
  const { redirect, expired, signout, password } = Route.useSearch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues:
      env.mode === 'mock'
        ? { username: 'admin', password: 'mock' }
        : { username: '', password: '' },
  })
  const { errors, isSubmitting: busy } = form.formState
  // Carbon while this page is open (arriving by sign-out included); leaving it restores the stored theme.
  useEffect(() => {
    pinAccent(LOGIN_ACCENT)
    return () => pinAccent(null)
  }, [])
  // Keep Sign in disabled while Try again runs (the session lock already serialises the two calls).
  const [retrying, setRetrying] = useState(false)
  // handleSubmit clears root errors itself at the start of each submit.
  const setError = (message: string) => form.setError('root.server', { message })

  const submit = async ({ username, password }: LoginValues) => {
    if (retrying) return
    // Set only when the login request itself hit our cap: a session lock that never frees throws a
    // TimeoutError too, but that wait is in this browser, not a slow server.
    let loginTimedOut = false
    try {
      // A sign-out still finishing in this tab clears the cache once more at its end: let it finish.
      await whenSignedOut()
      // Before any credential is sent: a turn an expired session left running would otherwise save its
      // reply with the new cookie the moment login sets it (review, security). Such a turn is dead
      // either way, so a failed login loses nothing.
      await stopChatTurns()
      // Same for deploy work: an expired session's uploads, imports and followed builds must not finish (or toast) for
      // whoever signs in next (review: /ship adversarial).
      await stopDeployWork()
      // Under the session lock, so no tab's logout can clear the cookie this sets.
      await withSessionLock(async () => {
        const result = await login(username, password, LOGIN_TIMEOUT_MS).catch((err: unknown) => {
          loginTimedOut = isTimeoutError(err)
          throw err
        })
        // A real sign-in lifts the local sign-out barrier and tells this browser's other tabs who signed
        // in (a tab showing another account reloads; one showing this account keeps its state); the
        // generation tells a sign-out still in flight elsewhere to leave this new session alone.
        bumpSignInGeneration()
        clearSignedOutMark()
        broadcastSession({ type: 'signed-in', sub: result.user_id })
      })
      // A new login may be a different account: drop every cached query so no page shows the
      // previous account's data. The _app route's beforeLoad (ensureQueryData(meQuery)) then
      // loads the new identity.
      await resetQueryClient(queryClient)
      await navigate({ to: safeRedirect(redirect) })
    } catch (err) {
      // Every 401 gets one message, "account disabled" included: the server checks that before the
      // password, so naming it would tell anyone which usernames exist (recommendations §4).
      if (err instanceof ApiError && err.status === 401) setError(copy.login.wrongCredentials)
      // A lock (429 `account_locked`) lasts much longer than the rate limit. `remaining_attempts` on a 401 is never
      // shown: the server only sends it for usernames that exist.
      else if (err instanceof ApiError && err.status === 429) {
        const locked = lockedFor(err.body)
        setError(locked === null ? copy.login.rateLimited : copy.login.locked(locked))
      }
      // Our 10 s cap, not a stopped server: say the server is slow rather than unreachable.
      else if (loginTimedOut) setError(copy.login.timedOut)
      else if (err instanceof ApiError && err.isServerUnreachable) setError(copy.login.unreachable)
      else setError(copy.login.failed)
    }
  }

  return (
    // Our own take on Aceternity's "Login Form With Gradient", measured against its live preview: the preview's
    // neutral-100 / neutral-900 page (Carbon's muted / card), max-w-7xl, two equal columns with a 160 px gap from lg,
    // 16 px label-to-field and 32 px field spacing, a 40 px rounded-xl button; the decorative showcase from `md` up.
    // The form is centred beside the panel and capped at max-w-md: without the block's social row and sign-up line
    // it is shorter than the panel, so a top-aligned or full-column form read as off (user review).
    <main className="flex min-h-svh items-center bg-muted dark:bg-card">
      <div className="mx-auto grid w-full max-w-7xl items-center gap-10 px-4 py-10 md:grid-cols-2 md:px-8 md:py-20 lg:gap-40">
        <div className="flex w-full max-w-md flex-col gap-3">
          {/* Only while the barrier is set (or unknowable: storage blocked). A stale ?signout=failed after
          a newer sign-in must not offer a logout that would end that new session (review, red team). */}
          {signout === 'failed' && signedOutMark() !== false ? (
            <SignOutFailed
              disabled={busy}
              onBusy={setRetrying}
              onDone={() =>
                void navigate({ to: '/login', search: { redirect, expired }, replace: true })
              }
            />
          ) : null}
          <NasikoMark className="size-6 text-logo" />
          <h1 className="mt-1 text-3xl font-medium tracking-tight md:text-4xl">
            {copy.login.title}
          </h1>
          <p className="mt-1 text-sm font-medium tracking-tight text-muted-foreground lg:text-base">
            {password
              ? copy.login.passwordChanged
              : expired
                ? copy.login.expired
                : copy.login.tagline}
          </p>
          <form className="mt-3" onSubmit={(e) => void form.handleSubmit(submit)(e)}>
            <FieldGroup className="gap-8">
              <Field data-invalid={!!errors.username} className="gap-4">
                <FieldLabel htmlFor="login-username" className="leading-none">
                  {copy.login.username}
                </FieldLabel>
                <Input
                  id="login-username"
                  autoComplete="username"
                  required
                  aria-invalid={!!errors.username}
                  {...form.register('username')}
                />
                <FieldError errors={[errors.username]} className="text-xs" />
              </Field>
              <Field data-invalid={!!errors.password} className="gap-4">
                <FieldLabel htmlFor="login-password" className="leading-none">
                  {copy.login.password}
                </FieldLabel>
                <Input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  aria-invalid={!!errors.password}
                  {...form.register('password')}
                />
                <FieldError errors={[errors.password]} className="text-xs" />
              </Field>
              <FieldError errors={[errors.root?.server]} className="text-xs" />
              <Button
                type="submit"
                size="lg"
                className="rounded-xl text-base"
                disabled={busy || retrying}
              >
                {busy ? copy.login.submitting : copy.login.submit}
              </Button>
            </FieldGroup>
          </form>
        </div>
        <LoginShowcase />
      </div>
    </main>
  )
}

/** The logout call didn't confirm: say so, and let the user repeat only that call. */
function SignOutFailed({
  disabled,
  onBusy,
  onDone,
}: {
  disabled: boolean
  onBusy: (busy: boolean) => void
  onDone: () => void
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  const retry = async () => {
    setState('busy')
    onBusy(true)
    let result: SignOutResult | 'already' = 'logout-failed'
    try {
      result = await withSessionLock(async () => {
        // Someone signed in since this notice appeared: that session is not the one to end.
        if (signedOutMark() === false) return 'already' as const
        const r = await endServerSession()
        if (r === 'signed-out') {
          clearSignedOutMark()
          broadcastSession({ type: 'signed-out', failed: false })
        }
        return r
      })
    } catch {
      // The lock never came (another tab hung): say it failed, and give the form back.
    } finally {
      onBusy(false)
    }
    if (result === 'logout-failed') setState('failed')
    else onDone()
  }
  return (
    // Polite (`status`), not StateCard's warning `alert`: the notice waits for the user, it doesn't interrupt.
    // The icon colour goes on the Alert: its own `[&>svg]:text-current` outranks a class on the icon.
    <Alert role="status" className="border-warning/50 p-4 [&>svg]:text-warning">
      {/* Warnings keep their icon (§5.3): under Gold the warning orange sits near the brand fill. */}
      <CircleAlert aria-hidden />
      <AlertDescription className="text-foreground">
        <p>{copy.login.signOutFailed}</p>
        {state === 'failed' ? (
          <p className="text-muted-foreground">{copy.login.tryAgainFailed}</p>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={disabled || state === 'busy'}
          onClick={() => void retry()}
        >
          {state === 'busy' ? copy.login.tryingAgain : copy.login.tryAgain}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
