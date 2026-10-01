import { z } from 'zod'

/**
 * URL state for the router page (plan §4.1): the summary strip's filter links. A junk value falls back to "all"
 * instead of throwing, so a stale link still opens the page.
 */
const ROUTER_SOURCES = ['attached', 'default', 'none'] as const
export type SourceFilter = (typeof ROUTER_SOURCES)[number]

export const routerSearchSchema = z.object({
  source: z.enum(ROUTER_SOURCES).optional().catch(undefined),
})
export type RouterSearch = z.infer<typeof routerSearchSchema>
