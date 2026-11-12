import { Handle, type NodeProps, Position } from '@xyflow/react'
import { memo } from 'react'
import { Plus } from '@/components/icons'
import { cn } from '@/lib/utils'
import { NodeCard } from '../nodes/NodeCard'
import { CARD, INPUT_PORT_Y, OUTPUT_PORTS, outputPortY, PORT_PRESENTATION, TRIGGER } from '../ports'
import { useFlowEdit } from './flow-edit'
import type { CardNode } from './flow-graph'

// 10 px on a mouse; 14 px on a touch screen, where a finger has to find it.
const HANDLE =
  'size-2.5 min-h-0 min-w-0 rounded-full border-2 border-current pointer-coarse:size-3.5'

export const CardNodeView = memo(function CardNodeView({
  id,
  data,
  selected
}: NodeProps<CardNode>): React.JSX.Element {
  const { editing, connecting, canTake, addFrom } = useFlowEdit()
  const ports = OUTPUT_PORTS[data.kind === TRIGGER ? TRIGGER : data.node.spec.kind]
  const fill = selected ? 'bg-muted' : 'bg-card'
  const source = connecting?.from === id
  const dimmed = connecting !== null && !source && !canTake(id)
  return (
    <NodeCard data={data} selected={selected} dimmed={dimmed}>
      {data.kind !== TRIGGER && (
        <Handle
          id="in"
          type="target"
          position={Position.Left}
          isConnectable={editing}
          isConnectableStart={false}
          aria-label={editing ? `Connect into ${data.node.label}` : undefined}
          className={cn(HANDLE, fill, 'text-muted-foreground')}
          style={{ top: INPUT_PORT_Y }}
        />
      )}
      {ports.map((port, index) => (
        <Handle
          key={port}
          id={port}
          type="source"
          position={Position.Right}
          isConnectable={editing}
          aria-label={editing ? `Connect from ${port}` : undefined}
          className={cn(
            HANDLE,
            fill,
            PORT_PRESENTATION[port].tone,
            source && connecting?.port === port && 'ring-2 ring-focus-ring'
          )}
          style={{ top: outputPortY(index, ports.length) }}
        />
      ))}
      {editing &&
        data.open.map((port) => {
          const index = ports.indexOf(port)
          return (
            <span
              key={`add-${port}`}
              className="nodrag nopan absolute flex -translate-y-1/2 items-center"
              style={{ left: CARD.width + 5, top: outputPortY(index, ports.length) }}
            >
              <span aria-hidden="true" className="h-px w-3 bg-field-border" />
              <button
                type="button"
                aria-label={`Add a step after ${data.kind === TRIGGER ? 'the trigger' : data.node.label}${port === 'out' ? '' : ` (${port})`}`}
                title="Add a step"
                onClick={(event) => {
                  event.stopPropagation()
                  const box = event.currentTarget.getBoundingClientRect()
                  addFrom(id as Parameters<typeof addFrom>[0], port, { x: box.right, y: box.top })
                }}
                className="grid size-[18px] place-items-center rounded-full border border-field-border bg-card text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:outline-none pointer-coarse:size-7"
              >
                <Plus size={12} />
              </button>
            </span>
          )
        })}
    </NodeCard>
  )
})
