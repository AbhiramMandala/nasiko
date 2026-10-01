/**
 * Settings rows, as the legacy page lays them out: a rule under the page header, then one row per setting with its
 * label and hint on the left and the control on the right (stacked on narrow screens), each closed by a rule. The EE
 * sections use them too, so every Settings page reads the same.
 */
import type { ReactNode } from 'react'
import { FieldError, FieldLabel } from '@/components/ui/field'
import { cn } from '@/lib/utils'

/** The rows' container: the query target for their two-column switch. */
export function SettingRows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('@container border-t border-border', className)}>{children}</div>
}

export function SettingRow({
  htmlFor,
  label,
  hint,
  hintId,
  error,
  children,
}: {
  /** The control's id; omit for a row with no control (a note). */
  htmlFor?: string
  label: string
  hint?: ReactNode
  /** Lets the control point `aria-describedby` at the hint. */
  hintId?: string
  error?: string
  children?: ReactNode
}) {
  return (
    <div className="grid gap-3 border-b border-border py-5 @[640px]:grid-cols-[minmax(0,1fr)_minmax(16rem,26rem)] @[640px]:gap-12">
      <div className="min-w-0">
        {htmlFor ? (
          <FieldLabel htmlFor={htmlFor} className="text-sm font-medium">
            {label}
          </FieldLabel>
        ) : (
          <p className="text-sm font-medium">{label}</p>
        )}
        {hint ? (
          <div id={hintId} className="mt-1.5 max-w-prose text-sm text-muted-foreground">
            {hint}
          </div>
        ) : null}
      </div>
      {children ? (
        <div className="min-w-0 self-center">
          {children}
          {error ? <FieldError className="mt-1.5">{error}</FieldError> : null}
        </div>
      ) : null}
    </div>
  )
}

/** A sub-heading inside a section (SCIM provisioning, Organization rules). */
export function SettingHeading({ children }: { children: ReactNode }) {
  return <h2 className="pt-8 pb-3 text-base font-semibold">{children}</h2>
}
