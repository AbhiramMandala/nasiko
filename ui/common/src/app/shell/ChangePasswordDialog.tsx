/**
 * Self-service password change, opened from the account menu (nasiko-cloud-rs `43833316`,
 * ui/common/features/change-password-modal.js). `POST /api/auth/change-password` confirms with the current password:
 * - 200: this browser gets a fresh cookie; every other session is revoked.
 * - 204: the password changed, but no new session came back and the cookie was cleared, so sign out and say why.
 * - `{error, code}` errors land on the field the code names (`current_password_incorrect` is a 403, never session
 *   loss); anything else is a toast.
 * Mounted only while open (deferred from AppSidebar), so each open starts with empty fields.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api/client'
import type { Me } from '@/lib/api/auth'
import { PASSWORD_MAX, PASSWORD_MIN, passwordProblem, type PasswordProblem } from '@/lib/password'
import { passwordCopy as copy } from './passwordCopy'
import { signOut } from './signOut'

type Values = { current: string; next: string; confirm: string }

const problemText = (p: PasswordProblem) =>
  p === 'short'
    ? copy.problem.short(PASSWORD_MIN)
    : p === 'long'
      ? copy.problem.long(PASSWORD_MAX)
      : copy.problem[p]

/** The legacy dialog's order: the first failing check is the one reported. */
function firstProblem(v: Values): [keyof Values, string] | null {
  if (!v.current) return ['current', copy.currentRequired]
  if (!v.next) return ['next', copy.nextRequired]
  const p = passwordProblem(v.next)
  if (p) return ['next', problemText(p)]
  if (v.next === v.current) return ['next', copy.same]
  if (v.next !== v.confirm) return ['confirm', copy.mismatch]
  return null
}

/** The server's messages are lowercase fragments; the field reads them as sentences. */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function ChangePasswordDialog({ me, onClose }: { me: Me; onClose: () => void }) {
  const id = useId()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const form = useForm<Values>({ defaultValues: { current: '', next: '', confirm: '' } })
  const { errors } = form.formState

  const submit = form.handleSubmit(async (v) => {
    const problem = firstProblem(v)
    if (problem) {
      form.setError(problem[0], { message: problem[1] }, { shouldFocus: true })
      return
    }
    // One request at a time: a second one would send a current password the first already replaced.
    if (busy) return
    setBusy(true)
    try {
      const body = await apiFetch<unknown>('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: v.current, new_password: v.next }),
      })
      onClose()
      if (body !== null) {
        toast.success(copy.changed)
        return
      }
      await signOut({
        queryClient,
        userId: me.sub,
        navigate: (to) =>
          navigate({
            to: '/login',
            search: to.search.signout ? to.search : { password: 'changed' },
          }),
      })
    } catch (err) {
      const b = err instanceof ApiError ? (err.body as { code?: unknown } | null) : null
      const code = typeof b?.code === 'string' ? b.code : ''
      const message = sentence((err instanceof ApiError && err.serverMessage) || copy.failed)
      if (code === 'current_password_incorrect')
        form.setError('current', { message }, { shouldFocus: true })
      else if (code.startsWith('password_'))
        form.setError('next', { message }, { shouldFocus: true })
      else
        toast.error(
          err instanceof ApiError && !err.isServerUnreachable ? message : copy.unreachable,
        )
    } finally {
      setBusy(false)
    }
  })

  const field = (
    name: keyof Values,
    label: string,
    placeholder: string,
    autoComplete: string,
    hint?: string,
  ) => (
    <Field data-invalid={!!errors[name]} className="gap-1.5">
      <FieldLabel htmlFor={`${id}-${name}`}>{label}</FieldLabel>
      <Input
        id={`${id}-${name}`}
        type="password"
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-invalid={!!errors[name]}
        {...form.register(name, {
          // The message always describes the current value: acting on the field clears it.
          onChange: () => form.clearErrors(name),
        })}
      />
      {errors[name] ? (
        <FieldError errors={[errors[name]]} />
      ) : hint ? (
        <FieldDescription>{hint}</FieldDescription>
      ) : null}
    </Field>
  )

  return (
    <Dialog open onOpenChange={(o) => (o || busy ? null : onClose())}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.others}</DialogDescription>
          </DialogHeader>
          {/* Lets a password manager file the new password under the right account. */}
          <Input type="hidden" autoComplete="username" value={me.username} readOnly />
          <FieldGroup className="gap-4">
            {field('current', copy.current, copy.currentPlaceholder, 'current-password')}
            {field(
              'next',
              copy.next,
              copy.nextPlaceholder,
              'new-password',
              copy.policy(PASSWORD_MIN, PASSWORD_MAX),
            )}
            {field('confirm', copy.confirm, copy.confirmPlaceholder, 'new-password')}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {copy.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? copy.submitting : copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
