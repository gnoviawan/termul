import { describe, expect, it } from 'vitest'
import wire from './__fixtures__/automation.json'
import type {
  ApplyOpsResult,
  Automation,
  AutomationOp,
  AutomationRun,
  AutomationStep,
  AutomationSuggestion,
  Graph,
  RunPolicy,
  Trigger
} from './automation.types'

type WireFixture = {
  automation: Automation
  triggers: Trigger[]
  ops: AutomationOp[]
  apply_ops_result: ApplyOpsResult
  runs: AutomationRun[]
  steps: AutomationStep[]
  run_policy: RunPolicy
  suggestion: AutomationSuggestion
}

// Literal ids cannot carry a brand, so the literal is checked against the
// same shape with brands erased; every other field and tag stays exact.
type Unbranded<T> = T extends string & { readonly __brand: string }
  ? string
  : T extends (infer U)[]
    ? Unbranded<U>[]
    : T extends object
      ? { [K in keyof T]: Unbranded<T[K]> }
      : T

const runGraph: Unbranded<Graph> = {
  nodes: [
    {
      id: 'each',
      label: 'Each item',
      spec: { kind: 'for_each', items: '{{trigger.kind}}', max_iterations: 5 }
    },
    {
      id: 'body',
      label: 'Body',
      spec: {
        kind: 'transform',
        fields: [
          { name: 'item', value: '{{nodes.each.item.name}}' },
          { name: 'index', value: '{{nodes.each.index}}' }
        ]
      }
    },
    { id: 'join', label: 'Join', spec: { kind: 'merge', mode: 'any' } },
    { id: 'pause', label: 'Pause', spec: { kind: 'wait', duration_ms: 3600000 } },
    { id: 'stop', label: 'Stop', spec: { kind: 'fail', message: '{{trigger.kind}}' } }
  ],
  edges: [
    { from: 'trigger', port: 'out', to: 'each' },
    { from: 'each', port: 'item', to: 'body' },
    { from: 'each', port: 'out', to: 'join' },
    { from: 'each', port: 'error', to: 'join' },
    { from: 'join', port: 'out', to: 'pause' },
    { from: 'pause', port: 'out', to: 'stop' }
  ]
}

