import { ChevronDown, ChevronRight, Folder, MoreHorizontal } from '@/components/icons'
import { useRailCollapsed } from '@/components/shell/rail/rail-density'
import { RailTooltip } from '@/components/shell/rail-button'
import { RAIL_ICON_BOX_CLASS, RAIL_ROW_INSET_CLASS } from '@/components/shell/rail-layout'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { FIELD_FOCUS_CLASS, FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { getColorClasses } from '@/lib/colors'
import { cn } from '@/lib/utils'
import type { ProjectGroup } from '@/types/project'

export interface RailGroupRowProps {
  group: ProjectGroup
  isCollapsed: boolean
  isDragOver: boolean
  isEditing: boolean
  editName: string
  onEditNameChange: (name: string) => void
  onCommitRename: () => void
  onCancelRename: () => void
  onToggle: () => void
  onContextMenu: (e: React.MouseEvent) => void
  /** The group's context-menu content (rename, color, add project, delete). */
  menu: React.ReactNode
}

const HOVER_REVEAL = 'group-hover:inline-flex group-focus-within:inline-flex'

/**
 * Group row of the shell Rail. At rest the icon column shows the group's folder
 * icon (in the group colour); on hover or focus it becomes a chevron and a
 * `…` button appears at the end. An expanded group keeps its chevron. The row
 * is a button that toggles the group; the `…` button opens the same menu as a
 * right-click, so nothing is hover-only. On the collapsed Rail it is
 * {@link RailGroupIconRow}.
 */
export function RailGroupRow(props: RailGroupRowProps): React.JSX.Element {
  if (useRailCollapsed()) return <RailGroupIconRow {...props} />
  return <RailGroupLabelRow {...props} />
}

/**
 * Group row of the collapsed Rail (Sidebar V2): the expanded row's height
 * with only the folder icon (the chevron on hover or focus, always when the
 * group is open), centred. A click folds the group; right-click opens its
 * menu. The name is the button's accessible name.
 */
function RailGroupIconRow({
  group,
  isCollapsed,
  isDragOver,
  onToggle,
  onContextMenu,
  menu
}: RailGroupRowProps): React.JSX.Element {
  const Chevron = isCollapsed ? ChevronRight : ChevronDown
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          onContextMenu={onContextMenu}
          aria-expanded={!isCollapsed}
          aria-label={group.name}
          data-group-id={group.id}
          data-testid={`rail-group-row-${group.id}`}
          className={cn(
            'group flex h-8 w-full cursor-pointer select-none items-center justify-center rounded-lg',
            'transition-colors duration-150 ease-out',
            FOCUS_RING_CLASS,
            isDragOver
              ? 'bg-primary/10 ring-1 ring-inset ring-primary/60'
              : 'hover:bg-foreground/[0.06]'
          )}
        >
          <span
            className={cn(
              RAIL_ICON_BOX_CLASS,
              isCollapsed ? 'group-hover:hidden group-focus-visible:hidden' : 'hidden'
            )}
          >
            <Folder
              size={16}
              className={group.color ? getColorClasses(group.color).text : 'text-muted-foreground'}
            />
          </span>
          <span
            className={cn(
              RAIL_ICON_BOX_CLASS,
              'text-muted-foreground',
              isCollapsed
                ? 'hidden group-hover:inline-flex group-focus-visible:inline-flex'
                : 'inline-flex'
            )}
          >
            <Chevron size={12} />
          </span>
        </button>
      </ContextMenuTrigger>
      {menu}
    </ContextMenu>
  )
}

function RailGroupLabelRow({
  group,
  isCollapsed,
  isDragOver,
  isEditing,
  editName,
  onEditNameChange,
  onCommitRename,
  onCancelRename,
  onToggle,
  onContextMenu,
  menu
}: RailGroupRowProps): React.JSX.Element {
  const Chevron = isCollapsed ? ChevronRight : ChevronDown

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="group"
          aria-label={group.name}
          onContextMenu={onContextMenu}
          data-group-id={group.id}
          data-testid={`rail-group-row-${group.id}`}
          className={cn(
            'group relative flex h-8 w-full select-none items-center rounded-lg text-left text-xs',
            'transition-colors duration-150 ease-out',
            isDragOver
              ? 'bg-primary/10 ring-1 ring-inset ring-primary/60'
              : isCollapsed && 'hover:bg-foreground/[0.03]'
          )}
        >
          {isEditing ? (
            <div className={cn('flex h-full min-w-0 flex-1 items-center', RAIL_ROW_INSET_CLASS)}>
              <span data-rail-icon-column className={RAIL_ICON_BOX_CLASS} aria-hidden="true">
                <Chevron size={12} className="text-muted-foreground" />
              </span>
              <input
                type="text"
                value={editName}
                onChange={(e) => onEditNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCommitRename()
                  else if (e.key === 'Escape') onCancelRename()
                }}
                onBlur={onCommitRename}
                aria-label={`Rename group ${group.name}`}
                className={`h-6 min-w-0 flex-1 rounded border border-border bg-card px-1.5 text-xs pointer-coarse:text-base text-foreground ${FIELD_FOCUS_CLASS}`}
                // biome-ignore lint/a11y/noAutofocus: the inline rename input appears on request and must take focus
                autoFocus
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={!isCollapsed}
              className={cn(
                RAIL_ROW_INSET_CLASS,
                'flex h-full min-w-0 flex-1 cursor-pointer items-center rounded-lg pr-8 text-left',
                FOCUS_RING_CLASS
              )}
            >
              <span data-rail-icon-column className={RAIL_ICON_BOX_CLASS} aria-hidden="true">
                {/* At rest the group icon; hover or focus swaps in the chevron,
                    which an expanded group always shows. */}
                <span
                  data-rail-group-icon
                  className={cn(
                    RAIL_ICON_BOX_CLASS,
                    isCollapsed ? 'group-hover:hidden group-focus-within:hidden' : 'hidden'
                  )}
                >
                  <Folder
                    size={16}
                    className={
                      group.color ? getColorClasses(group.color).text : 'text-muted-foreground'
                    }
                  />
                </span>
                <span
                  data-rail-group-chevron
                  className={cn(
                    RAIL_ICON_BOX_CLASS,
                    'text-muted-foreground',
                    isCollapsed ? `hidden ${HOVER_REVEAL}` : 'inline-flex'
                  )}
                >
                  <Chevron size={12} />
                </span>
              </span>
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {group.name}
              </span>
            </button>
          )}
          {!isEditing && (
            <RailTooltip label="Group actions">
              <button
                type="button"
                aria-label={`Group actions for ${group.name}`}
                aria-haspopup="menu"
                onClick={(e) => {
                  // Same menu as a right-click, anchored under this button.
                  e.stopPropagation()
                  const rect = e.currentTarget.getBoundingClientRect()
                  e.currentTarget.closest('[data-group-id]')?.dispatchEvent(
                    new MouseEvent('contextmenu', {
                      bubbles: true,
                      cancelable: true,
                      clientX: rect.left,
                      clientY: rect.bottom
                    })
                  )
                }}
                className={cn(
                  'absolute right-1.5 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground',
                  'opacity-0 transition-colors duration-150 ease-out hover:bg-foreground/[0.03] hover:text-foreground',
                  'group-hover:opacity-100 group-focus-within:opacity-100',
                  FOCUS_RING_CLASS
                )}
              >
                <MoreHorizontal size={14} />
              </button>
            </RailTooltip>
          )}
        </div>
      </ContextMenuTrigger>
      {menu}
    </ContextMenu>
  )
}
