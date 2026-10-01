/**
 * The page for an unknown URL (rendered outside the shell, so it gives a way back in). Its own module, loaded on
 * demand from `__root.tsx`: the root route isn't code-split, and every page would load it otherwise.
 */
import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { copy } from './copy'

export function NotFound() {
  return (
    <main className="mx-auto mt-16 max-w-sm px-4">
      {/* The Empty parts, not EmptyState: this page's title is its h1. */}
      <Empty className="gap-4 p-0 md:p-0">
        <EmptyHeader className="gap-1">
          <EmptyMedia className="mb-3">
            <img src="/mark-nasiko.svg" alt="" aria-hidden className="size-8" />
          </EmptyMedia>
          <EmptyTitle>
            <h1 className="font-semibold">{copy.notFound.title}</h1>
          </EmptyTitle>
          <EmptyDescription>{copy.notFound.body}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center gap-2">
          <Button asChild>
            <Link to="/chat">{copy.notFound.toChat}</Link>
          </Button>
          <Button asChild variant="outline">
            {/* TokenOps fills its own search defaults (zod .catch), as SessionTracePage links do. */}
            <Link to="/tokenops" search={{}}>
              {copy.notFound.toTokenops}
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  )
}
