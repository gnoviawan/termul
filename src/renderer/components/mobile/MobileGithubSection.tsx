import { lazy, Suspense } from 'react'
import { useColumnWorkingCopy } from '@/components/shell/use-column-working-copy'
import { useActiveProject } from '@/stores/project-store'

const GithubPanel = lazy(() =>
  import('@/components/github/GithubPanel').then((m) => ({ default: m.GithubPanel }))
)

/**
 * The drawer's GitHub section: the side panel's GitHub list for the active
 * project's working copy (its worktree pick, else the project folder).
 * `onNavigate` closes the drawer once an item or the sign-in terminal opens.
 */
export function MobileGithubSection({ onNavigate }: { onNavigate: () => void }): React.JSX.Element {
  const activeProject = useActiveProject()
  const { cwd } = useColumnWorkingCopy(activeProject)
  if (!activeProject || !cwd) {
    return (
      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
        Open a project to see its issues and pull requests.
      </p>
    )
  }
  return (
    <Suspense fallback={null}>
      <GithubPanel projectId={activeProject.id} cwd={cwd} onNavigate={onNavigate} />
    </Suspense>
  )
}
