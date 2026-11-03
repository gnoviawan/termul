import { describe, expect, it } from 'vitest'
import {
  parseApprovalOutput,
  parseAutomation,
  parseRun,
  parseStepList,
  WireShapeError
} from '../automation-wire'

const GRAPH = {
  nodes: [
    {
      id: 'gate',
      label: 'Ship it?',
      spec: { kind: 'approval', message: 'Deploy {{trigger.kind}}?', timeout_ms: 3_600_000 }
    }
  ],
  edges: [{ from: 'trigger', port: 'out', to: 'gate' }]
}

const RUN = {
  id: 'run-3',
  automation_id: 'auto-1',
  revision: 2,
  graph: GRAPH,
  trigger: 'manual',
  scheduled_for: 1_000,
  status: 'waiting',
  started_at: 1_100,
  finished_at: null,
  stop_reason: null,
  summary: null,
  conversation_id: null,
  worktree_id: null,
  parked: { node_id: 'gate', until: 3_601_100 }
}

function shapeError(parse: () => unknown): string {
  try {
    parse()
  } catch (err) {
    if (err instanceof WireShapeError) return err.message
    throw err
  }
  return 'parsed'
}

describe('automation wire: approval shapes', () => {
  it('parses an approval node spec', () => {
    const automation = parseAutomation({
      id: 'auto-1',
      project_id: 'p1',
      name: 'Deploy',
      revision: 2,
      approved_revision: 2,
      enabled: true,
      trigger: { kind: 'manual' },
      graph: GRAPH,
      isolation: 'shared_in_root',
      next_run_at: null,
      consecutive_errors: 0,
      schedule_error_count: 0,
      unseen_failures: 0,
      last_run: null,
      created_at: 1,
      updated_at: 1,
      deleted_at: null
    })

    expect(automation.graph.nodes[0].spec).toEqual({
      kind: 'approval',
      message: 'Deploy {{trigger.kind}}?',
      timeout_ms: 3_600_000
    })
  })

  it('rejects an approval node without a numeric timeout', () => {
    const graph = {
      ...GRAPH,
      nodes: [{ ...GRAPH.nodes[0], spec: { kind: 'approval', message: 'ok?', timeout_ms: '1h' } }]
    }

    expect(shapeError(() => parseRun({ ...RUN, graph }))).toBe(
      'run.graph.nodes[0].spec.timeout_ms: expected a number'
    )
  })

  it('parses a waiting run with where it is parked', () => {
    const run = parseRun(RUN)

    expect(run.status).toBe('waiting')
    expect(run.parked).toEqual({ node_id: 'gate', until: 3_601_100 })
  })

  it('reads a missing parked field on a settled run as null', () => {
    const { parked: _, ...settled } = { ...RUN, status: 'succeeded', finished_at: 2_000 }

    expect(parseRun(settled).parked).toBeNull()
    expect(parseRun({ ...settled, parked: null }).status).toBe('succeeded')
  })

  it('rejects a waiting run that is not parked, and a parked run that is not waiting', () => {
    expect(shapeError(() => parseRun({ ...RUN, parked: null }))).toBe(
      'run.parked: expected a parked node'
    )
    expect(shapeError(() => parseRun({ ...RUN, status: 'running' }))).toBe(
      'run.parked: expected null unless waiting'
    )
    expect(shapeError(() => parseRun({ ...RUN, parked: { node_id: 'gate' } }))).toBe(
      'run.parked.until: expected a number'
    )
  })

  it('parses a waiting step', () => {
    const [step] = parseStepList([
      {
        run_id: 'run-3',
        node_id: 'gate',
        status: 'waiting',
        output: { message: 'Deploy manual?' },
        error: null,
        started_at: 1_200,
        finished_at: null
      }
    ])

    expect(step.status).toBe('waiting')
    expect(step.output).toEqual({ message: 'Deploy manual?' })
  })

  it('reads an approval output before and after the decision', () => {
    expect(parseApprovalOutput({ message: 'Deploy manual?' })).toEqual({
      message: 'Deploy manual?'
    })
    expect(
      parseApprovalOutput({ message: 'Deploy manual?', decision: 'timed_out', decided_at: 9 })
    ).toEqual({ message: 'Deploy manual?', decision: 'timed_out', decided_at: 9 })
  })

  it('reads any other output as no approval detail', () => {
    expect(parseApprovalOutput(null)).toBeNull()
    expect(parseApprovalOutput({ items: [] })).toBeNull()
    expect(parseApprovalOutput({ message: 'x', decision: 'maybe', decided_at: 9 })).toBeNull()
    expect(parseApprovalOutput({ message: 'x', decision: 'approved' })).toBeNull()
  })
})
