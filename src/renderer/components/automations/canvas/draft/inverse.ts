import type { AutomationOp } from '@shared/types/automation.types'
import { applyOps, type DraftDoc } from './apply-op'

/** The ops that undo `op`, read against `doc`, the state just before it. */
function inverseOf(doc: DraftDoc, op: AutomationOp): AutomationOp[] {
  switch (op.op) {
    case 'add_node':
      return [{ op: 'remove_node', id: op.node.id }]
    case 'update_node': {
      const before = doc.graph.nodes.find((node) => node.id === op.id)
      if (!before) return []
      return [
        {
          op: 'update_node',
          id: op.id,
          ...(op.label === undefined ? {} : { label: before.label }),
          ...(op.spec === undefined ? {} : { spec: before.spec })
        }
      ]
    }
    case 'remove_node': {
      const before = doc.graph.nodes.find((node) => node.id === op.id)
      if (!before) return []
      // `remove_node` drops the node's edges too; put them back after it.
      return [
        { op: 'add_node', node: before },
        ...doc.graph.edges
          .filter((edge) => edge.from === op.id || edge.to === op.id)
          .map((edge): AutomationOp => ({ op: 'connect', edge }))
      ]
    }
    case 'connect':
      return [{ op: 'disconnect', edge: op.edge }]
    case 'disconnect':
      return [{ op: 'connect', edge: op.edge }]
    case 'set_trigger':
      return [{ op: 'set_trigger', trigger: doc.trigger }]
    case 'rename':
      return [{ op: 'rename', name: doc.name }]
    case 'set_isolation':
      return [{ op: 'set_isolation', isolation: doc.isolation }]
  }
}

/**
 * The ops that take the state after `ops` back to `doc`: each op's inverse,
 * read against the state it applied to, last op first. Null when `ops` does
 * not apply to `doc`.
 */
export function inverseOps(doc: DraftDoc, ops: readonly AutomationOp[]): AutomationOp[] | null {
  const undo: AutomationOp[][] = []
  let state = doc
  for (const op of ops) {
    const result = applyOps(state, [op])
    if (!result.ok) return null
    undo.unshift(inverseOf(state, op))
    state = result.doc
  }
  return undo.flat()
}
