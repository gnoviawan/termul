import { useReactFlow } from '@xyflow/react'
import {
  Hand,
  Maximize2,
  MousePointer2,
  Plus,
  Redo2,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { FlowEdit } from './flow-edit'

export type Tool = 'select' | 'pan'

type Control = {
  label: string
  Icon: typeof ZoomIn
  run: (event: React.MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  pressed?: boolean
}

/**
 * The floating toolbar, bottom centre. View mode: fit and zoom. Edit mode adds
 * the select and pan tools (desktop), undo, redo and delete.
 */
export function FlowToolbar({
  phone,
  edit,
  tool,
  onTool,
  canDelete,
  onDelete,
  onFit,
  onAdd
}: {
  phone: boolean
  edit: FlowEdit | undefined
  tool: Tool
  onTool: (tool: Tool) => void
  canDelete: boolean
  onDelete: () => void
  onFit: () => void
  /** Opens the add menu at the given viewport point. */
  onAdd: (screen: { x: number; y: number }) => void
}): React.JSX.Element {
  const flow = useReactFlow()
  const view: Control[] = [
    { label: 'Fit to view', Icon: Maximize2, run: onFit },
    { label: 'Zoom in', Icon: ZoomIn, run: () => void flow.zoomIn({ duration: 150 }) },
    { label: 'Zoom out', Icon: ZoomOut, run: () => void flow.zoomOut({ duration: 150 }) }
  ]
  const add: Control = {
    label: 'Add a step',
    Icon: Plus,
    // A step picked during Save could not be applied.
    disabled: edit?.locked,
    run: (event) => {
      const box = event.currentTarget.getBoundingClientRect()
      onAdd({ x: box.left, y: box.top })
    }
  }
  const groups: Control[][] = edit
    ? [
        phone
          ? [add]
          : [
              add,
              {
                label: 'Select',
                Icon: MousePointer2,
                run: () => onTool('select'),
                pressed: tool === 'select'
              },
              { label: 'Pan', Icon: Hand, run: () => onTool('pan'), pressed: tool === 'pan' }
            ],
        phone ? view.slice(0, 1) : view,
        [
          { label: 'Undo', Icon: Undo2, run: edit.undo, disabled: !edit.canUndo },
          { label: 'Redo', Icon: Redo2, run: edit.redo, disabled: !edit.canRedo }
        ],
        [{ label: 'Delete selected', Icon: Trash2, run: onDelete, disabled: !canDelete }]
      ]
    : [view]
  const size = phone ? 'touch' : 'icon-sm'
  return (
    <div
      role="toolbar"
      aria-label={edit ? 'Canvas tools' : 'Diagram view'}
      className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-border bg-popover p-1 shadow-lg"
    >
      {groups
        .filter((group) => group.length > 0)
        .map((group, index) => (
          <div
            key={group[0].label}
            className={cn(
              'flex items-center gap-0.5',
              index > 0 && 'border-l border-border pl-0.5'
            )}
          >
            {group.map(({ label, Icon, run, disabled, pressed }) => (
              <Button
                key={label}
                variant="ghost"
                size={size}
                className={cn(phone && 'w-11', pressed && 'keycap text-foreground')}
                aria-label={label}
                aria-pressed={pressed}
                title={label}
                disabled={disabled}
                onClick={(event) => run(event)}
              >
                <Icon size={16} />
              </Button>
            ))}
          </div>
        ))}
    </div>
  )
}
