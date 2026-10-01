/**
 * The sidebar's items (plans/feat-app-shell.md §3): one source for AppSidebar and its tests.
 * Only pages that exist get an item. Overview is `/`; Status (`/status`) is reached from the footer's status row.
 *
 * `shared` items carry the shared context (window, filters, compare) between them through
 * `pickShared` (src/app/shell/context.ts), as the old header nav did.
 */
import {
  Bot,
  DollarSign,
  Hammer,
  LayoutDashboard,
  ListTree,
  MessageSquare,
  Plug,
  Settings,
  SquareTerminal,
  Upload,
  Waypoints,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import type { AnyNavItem } from '../edition'
import { copy } from './copy'

export type NavGroupId = 'work' | 'observe' | 'manage' | 'lab'

/** In display order; the first group has no header. */
export const NAV_GROUPS: readonly { id: NavGroupId; label: string | null }[] = [
  { id: 'work', label: null },
  { id: 'observe', label: copy.nav.observe },
  { id: 'manage', label: copy.nav.manage },
  { id: 'lab', label: copy.nav.lab },
]

export interface NavItem {
  to:
    | '/'
    | '/chat'
    | '/agents'
    | '/deploy'
    | '/builds'
    | '/router'
    | '/mcp'
    | '/workflows'
    | '/sessions'
    | '/tokenops'
    | '/harnesses'
    | '/settings'
  label: string
  icon: LucideIcon
  group: NavGroupId
  shared: boolean
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: copy.nav.overview, icon: LayoutDashboard, group: 'work', shared: false },
  { to: '/chat', label: copy.nav.chat, icon: MessageSquare, group: 'work', shared: false },
  { to: '/agents', label: copy.nav.agents, icon: Bot, group: 'work', shared: false },
  // plans/feat-deploy.md §3 (design review 1): Deploy and Builds after Agents.
  { to: '/deploy', label: copy.nav.deploy, icon: Upload, group: 'work', shared: false },
  { to: '/builds', label: copy.nav.builds, icon: Hammer, group: 'work', shared: false },
  { to: '/router', label: copy.nav.router, icon: Waypoints, group: 'work', shared: false },
  // plans/feat-mcp.md §1: after LLM router (both configure what agents can call).
  { to: '/mcp', label: copy.nav.mcp, icon: Plug, group: 'work', shared: false },
  // plans/feat-workflows.md §1: after MCP servers; Drafts and Runs are its sub-pages (/workflows/*).
  { to: '/workflows', label: copy.nav.workflows, icon: Workflow, group: 'work', shared: false },
  { to: '/sessions', label: copy.nav.sessions, icon: ListTree, group: 'observe', shared: true },
  { to: '/tokenops', label: copy.nav.tokenops, icon: DollarSign, group: 'observe', shared: true },
  {
    to: '/harnesses',
    label: copy.nav.harnesses,
    icon: SquareTerminal,
    group: 'observe',
    shared: true,
  },
  // plans/feat-settings.md §1: last, as on the legacy rail. Its sub-pages (Secrets) are /settings/*.
  { to: '/settings', label: copy.nav.settings, icon: Settings, group: 'manage', shared: false },
]

/** The item for a pathname, including its sub-routes (`/agents/mine`, `/chat/<id>`); Overview only on `/` itself, none on `/status`. */
export function activeItem(
  pathname: string,
  items: readonly AnyNavItem[] = NAV_ITEMS,
): AnyNavItem | undefined {
  return items.find((n) => pathname === n.to || (n.to !== '/' && pathname.startsWith(`${n.to}/`)))
}
