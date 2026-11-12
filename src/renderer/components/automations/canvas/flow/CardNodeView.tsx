import { Handle, type NodeProps, Position } from '@xyflow/react'
import { memo } from 'react'
import { cn } from '@/lib/utils'
import { NodeCard } from '../nodes/NodeCard'
import { INPUT_PORT_Y, OUTPUT_PORTS, outputPortY, PORT_PRESENTATION, TRIGGER } from '../ports'
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
  const { editing, connecting, canTake } = useFlowEdit()
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
    </NodeCard>
  )
})
