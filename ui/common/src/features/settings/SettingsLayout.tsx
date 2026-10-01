/**
 * The Settings module (plans/feat-settings.md §1), around each of its pages, laid out as nasiko-cloud-rs
 * (`origin/development` a4853db4) lays it out: a left column titled Settings with collapsible groups, the page beside
 * it. The rows are `ui/oss/navigation.js` `MODULE_NAVS.settings` plus `ui/ee/web/nav-ext-ee.js`:
 * - Workspace: General, (EE: Orchestrator), Flow limits, Registry. `/settings?section=`.
 * - Security: (EE: Single sign-on), Secrets (`/settings/secrets`).
 * A layer's rows come from the `settingsSections` slot, placed after the row they name. A member sees only Secrets:
 * the workspace sections are superuser-gated on the API.
 */
import { useQuery } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import { ChevronDown, Settings } from 'lucide-react'
import type { ReactNode } from 'react'
import { useSlots } from '@/app/edition-context'
import type { SettingsSection } from '@/app/edition'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { meQuery } from '@/lib/api/auth'
import { cn } from '@/lib/utils'
import { copy } from './copy'
import { CORE_SECTIONS } from './search'

interface Row {
  key: string
  label: string
  to: '/settings' | '/settings/secrets'
  section?: string
}

/** `rows` with each layer section inserted after the row it names (or appended). */
function withLayer(rows: Row[], layer: readonly SettingsSection[]): Row[] {
  const out = [...rows]
  for (const s of layer) {
    const row: Row = { key: s.key, label: s.label, to: '/settings', section: s.key }
    const at = s.after ? out.findIndex((r) => r.key === s.after) : -1
    if (at < 0) out.push(row)
    else out.splice(at + 1, 0, row)
  }
  return out
}

export function SettingsLayout({ children }: { children: ReactNode }) {
  const me = useQuery(meQuery)
  const { settingsSections } = useSlots()
  const location = useRouterState({ select: (s) => s.location })
  const admin = me.data?.is_superuser === true
  const inGroup = (g: 'workspace' | 'security') => settingsSections.filter((s) => s.group === g)
  const groups: { key: string; label: string; rows: Row[] }[] = [
    ...(admin
      ? [
          {
            key: 'workspace',
            label: copy.nav.workspace,
            rows: withLayer(
              CORE_SECTIONS.map((k): Row => ({
                key: k,
                label: copy.sections[k].label,
                to: '/settings',
                // General is the default: its link carries no section.
                section: k === 'general' ? undefined : k,
              })),
              inGroup('workspace'),
            ),
          },
        ]
      : []),
    {
      key: 'security',
      label: copy.nav.security,
      rows: [
        ...withLayer([], admin ? inGroup('security') : []),
        { key: 'secrets', label: copy.secrets.title, to: '/settings/secrets' },
      ],
    },
  ]
  const known = new Set(groups.flatMap((g) => g.rows.map((r) => r.key)))
  const raw = (location.search as { section?: unknown }).section
  const onSecrets = location.pathname === '/settings/secrets'
  const current = onSecrets
    ? 'secrets'
    : typeof raw === 'string' && known.has(raw)
      ? raw
      : 'general'
  return (
    // The container is the parent; the row/column switch is on its child (a container query can't match itself).
    <div className="@container mx-auto w-full max-w-page">
      <div className="flex flex-col gap-6 @[768px]:flex-row @[768px]:items-start @[768px]:gap-10">
        <nav
          aria-label={copy.nav.label}
          className="flex shrink-0 flex-col gap-3 @[768px]:sticky @[768px]:top-4 @[768px]:w-56"
        >
          <p className="flex items-center gap-2 px-2 text-sm font-medium">
            <Settings aria-hidden className="size-4 text-muted-foreground" />
            {copy.title}
          </p>
          {groups.map((g) => (
            <Collapsible key={g.key} defaultOpen className="flex flex-col gap-0.5">
              <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">
                <ChevronDown
                  aria-hidden
                  className="size-3.5 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90 motion-reduce:transition-none"
                />
                {g.label}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="flex flex-col gap-0.5">
                  {g.rows.map((r) => (
                    <li key={r.key}>
                      <Link
                        to={r.to}
                        search={r.to === '/settings' ? { section: r.section } : undefined}
                        replace={r.to === '/settings' && !onSecrets}
                        aria-current={current === r.key ? 'page' : undefined}
                        className={cn(
                          'block rounded-md py-1.5 pr-2 pl-7 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:py-2.5',
                          current === r.key && 'bg-accent font-medium text-foreground',
                        )}
                      >
                        {r.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </nav>
        <div className="min-w-0 flex-1 @[768px]:max-w-5xl">{children}</div>
      </div>
    </div>
  )
}
