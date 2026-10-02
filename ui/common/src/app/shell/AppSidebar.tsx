/**
 * The app's left sidebar (plans/feat-app-shell.md §3–§4): the Nasiko header, the nav groups from
 * `nav.ts`, and the footer (status, theme, account, collapse). Built on shadcn's sidebar primitive.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import {
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  CircleUser,
  LogOut,
  KeyRound,
  RotateCw,
} from 'lucide-react'
import { use, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { deferred } from '@/app/deferred'
import { applyNav } from '@/app/edition'
import { EditionContext } from '@/app/edition-context'
import { meQuery } from '@/lib/api/auth'
import { ApiError } from '@/lib/api/client'
import { SIDEBAR_HEALTH_INTERVAL_MS, useHealth } from '@/lib/api/health'
import { env } from '@/lib/env'
import { cn } from '@/lib/utils'
import { pickShared } from './context'
import { copy } from './copy'
import { NasikoMark } from './NasikoMark'
import { activeItem, NAV_GROUPS, NAV_ITEMS } from './nav'
import { ACTIVE_ROW, GROUP, LABEL, ROW } from './rowStyles'
import { signOut } from './signOut'
import { ThemeMenu } from './ThemeMenu'

// Loads on first open: the shell budget has no room for the dialog and its form.
const ChangePasswordDialog = deferred(() =>
  import('./ChangePasswordDialog').then((m) => m.ChangePasswordDialog),
)

/** How long a pending health check stays quiet before "Checking…" shows (design review 2A). */
const CHECKING_DELAY_MS = 1_000

/** A count on a nav item, with the words a screen reader hears after its label (the Builds item: builds in progress). */
export type NavBadges = Partial<Record<string, { count: number; label: string }>>

export function AppSidebar({ badges }: { badges?: NavBadges } = {}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const navigate = useNavigate()
  const { setOpenMobile } = useSidebar()
  // The phone sheet closes on navigation (§4.2).
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile])

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className={cn(GROUP, 'py-3')}>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip={copy.brandTooltip}
              className={cn(ROW, 'font-semibold')}
            >
              {/* A plain link: TanStack's Link would mark it aria-current on /chat, doubling the
                  nav's Chat item (§3 rule 4: one current item). */}
              <a
                href="/chat"
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                  e.preventDefault()
                  void navigate({ to: '/chat' })
                }}
              >
                <NasikoMark className="size-4 shrink-0 text-logo" />
                <span className={LABEL}>{copy.brand}</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <NavGroups pathname={pathname} badges={badges} />
      <SidebarFooter className={cn(GROUP, 'gap-0 border-t border-sidebar-border py-2')}>
        <SidebarMenu>
          <StatusRow />
          <ThemeMenu />
          <AccountMenu />
          <CollapseRow />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

