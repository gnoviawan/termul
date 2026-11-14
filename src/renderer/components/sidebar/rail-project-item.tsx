import { memo } from 'react'
import { useProjectDiffStat } from '../shell/ProjectDiffStat'
import { useRailCollapsed } from '../shell/rail/rail-density'
import { RailWorktreeChip, RailWorktreeSwitcher } from '../shell/rail/worktree-switcher'
import { ProjectIconItem } from './project-icon-item'
import { ProjectItem, type ProjectItemProps } from './project-item'

/**
 * Project row of the shell Rail: the project row plus its uncommitted diff
 * stat. The row watches its working copy in the git-status store while mounted
 * and shows nothing when there is no stat to show. On the collapsed Rail it
 * is the icon-only row with the project card on hover. Under the row, the
 * picked worktree chip; the row anchors the worktree switcher.
 */
export const RailProjectItem = memo(function RailProjectItem(
  props: Omit<ProjectItemProps, 'diffStat'>
): React.JSX.Element {
  const diffStat = useProjectDiffStat(props.project, true)
  const collapsed = useRailCollapsed()
  return (
    <RailWorktreeSwitcher project={props.project} side={collapsed ? 'right' : 'bottom'}>
      {collapsed ? (
        <ProjectIconItem
          project={props.project}
          isActive={props.isActive}
          onClick={props.onClick}
          onContextMenu={props.onContextMenu}
          renderContextMenu={props.renderContextMenu}
          diffStat={diffStat}
        />
      ) : (
        <ProjectItem {...props} diffStat={diffStat} />
      )}
      <RailWorktreeChip project={props.project} collapsed={collapsed} />
    </RailWorktreeSwitcher>
  )
})
