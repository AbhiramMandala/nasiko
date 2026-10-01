import { createFileRoute } from '@tanstack/react-router'
import { OverviewPage } from '@/features/overview/OverviewPage'
import { overviewSearchSchema, type OverviewSearch } from '@/features/overview/search'
import { useSetSearch } from '@/lib/search'

export const Route = createFileRoute('/_app/')({
  validateSearch: overviewSearchSchema,
  component: OverviewRoute,
})

function OverviewRoute() {
  const setSearch = useSetSearch<OverviewSearch>(Route.fullPath, true)
  return <OverviewPage search={Route.useSearch()} setSearch={setSearch} />
}
