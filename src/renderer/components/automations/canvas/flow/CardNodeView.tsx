import { Handle, type NodeProps, Position } from '@xyflow/react'
import { memo } from 'react'
import { cn } from '@/lib/utils'
import { NodeCard } from '../nodes/NodeCard'
import { INPUT_PORT_Y, OUTPUT_PORTS, outputPortY, PORT_PRESENTATION, TRIGGER } from '../ports'
import type { CardNode } from './flow-graph'

const HANDLE = 'size-2.5 min-h-0 min-w-0 rounded-full border-2 border-current'

export const CardNodeView = memo(function CardNodeView({
  data,
  selected
}: NodeProps<CardNode>): React.JSX.Element {
  const ports = OUTPUT_PORTS[data.kind === TRIGGER ? TRIGGER : data.node.spec.kind]
  const fill = selected ? 'bg-muted' : 'bg-card'
  return (
    <NodeCard data={data} selected={selected}>
      {data.kind !== TRIGGER && (
        <Handle
          id="in"
          type="target"
          position={Position.Left}
          isConnectable={false}
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
          isConnectable={false}
          className={cn(HANDLE, fill, PORT_PRESENTATION[port].tone)}
          style={{ top: outputPortY(index, ports.length) }}
        />
      ))}
    </NodeCard>
  )
})
