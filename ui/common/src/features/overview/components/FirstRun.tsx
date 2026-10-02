/**
 * First run (design review 7A): no agents yet, so one full-width card with the Agents first-run commands (checked
 * against recorded CLI help) replaces the data cards, whose queries don't run. Deploy an agent comes first, the CLI steps
 * are the alternative (plans/feat-deploy.md §7).
 */
import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { FirstRunSteps } from '@/features/agents/components/bits'
import { DeployAgentButton } from '@/features/deploy/components/DeployAgentButton'
import { copy as deployCopy } from '@/features/deploy/copy'
import { copy } from '../copy'
import { Card, TOUCH } from './Card'

export function FirstRun() {
  return (
    <Card
      id="overview-first-run"
      title={copy.firstRun.title}
      to="/agents"
      linkLabel={copy.firstRun.link}
      className="@[700px]:col-span-2 @[1100px]:col-span-3"
    >
      <DeployAgentButton size="default" className={TOUCH} />
      <p className="mt-4 mb-2 text-xs text-muted-foreground">{deployCopy.entry.orCli}</p>
      <FirstRunSteps />
      <p className="mt-3 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {copy.firstRun.after}{' '}
        <Button asChild variant="link" size="sm" className={`h-auto px-0 text-xs ${TOUCH}`}>
          <Link to="/agents">{copy.firstRun.link}</Link>
        </Button>
      </p>
    </Card>
  )
}
