/**
 * Settings (plan §7.3, managers only): display name and description, secrets (names only;
 * values are write-only and cleared after submit), and delete (type the unique name).
 * Both forms are react-hook-form + zod (plan §2.4) and ask before a route change drops edits.
 */
import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useId, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { LeaveGuard } from '@/components/shared/leave-guard'
import { useSecretMutations, useSecrets, useUpdateAgent } from '../api'
import { ErrorNote, LearnMore, Section } from '../components/bits'
import { DeleteAgentDialog } from '../components/dialogs'
import { copy } from '../copy'
import type { AgentView } from '../normalize'
import { SAVED_NOTE_MS } from '../tuning'

export function SettingsTab({ agent }: { agent: AgentView }) {
  return (
    <div className="space-y-4">
      <DetailsForm agent={agent} />
      {agent.isHarness ? null : <Secrets id={agent.id} />}
      <DangerZone agent={agent} />
    </div>
  )
}

function useSavedNote() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!on) return
    const t = setTimeout(() => setOn(false), SAVED_NOTE_MS)
    return () => clearTimeout(t)
  }, [on])
  return [on, () => setOn(true)] as const
}

const detailsSchema = z.object({
  display_name: z.string().trim().min(1).max(200),
  description: z.string().max(2000),
})

function DetailsForm({ agent }: { agent: AgentView }) {
  const update = useUpdateAgent(agent.id)
  const [saved, flash] = useSavedNote()
  const form = useForm({
    resolver: zodResolver(detailsSchema),
    mode: 'onChange',
    defaultValues: { display_name: agent.displayName, description: agent.description },
  })
  const { isDirty, isValid, isSubmitting, errors } = form.formState
  const nameId = useId()
  const descId = useId()
  // The saved values become the new baseline, so the form is clean (and the guard off) after a save.
  const onSubmit = form.handleSubmit((v) =>
    update.mutate(v, {
      onSuccess: () => {
        form.reset(v)
        flash()
      },
    }),
  )
  return (
    <Section title={copy.settings}>
      <form className="max-w-xl space-y-3" onSubmit={onSubmit}>
        <Field className="gap-1">
          <FieldLabel htmlFor={nameId}>{copy.displayName}</FieldLabel>
          <Input
            id={nameId}
            maxLength={200}
            required
            aria-invalid={!!errors.display_name}
            {...form.register('display_name')}
          />
        </Field>
        <Field className="gap-1">
          <FieldLabel htmlFor={descId}>{copy.description}</FieldLabel>
          <Textarea id={descId} rows={3} maxLength={2000} {...form.register('description')} />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={!isDirty || !isValid || update.isPending}>
            {update.isPending ? `${copy.save}…` : copy.save}
          </Button>
          {saved ? (
            <span role="status" className="text-xs text-success">
              {copy.saved}
            </span>
          ) : null}
        </div>
        {update.isError ? <ErrorNote error={update.error} context="manage" /> : null}
      </form>
      <LeaveGuard when={isDirty && !isSubmitting} />
    </Section>
  )
}

const secretSchema = z.object({
  name: z.string().trim().min(1),
  value: z.string().min(1),
})

function Secrets({ id }: { id: string }) {
  const secrets = useSecrets(id, true)
  const m = useSecretMutations(id)
  const [setError, setSetError] = useState<Error | null>(null)
  const [saved, flash] = useSavedNote()
  const form = useForm({
    resolver: zodResolver(secretSchema),
    mode: 'onChange',
    defaultValues: { name: '', value: '' },
  })
  const { isDirty, isValid, isSubmitting } = form.formState
  const nameId = useId()
  const valueId = useId()
  const onSubmit = form.handleSubmit((v) => {
    // Clear the value on submit either way: it must not linger in the DOM or the form state.
    form.setValue('value', '', { shouldDirty: true, shouldValidate: true })
    setSetError(null)
    // Always reset(): it drops the value from the mutation's cached variables; the error is kept locally.
    m.set.mutate(v, {
      onSuccess: () => {
        form.reset()
        flash()
      },
      onError: setSetError,
      onSettled: () => m.set.reset(),
    })
  })
  return (
    <Section title={copy.secrets} action={<LearnMore href="secrets" />}>
      <p className="text-xs text-muted-foreground">{copy.secretsHowItWorks}</p>
      {secrets.isPending ? (
        <Skeleton className="h-10" />
      ) : secrets.isError ? (
        <ErrorNote error={secrets.error} onRetry={() => void secrets.refetch()} />
      ) : secrets.data.length ? (
        <ul className="divide-y divide-border text-sm">
          {secrets.data.map((s) => (
            <li key={s.name} className="flex items-center justify-between py-1.5">
              <code className="font-mono text-xs">{s.name}</code>
              <Button
                size="sm"
                variant="ghost"
                disabled={m.remove.isPending}
                aria-label={copy.removeSecret(s.name)}
                onClick={() => m.remove.mutate(s.name)}
              >
                {copy.remove}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{copy.noSecrets}</p>
      )}
      <form className="flex flex-wrap items-end gap-2" onSubmit={onSubmit}>
        <Field className="w-48 gap-1">
          <FieldLabel htmlFor={nameId}>{copy.secretName}</FieldLabel>
          <Input
            id={nameId}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            required
            {...form.register('name')}
          />
        </Field>
        <Field className="w-56 gap-1">
          <FieldLabel htmlFor={valueId}>{copy.secretValue}</FieldLabel>
          <Input
            id={valueId}
            type="password"
            autoComplete="new-password"
            required
            {...form.register('value')}
          />
        </Field>
        <Button type="submit" size="sm" disabled={!isValid || m.set.isPending}>
          {copy.addSecret}
        </Button>
        {saved ? (
          <span role="status" className="text-xs text-success">
            {copy.saved}
          </span>
        ) : null}
      </form>
      {setError ? <ErrorNote error={setError} context="secret" /> : null}
      {m.remove.isError ? <ErrorNote error={m.remove.error} context="secret" /> : null}
      <LeaveGuard when={isDirty && !isSubmitting} />
    </Section>
  )
}

function DangerZone({ agent }: { agent: AgentView }) {
  const [open, setOpen] = useState(false)
  return (
    <Section title={copy.dangerZone} className="border-destructive/40">
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        {copy.deleteAgent}
      </Button>
      <DeleteAgentDialog agent={agent} open={open} onOpenChange={setOpen} />
    </Section>
  )
}