/** The scrolling middle (§4.2a): header and footer stay pinned; a soft fade marks hidden items. */
function NavGroups({ pathname, badges }: { pathname: string; badges?: NavBadges }) {
  // A layer's nav patches (EE: Lab → Weave fixtures) apply on top of the core's items.
  const items = applyNav(NAV_ITEMS, use(EditionContext).edition.layers)
  const active = activeItem(pathname, items)
  const { setOpenMobile } = useSidebar()
  const scroller = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ top: false, bottom: false })
  const measure = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const top = el.scrollTop > 0
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1
    // Unchanged edges: keep the same object so scrolling doesn't re-render every row.
    setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }))
  }, [])
  // Measure on mount and whenever the window or the rail changes size, not only on scroll.
  useLayoutEffect(() => {
    measure()
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])
  return (
    <nav aria-label={copy.navLabel} className="flex min-h-0 flex-1 flex-col">
      <SidebarContent
        ref={scroller}
        onScroll={measure}
        className={cn(
          // py-1 leaves room for the first and last rows' focus ring; the rail scrolls too (§4.2a).
          '[scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] gap-0 py-1 group-data-[collapsible=icon]:overflow-auto',
          edges.top && edges.bottom
            ? '[mask-image:linear-gradient(to_bottom,transparent,black_16px,black_calc(100%-16px),transparent)]'
            : edges.top
              ? '[mask-image:linear-gradient(to_bottom,transparent,black_16px)]'
              : edges.bottom
                ? '[mask-image:linear-gradient(to_top,transparent,black_16px)]'
                : undefined,
        )}
      >
        {/* A group with no items (Lab, in a production build) has no header either. */}
        {NAV_GROUPS.filter((g) => items.some((n) => n.group === g.id)).map((g) => (
          <SidebarGroup key={g.id} className={cn(GROUP, 'py-0')}>
            {/* In the rail the header fades but keeps its space, so groups stay visibly apart. */}
            {g.label ? (
              <SidebarGroupLabel className="mt-5 mb-1 h-4 px-2 text-2xs font-medium tracking-[0.04em] text-muted-foreground uppercase group-data-[collapsible=icon]:mt-5">
                {g.label}
              </SidebarGroupLabel>
            ) : null}
            <SidebarMenu>
              {items
                .filter((n) => n.group === g.id)
                .map((n) => (
                  <SidebarMenuItem key={n.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={active?.to === n.to}
                      tooltip={n.label}
                      className={cn(ROW, ACTIVE_ROW)}
                    >
                      <Link
                        to={n.to}
                        search={
                          n.shared ? (prev: Record<string, unknown>) => pickShared(prev) : undefined
                        }
                        // `/` is a prefix of every path: Overview is active only on `/` itself.
                        activeOptions={{ includeSearch: false, exact: n.to === '/' }}
                        // Same-path links (the current page) don't change the pathname: close the sheet here too.
                        onClick={() => setOpenMobile(false)}
                      >
                        <n.icon aria-hidden />
                        <span className={LABEL}>{n.label}</span>
                        {badges?.[n.to] ? (
                          <span className="sr-only">, {badges[n.to]?.label}</span>
                        ) : null}
                      </Link>
                    </SidebarMenuButton>
                    {/* e.g. Builds started this session and still running (plans/feat-deploy.md §5, design review 8). */}
                    {badges?.[n.to] ? (
                      <SidebarMenuBadge aria-hidden data-testid={`nav-count-${n.to.slice(1)}`}>
                        {badges[n.to]?.count}
                      </SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </nav>
  )
}

/** Connection state plus the mock/live badge; links to the Status page (§3 rule 6). */
function StatusRow() {
  // On every page and in every tab: a slower check, and none on window focus (review, performance).
  const health = useHealth({
    refetchInterval: SIDEBAR_HEALTH_INTERVAL_MS,
    refetchOnWindowFocus: false,
  })
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!health.isPending) return
    const t = setTimeout(() => setSlow(true), CHECKING_DELAY_MS)
    return () => clearTimeout(t)
  }, [health.isPending])
  const state = health.isError
    ? 'unreachable'
    : health.isSuccess
      ? 'connected'
      : slow
        ? 'checking'
        : 'quiet'
  const text =
    state === 'unreachable'
      ? copy.status.unreachable
      : state === 'connected'
        ? copy.status.connected
        : state === 'checking'
          ? copy.status.checking
          : ''
  const mock = env.mode === 'mock'
  const badge = mock ? copy.status.mockBadge : copy.status.liveBadge
  const badgeTitle = mock ? copy.status.mockTitle : copy.status.liveTitle(env.partialMocks)
  const tooltip = [state === 'unreachable' ? copy.status.unreachableHint : text, badge]
    .filter(Boolean)
    .join(' · ')
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip={tooltip} className={cn(ROW, 'relative')}>
        <Link
          to="/status"
          activeOptions={{ exact: true, includeSearch: false }}
          data-testid="status-row"
          data-state={state}
        >
          <span className="relative flex size-4 shrink-0 items-center justify-center" aria-hidden>
            <span
              className={cn(
                'size-2 rounded-full',
                state === 'connected'
                  ? 'bg-success'
                  : state === 'unreachable'
                    ? 'bg-destructive'
                    : 'bg-muted-foreground/50',
              )}
            />
            {state === 'unreachable' ? (
              <CircleAlert className="absolute -top-1 -right-1.5 size-2.5! text-destructive" />
            ) : null}
          </span>
          <span className={cn(LABEL, 'flex min-w-0 flex-1 items-center gap-2')}>
            {state === 'unreachable' ? (
              <span className="truncate">
                <span className="sr-only">{copy.status.unreachable}</span>
                <span aria-hidden>{copy.status.unreachableShort}</span>
              </span>
            ) : (
              <span className="truncate">{text}</span>
            )}
            <span
              title={badgeTitle}
              className={cn(
                'ml-auto shrink-0 rounded-sm border px-1 text-3xs leading-4 font-medium',
                mock ? 'border-warning/50 text-warning' : 'border-border text-muted-foreground',
              )}
            >
              {badge}
            </span>
          </span>
          {/* The rail's one-letter mode badge; the label (with the full badge) is hidden there. */}
          <span
            aria-hidden
            className={cn(
              'absolute right-0.5 bottom-0.5 hidden text-4xs leading-none font-semibold group-data-[collapsible=icon]:block',
              mock ? 'text-warning' : 'text-muted-foreground',
            )}
          >
            {mock ? copy.status.mockShort : copy.status.liveShort}
          </span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/**
 * The signed-in user, or "Account unavailable" when /api/me failed with a non-401 (eng D7). While `me`
 * reloads (the cache was reset under a mounted shell) the row says "Loading account…": not an
 * error, and Sign out is disabled until `me` loads, because signing out without a known user would
 * clear every user's drafts (review, red team).
 */
function AccountMenu() {
  // The _app guard already loaded `me`; this only reads it (and refetches on Retry).
  const me = useQuery({ ...meQuery, refetchOnMount: false, retryOnMount: false })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const router = useRouter()
  const { isMobile } = useSidebar()
  const [busy, setBusy] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const name = me.data?.username
  const loading = !name && !me.isError
  const label = name ?? (loading ? copy.account.loading : copy.account.unavailable)
  const run = async () => {
    if (busy) return
    setBusy(true)
    try {
      await signOut({ queryClient, userId: me.data?.sub, navigate: (to) => navigate(to) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            tooltip={label}
            aria-label={name ? copy.account.menu(name) : label}
            className={ROW}
          >
            {name ? (
              <CircleUser aria-hidden />
            ) : loading ? (
              <CircleUser aria-hidden className="text-muted-foreground" />
            ) : (
              <CircleAlert aria-hidden className="text-warning" />
            )}
            <span className={cn(LABEL, loading && 'text-muted-foreground')}>{label}</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={isMobile ? 'top' : 'right'}
          align="end"
          sideOffset={16}
          className="w-48"
        >
          {/* Says why Sign out is greyed out, instead of a menu with nothing to do. */}
          {loading ? (
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {copy.account.loadingHint}
            </DropdownMenuLabel>
          ) : null}
          {me.isError && !name ? (
            <DropdownMenuItem
              onSelect={() =>
                void me.refetch().then((r) => {
                  // The guard ignores a first-load 401 on `me`; here it means the session is gone.
                  if (r.error instanceof ApiError && r.error.status === 401) {
                    // The router's location, not window.location: they differ under memory history (tests,
                    // embeds). Read on click, so the menu doesn't re-render on every URL change.
                    void navigate({
                      to: '/login',
                      search: { redirect: router.state.location.href, expired: true },
                    })
                  }
                })
              }
            >
              <RotateCw aria-hidden /> {copy.account.retry}
            </DropdownMenuItem>
          ) : null}
          {me.data ? (
            <DropdownMenuItem onSelect={() => setChangingPassword(true)}>
              <KeyRound aria-hidden /> {copy.account.changePassword}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            disabled={busy || loading}
            onSelect={(e) => {
              // Keep the menu open so "Signing out…" is visible until the page changes.
              e.preventDefault()
              void run()
            }}
          >
            <LogOut aria-hidden /> {busy ? copy.account.signingOut : copy.account.signOut}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {changingPassword && me.data ? (
        <ChangePasswordDialog me={me.data} onClose={() => setChangingPassword(false)} />
      ) : null}
    </SidebarMenuItem>
  )
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

function CollapseRow() {
  const { state, toggleSidebar, isMobile } = useSidebar()
  if (isMobile) return null
  const collapsed = state === 'collapsed'
  const shortcut = copy.collapseShortcut(IS_MAC)
  const label = collapsed ? copy.expand : copy.collapse
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={toggleSidebar}
        tooltip={`${label} (${shortcut})`}
        aria-label={label}
        aria-keyshortcuts={IS_MAC ? 'Meta+B' : 'Control+B'}
        className={ROW}
      >
        {collapsed ? <ChevronsRight aria-hidden /> : <ChevronsLeft aria-hidden />}
        <span className={cn(LABEL, 'flex flex-1 items-center justify-between')}>
          {label}
          <kbd className="text-2xs font-normal text-muted-foreground">{shortcut}</kbd>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