const typed: Unbranded<WireFixture> = {
  automation: {
    id: 'auto-1',
    project_id: 'project-1',
    name: 'Morning digest',
    revision: 1,
    approved_revision: 1,
    enabled: true,
    trigger: {
      kind: 'schedule',
      schedule: {
        kind: 'cron',
        expr: '0 5 * * 1-5',
        timezone: 'America/New_York'
      }
    },
    graph: {
      nodes: [
        {
          id: 'fetch',
          label: 'Fetch items',
          spec: {
            kind: 'http',
            method: 'GET',
            url: 'https://api.example.com/items?since={{trigger.scheduled_for}}',
            headers: [
              {
                name: 'Authorization',
                value: 'Bearer {{secrets.API_KEY}}'
              }
            ],
            body: null,
            allowed_hosts: ['api.example.com']
          }
        },
        {
          id: 'extract',
          label: 'Extract',
          spec: {
            kind: 'agent',
            agent_id: 'claude',
            model: 'sonnet',
            prompt: 'Summarize {{nodes.fetch.output.items}}',
            output_schema: {
              type: 'object',
              properties: {
                summary: {
                  type: 'string'
                },
                urgent: {
                  type: 'boolean'
                }
              },
              required: ['summary', 'urgent']
            },
            timeout_ms: 120000,
            max_attempts: 2
          }
        },
        {
          id: 'check',
          label: 'Urgent?',
          spec: {
            kind: 'condition',
            left: '{{nodes.extract.output.urgent}}',
            op: 'eq',
            right: 'true'
          }
        },
        {
          id: 'shape',
          label: 'Shape',
          spec: {
            kind: 'transform',
            fields: [
              {
                name: 'text',
                value: '{{nodes.extract.output.summary}}'
              }
            ]
          }
        },
        {
          id: 'post',
          label: 'Notify',
          spec: {
            kind: 'http',
            method: 'POST',
            url: 'https://hooks.example.com/notify',
            headers: [
              {
                name: 'X-Key',
                value: '{{secrets.HOOK_KEY}}'
              }
            ],
            body: '{{nodes.shape.output}}',
            allowed_hosts: ['hooks.example.com']
          }
        },
        {
          id: 'alert',
          label: 'Fetch failed',
          spec: {
            kind: 'fail',
            message: 'fetch failed'
          }
        }
      ],
      edges: [
        {
          from: 'trigger',
          port: 'out',
          to: 'fetch'
        },
        {
          from: 'fetch',
          port: 'out',
          to: 'extract'
        },
        {
          from: 'fetch',
          port: 'error',
          to: 'alert'
        },
        {
          from: 'extract',
          port: 'out',
          to: 'check'
        },
        {
          from: 'check',
          port: 'true',
          to: 'shape'
        },
        {
          from: 'shape',
          port: 'out',
          to: 'post'
        }
      ]
    },
    isolation: 'shared_in_root',
    next_run_at: 1773046800000,
    consecutive_errors: 1,
    schedule_error_count: 0,
    unseen_failures: 2,
    last_run: {
      run_id: 'run-1',
      status: 'failed',
      finished_at: 1773046860000
    },
    created_at: 1000,
    updated_at: 1000,
    deleted_at: null
  },
  triggers: [
    {
      kind: 'manual'
    },
    {
      kind: 'schedule',
      schedule: {
        kind: 'cron',
        expr: '0 5 * * 1-5',
        timezone: 'America/New_York'
      }
    },
    {
      kind: 'schedule',
      schedule: {
        kind: 'every',
        every_ms: 900000,
        anchor_ms: 0
      }
    },
    {
      kind: 'schedule',
      schedule: {
        kind: 'at',
        at: 1773046800000
      }
    }
  ],
  ops: [
    {
      op: 'add_node',
      node: {
        id: 'note',
        label: 'Note',
        spec: {
          kind: 'transform',
          fields: [
            {
              name: 'text',
              value: 'hi'
            }
          ]
        }
      }
    },
    {
      op: 'update_node',
      id: 'note',
      label: 'Renamed'
    },
    {
      op: 'update_node',
      id: 'check',
      spec: {
        kind: 'condition',
        left: '{{nodes.extract.output.urgent}}',
        op: 'exists',
        right: null
      }
    },
    {
      op: 'add_node',
      node: {
        id: 'lookup',
        label: 'Lookup',
        spec: {
          kind: 'mcp_tool',
          server_id: 'srv-github',
          tool: 'search',
          arguments: [],
          timeout_ms: 60000
        }
      }
    },
    {
      op: 'remove_node',
      id: 'note'
    },
    {
      op: 'add_node',
      node: { id: 'gate', label: 'Gate', spec: { kind: 'merge', mode: 'all' } }
    },
    {
      op: 'connect',
      edge: {
        from: 'check',
        port: 'false',
        to: 'alert'
      }
    },
    {
      op: 'disconnect',
      edge: {
        from: 'check',
        port: 'false',
        to: 'alert'
      }
    },
    {
      op: 'set_trigger',
      trigger: {
        kind: 'manual'
      }
    },
    {
      op: 'rename',
      name: 'Digest'
    },
    {
      op: 'set_isolation',
      isolation: 'worktree_per_run'
    }
  ],
  apply_ops_result: {
    automation: {
      id: 'auto-2',
      project_id: 'project-1',
      name: 'Draft',
      revision: 1,
      approved_revision: null,
      enabled: true,
      trigger: {
        kind: 'manual'
      },
      graph: {
        nodes: [],
        edges: []
      },
      isolation: 'worktree_per_run',
      next_run_at: null,
      consecutive_errors: 0,
      schedule_error_count: 0,
      unseen_failures: 0,
      last_run: null,
      created_at: 1000,
      updated_at: 1000,
      deleted_at: null
    },
    issues: [
      {
        node_id: null,
        code: 'trigger_edge_count',
        message: 'expected exactly one edge from trigger, found 0'
      }
    ]
  },
  runs: [
    {
      id: 'run-1',
      automation_id: 'auto-1',
      revision: 1,
      graph: runGraph,
      trigger: 'scheduled',
      scheduled_for: 1773046800000,
      status: 'failed',
      started_at: 1773046800100,
      finished_at: 1773046860000,
      stop_reason: 'node post failed',
      summary: null,
      conversation_id: null,
      worktree_id: 'wt-1'
    },
    {
      id: 'run-2',
      automation_id: 'auto-1',
      revision: 1,
      graph: runGraph,
      trigger: 'catch_up',
      scheduled_for: 1773046800000,
      status: 'running',
      started_at: 1773046800100,
      finished_at: null,
      stop_reason: null,
      summary: null,
      conversation_id: null,
      worktree_id: null
    }
  ],
  steps: [
    {
      run_id: 'run-1',
      node_id: 'fetch',
      iteration: null,
      status: 'succeeded',
      output: {
        items: [
          {
            title: 'first'
          }
        ]
      },
      error: null,
      started_at: 1773046800200,
      finished_at: 1773046801000,
      wait_until: null
    },
    {
      run_id: 'run-1',
      node_id: 'post',
      iteration: null,
      status: 'failed',
      output: null,
      error: 'secret_missing:HOOK_KEY',
      started_at: 1773046859000,
      finished_at: 1773046860000,
      wait_until: null
    },
    {
      run_id: 'run-1',
      node_id: 'body',
      iteration: 1,
      status: 'succeeded',
      output: { item: 'b', index: 1 },
      error: null,
      started_at: 1773046860100,
      finished_at: 1773046860200,
      wait_until: null
    },
    {
      run_id: 'run-1',
      node_id: 'alert',
      iteration: null,
      status: 'skipped',
      output: null,
      error: null,
      started_at: null,
      finished_at: null,
      wait_until: null
    },
    {
      run_id: 'run-1',
      node_id: 'pause',
      iteration: null,
      status: 'waiting',
      output: null,
      error: null,
      started_at: 1773046861000,
      finished_at: null,
      wait_until: 1773050461000
    }
  ],
  run_policy: {
    trigger_summary: 'cron "0 5 * * 1-5" in America/New_York',
    next_runs: [1773046800000, 1773133200000, 1773219600000],
    agents: [
      {
        node_id: 'extract',
        agent_id: 'claude',
        model: 'sonnet',
        timeout_ms: 120000,
        tools: 'none'
      }
    ],
    secrets: [
      {
        node_id: 'fetch',
        names: ['API_KEY']
      },
      {
        node_id: 'post',
        names: ['HOOK_KEY']
      }
    ],
    outbound_hosts: [
      {
        node_id: 'fetch',
        hosts: ['api.example.com']
      },
      {
        node_id: 'post',
        hosts: ['hooks.example.com']
      }
    ],
    mcp_tools: [
      {
        node_id: 'issues',
        server_id: 'srv-github',
        server_name: 'GitHub',
        tool: 'list_issues'
      },
      {
        node_id: 'ping',
        server_id: 'srv-removed',
        server_name: null,
        tool: 'ping'
      }
    ],
    untrusted_flow: true,
    failure_policy: 'backoff 30s/1m/5m/15m/60m'
  },
  suggestion: {
    fingerprint: '3f1c9a0d5b7e2468',
    representative: 'summarize the open PRs in termul',
    occurrences: 4,
    days: 4,
    last_at: 1793264700000,
    cadence: {
      schedule: { kind: 'cron', expr: '0 9 * * 1-5', timezone: 'Europe/Berlin' },
      label: 'weekdays at 09:00'
    }
  }
}

describe('automation wire types', () => {
  it('match the fixture the Rust model serializes', () => {
    expect(typed).toEqual(wire)
  })
})
