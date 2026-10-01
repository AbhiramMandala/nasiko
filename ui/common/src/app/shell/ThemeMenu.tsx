/**
 * The sidebar footer's Theme menu (plans/feat-app-shell.md §5.1, §4.3): a "Mode" radio group
 * (System, Light, Dark) and a "Theme" radio group (Teal, Indigo, Plum). Each theme shows its name
 * beside the swatch, and the selected one has the radio indicator, so the choice never depends on
 * colour alone.
 */
import { Palette } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import {
  ACCENTS,
  setAccent,
  setTheme,
  THEMES,
  useThemePrefs,
  type Accent,
  type Theme,
} from './theme'
import { copy } from './copy'
import { LABEL, ROW } from './rowStyles'

export function ThemeMenu() {
  const prefs = useThemePrefs()
  const { isMobile } = useSidebar()
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton tooltip={copy.theme.menu} className={ROW}>
            <Palette aria-hidden />
            <span className={LABEL}>{copy.theme.menu}</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={isMobile ? 'top' : 'right'}
          align="end"
          sideOffset={16}
          className="w-56"
        >
          <DropdownMenuLabel id="theme-group-label" className="text-xs text-muted-foreground">
            {copy.theme.themeGroup}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            aria-labelledby="theme-group-label"
            value={prefs.theme}
            onValueChange={(v) => setTheme(v as Theme)}
          >
            {THEMES.map((t) => (
              <DropdownMenuRadioItem key={t.id} value={t.id} onSelect={(e) => e.preventDefault()}>
                {t.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel id="accent-group-label" className="text-xs text-muted-foreground">
            {copy.theme.accentGroup}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            aria-labelledby="accent-group-label"
            value={prefs.accent}
            onValueChange={(v) => setAccent(v as Accent)}
          >
            {ACCENTS.map((a) => (
              <DropdownMenuRadioItem key={a.id} value={a.id} onSelect={(e) => e.preventDefault()}>
                <span
                  aria-hidden
                  className="size-3 shrink-0 rounded-full border border-border"
                  style={{ background: a.swatch }}
                />
                {a.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}
