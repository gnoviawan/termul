import { lazy, Suspense } from 'react'
import { ShellSkeleton } from '@/layouts/workspace-layout/ShellSkeleton'
import { useLastColumnTab } from '@/stores/shell-layout-store'
import type { Project } from '@/types/project'
import { ChangesPanel } from './ChangesPanel'
import { SidePanelHeader } from './SidePanelHeader'
import { useColumnWorkingCopy } from './use-column-working-copy'

const FileExplorer = lazy(() =>
  import('@/components/file-explorer/FileExplorer').then((m) => ({ default: m.FileExplorer }))
)

const GithubPanel = lazy(() =>
  import('@/components/github/GithubPanel').then((m) => ({ default: m.GithubPanel }))
)

interface SidePanelColumnProps {
  activeProject: Project
}

/**
 * Body of the right panel for a project: the view the tool strip picked
 * (Explorer, Changes or GitHub, remembered per project, Explorer by default)
 * under its Paper panel header. The Explorer draws that header itself
 * (`ExplorerHeader`), because its actions need the explorer's state. Mounted
 * through `ExplorerColumn`'s `sidePanel` slot, never in SSH mode.
 */
export function SidePanelColumn({ activeProject }: SidePanelColumnProps): React.JSX.Element {
  const projectId = activeProject.id
  const { cwd } = useColumnWorkingCopy(activeProject)
  const selected = useLastColumnTab(projectId) ?? 'explorer'

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col" data-view={selected}>
      {selected === 'explorer' && (
        <Suspense fallback={<ShellSkeleton />}>
          <FileExplorer />
        </Suspense>
      )}
      {selected === 'changes' && (
        <>
          <SidePanelHeader title="Changes" />
          <ChangesPanel cwd={cwd} isVisible />
        </>
      )}
      {selected === 'github' && (
        <>
          <SidePanelHeader title="GitHub" />
          <Suspense fallback={<ShellSkeleton />}>
            <GithubPanel projectId={projectId} cwd={cwd} />
          </Suspense>
        </>
      )}
    </div>
  )
}
