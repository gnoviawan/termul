/**
 * Boundary parsers for the automation wire types. The facade runs every host
 * reply through these, so components only ever see values that match
 * `@shared/types/automation.types`. A reply that does not match is a failed
 * `IpcResult` (`code: 'INVALID_RESPONSE'`), never a half-typed object.
 */

import type {
  AgentPolicy,
  ApplyOpsResult,
  Automation,
  AutomationChanged,
  AutomationDetail,
  AutomationId,
  AutomationNode,
  AutomationRun,
  AutomationStep,
  AutomationSuggestion,
  Edge,
  Graph,
  Issue,
  IssueCode,
  JsonSchemaSubset,
  KnownAgent,
  LastRun,
  NodeId,
  NodeSpec,
  RunId,
  RunPolicy,
  RunStatus,
  RunTrigger,
  Schedule,
  StepStatus,
  Trigger
} from '@shared/types/automation.types'

/** Thrown inside a parser; the facade turns it into a failed `IpcResult`. */
export class WireShapeError extends Error {}

type Obj = Record<string, unknown>

function fail(path: string, expected: string): never {
  throw new WireShapeError(`${path}: expected ${expected}`)
}

function obj(value: unknown, path: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'an object')
  return value as Obj
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'a string')
  return value
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a number')
  return value
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'a boolean')
  return value
}

function nullable<T>(value: unknown, path: string, parse: (v: unknown, p: string) => T): T | null {
  return value === null || value === undefined ? null : parse(value, path)
}

function arr<T>(value: unknown, path: string, parse: (v: unknown, p: string) => T): T[] {
  if (!Array.isArray(value)) fail(path, 'an array')
  return value.map((item, index) => parse(item, `${path}[${index}]`))
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(path, `one of ${allowed.join('|')}`)
  }
  return value as T
}

const RUN_STATUSES = ['running', 'succeeded', 'failed', 'cancelled', 'skipped'] as const
const STEP_STATUSES = ['running', 'succeeded', 'failed', 'skipped'] as const
const RUN_TRIGGERS = ['scheduled', 'catch_up', 'manual'] as const
const PORTS = ['out', 'error', 'true', 'false'] as const
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const CONDITION_OPS = ['eq', 'ne', 'contains', 'gt', 'lt', 'exists'] as const

const automationId = (v: unknown, p: string): AutomationId => str(v, p) as AutomationId
const runId = (v: unknown, p: string): RunId => str(v, p) as RunId
const nodeId = (v: unknown, p: string): NodeId => str(v, p) as NodeId

function namedTemplate(v: unknown, p: string): { name: string; value: string } {
  const o = obj(v, p)
  return { name: str(o.name, `${p}.name`), value: str(o.value, `${p}.value`) }
}

function schedule(v: unknown, p: string): Schedule {
  const o = obj(v, p)
  switch (o.kind) {
    case 'cron':
      return {
        kind: 'cron',
        expr: str(o.expr, `${p}.expr`),
        timezone: str(o.timezone, `${p}.timezone`)
      }
    case 'every':
      return {
        kind: 'every',
        every_ms: num(o.every_ms, `${p}.every_ms`),
        anchor_ms: num(o.anchor_ms, `${p}.anchor_ms`)
      }
    case 'at':
      return { kind: 'at', at: num(o.at, `${p}.at`) }
    default:
      return fail(`${p}.kind`, 'cron|every|at')
  }
}

function trigger(v: unknown, p: string): Trigger {
  const o = obj(v, p)
  if (o.kind === 'manual') return { kind: 'manual' }
  if (o.kind === 'schedule')
    return { kind: 'schedule', schedule: schedule(o.schedule, `${p}.schedule`) }
  return fail(`${p}.kind`, 'manual|schedule')
}

function nodeSpec(v: unknown, p: string): NodeSpec {
  const o = obj(v, p)
  switch (o.kind) {
    case 'http':
      return {
        kind: 'http',
        method: oneOf(o.method, `${p}.method`, HTTP_METHODS),
        url: str(o.url, `${p}.url`),
        headers: arr(o.headers, `${p}.headers`, namedTemplate),
        body: nullable(o.body, `${p}.body`, str),
        allowed_hosts: arr(o.allowed_hosts, `${p}.allowed_hosts`, str)
      }
    case 'agent':
      return {
        kind: 'agent',
        agent_id: str(o.agent_id, `${p}.agent_id`),
        model: nullable(o.model, `${p}.model`, str),
        prompt: str(o.prompt, `${p}.prompt`),
        // The host validated the schema subset; the renderer only displays it.
        output_schema: obj(o.output_schema, `${p}.output_schema`) as JsonSchemaSubset,
        timeout_ms: num(o.timeout_ms, `${p}.timeout_ms`),
        max_attempts: num(o.max_attempts, `${p}.max_attempts`)
      }
    case 'transform':
      return { kind: 'transform', fields: arr(o.fields, `${p}.fields`, namedTemplate) }
    case 'condition':
      return {
        kind: 'condition',
        left: str(o.left, `${p}.left`),
        op: oneOf(o.op, `${p}.op`, CONDITION_OPS),
        right: nullable(o.right, `${p}.right`, str)
      }
    case 'fail':
      return { kind: 'fail', message: str(o.message, `${p}.message`) }
    default:
      return fail(`${p}.kind`, 'http|agent|transform|condition|fail')
  }
}

function node(v: unknown, p: string): AutomationNode {
  const o = obj(v, p)
  return {
    id: nodeId(o.id, `${p}.id`),
    label: str(o.label, `${p}.label`),
    spec: nodeSpec(o.spec, `${p}.spec`)
  }
}

function edge(v: unknown, p: string): Edge {
  const o = obj(v, p)
  const from = str(o.from, `${p}.from`)
  return {
    from: from === 'trigger' ? 'trigger' : (from as NodeId),
    port: oneOf(o.port, `${p}.port`, PORTS),
    to: nodeId(o.to, `${p}.to`)
  }
}

function graph(v: unknown, p: string): Graph {
  const o = obj(v, p)
  return { nodes: arr(o.nodes, `${p}.nodes`, node), edges: arr(o.edges, `${p}.edges`, edge) }
}

function lastRun(v: unknown, p: string): LastRun {
  const o = obj(v, p)
  return {
    run_id: runId(o.run_id, `${p}.run_id`),
    status: oneOf<RunStatus>(o.status, `${p}.status`, RUN_STATUSES),
    finished_at: num(o.finished_at, `${p}.finished_at`)
  }
}

export function parseAutomation(v: unknown, p = 'automation'): Automation {
  const o = obj(v, p)
  return {
    id: automationId(o.id, `${p}.id`),
    project_id: str(o.project_id, `${p}.project_id`),
    name: str(o.name, `${p}.name`),
    revision: num(o.revision, `${p}.revision`),
    approved_revision: nullable(o.approved_revision, `${p}.approved_revision`, num),
    enabled: bool(o.enabled, `${p}.enabled`),
    trigger: trigger(o.trigger, `${p}.trigger`),
    graph: graph(o.graph, `${p}.graph`),
    isolation: oneOf(o.isolation, `${p}.isolation`, [
      'shared_in_root',
      'worktree_per_run'
    ] as const),
    next_run_at: nullable(o.next_run_at, `${p}.next_run_at`, num),
    consecutive_errors: num(o.consecutive_errors, `${p}.consecutive_errors`),
    schedule_error_count: num(o.schedule_error_count, `${p}.schedule_error_count`),
    unseen_failures: num(o.unseen_failures, `${p}.unseen_failures`),
    last_run: nullable(o.last_run, `${p}.last_run`, lastRun),
    created_at: num(o.created_at, `${p}.created_at`),
    updated_at: num(o.updated_at, `${p}.updated_at`),
    deleted_at: nullable(o.deleted_at, `${p}.deleted_at`, num)
  }
}

export function parseAutomationList(v: unknown): Automation[] {
  return arr(v, 'automations', parseAutomation)
}

function issue(v: unknown, p: string): Issue {
  const o = obj(v, p)
  return {
    node_id: nullable(o.node_id, `${p}.node_id`, nodeId),
    // Codes are displayed, not branched on: a code this build does not know
    // still reaches the issues list.
    code: str(o.code, `${p}.code`) as IssueCode,
    message: str(o.message, `${p}.message`)
  }
}

function agentPolicy(v: unknown, p: string): AgentPolicy {
  const o = obj(v, p)
  return {
    node_id: nodeId(o.node_id, `${p}.node_id`),
    agent_id: str(o.agent_id, `${p}.agent_id`),
    model: nullable(o.model, `${p}.model`, str),
    timeout_ms: num(o.timeout_ms, `${p}.timeout_ms`),
    tools: oneOf(o.tools, `${p}.tools`, ['none'] as const)
  }
}

function perNode<K extends string>(key: K) {
  return (v: unknown, p: string): { node_id: NodeId } & Record<K, string[]> => {
    const o = obj(v, p)
    return {
      node_id: nodeId(o.node_id, `${p}.node_id`),
      [key]: arr(o[key], `${p}.${key}`, str)
    } as { node_id: NodeId } & Record<K, string[]>
  }
}

function runPolicy(v: unknown, p: string): RunPolicy {
  const o = obj(v, p)
  return {
    trigger_summary: str(o.trigger_summary, `${p}.trigger_summary`),
    next_runs: arr(o.next_runs, `${p}.next_runs`, num),
    agents: arr(o.agents, `${p}.agents`, agentPolicy),
    secrets: arr(o.secrets, `${p}.secrets`, perNode('names')),
    outbound_hosts: arr(o.outbound_hosts, `${p}.outbound_hosts`, perNode('hosts')),
    untrusted_flow: bool(o.untrusted_flow, `${p}.untrusted_flow`),
    failure_policy: str(o.failure_policy, `${p}.failure_policy`)
  }
}

export function parseAutomationDetail(v: unknown): AutomationDetail {
  const o = obj(v, 'detail')
  return {
    automation: parseAutomation(o.automation),
    issues: arr(o.issues, 'detail.issues', issue),
    policy: runPolicy(o.policy, 'detail.policy')
  }
}

export function parseApplyOpsResult(v: unknown): ApplyOpsResult {
  const o = obj(v, 'result')
  return {
    automation: parseAutomation(o.automation),
    issues: arr(o.issues, 'result.issues', issue)
  }
}

export function parseRun(v: unknown, p = 'run'): AutomationRun {
  const o = obj(v, p)
  return {
    id: runId(o.id, `${p}.id`),
    automation_id: automationId(o.automation_id, `${p}.automation_id`),
    revision: num(o.revision, `${p}.revision`),
    graph: graph(o.graph, `${p}.graph`),
    trigger: oneOf<RunTrigger>(o.trigger, `${p}.trigger`, RUN_TRIGGERS),
    scheduled_for: num(o.scheduled_for, `${p}.scheduled_for`),
    status: oneOf<RunStatus>(o.status, `${p}.status`, RUN_STATUSES),
    started_at: num(o.started_at, `${p}.started_at`),
    finished_at: nullable(o.finished_at, `${p}.finished_at`, num),
    stop_reason: nullable(o.stop_reason, `${p}.stop_reason`, str),
    summary: nullable(o.summary, `${p}.summary`, str),
    conversation_id: nullable(o.conversation_id, `${p}.conversation_id`, str),
    worktree_id: nullable(o.worktree_id, `${p}.worktree_id`, str)
  }
}

export function parseRunList(v: unknown): AutomationRun[] {
  return arr(v, 'runs', parseRun)
}

function step(v: unknown, p: string): AutomationStep {
  const o = obj(v, p)
  return {
    run_id: runId(o.run_id, `${p}.run_id`),
    node_id: nodeId(o.node_id, `${p}.node_id`),
    status: oneOf<StepStatus>(o.status, `${p}.status`, STEP_STATUSES),
    output: o.output ?? null,
    error: nullable(o.error, `${p}.error`, str),
    started_at: nullable(o.started_at, `${p}.started_at`, num),
    finished_at: nullable(o.finished_at, `${p}.finished_at`, num)
  }
}

export function parseStepList(v: unknown): AutomationStep[] {
  return arr(v, 'steps', step)
}

export interface SchedulePreview {
  next_runs: number[]
  error: string | null
}

export function parseSchedulePreview(v: unknown): SchedulePreview {
  const o = obj(v, 'preview')
  return {
    next_runs: arr(o.next_runs, 'preview.next_runs', num),
    error: nullable(o.error, 'preview.error', str)
  }
}

export function parseAgentList(v: unknown): KnownAgent[] {
  return arr(v, 'agents', (item, p) => {
    const o = obj(item, p)
    return { agent_id: str(o.agent_id, `${p}.agent_id`), name: str(o.name, `${p}.name`) }
  })
}

export function parseSecretNames(v: unknown): string[] {
  return arr(v, 'secrets', str)
}

function suggestion(v: unknown, p: string): AutomationSuggestion {
  const o = obj(v, p)
  const cadence = obj(o.cadence, `${p}.cadence`)
  return {
    fingerprint: str(o.fingerprint, `${p}.fingerprint`),
    representative: str(o.representative, `${p}.representative`),
    occurrences: num(o.occurrences, `${p}.occurrences`),
    days: num(o.days, `${p}.days`),
    last_at: num(o.last_at, `${p}.last_at`),
    cadence: {
      schedule: schedule(cadence.schedule, `${p}.cadence.schedule`),
      label: str(cadence.label, `${p}.cadence.label`)
    }
  }
}

export function parseSuggestionList(v: unknown): AutomationSuggestion[] {
  return arr(v, 'suggestions', suggestion)
}

/** A match reply: the suggestion the prompt repeats, or `null`. */
export function parseSuggestionMatch(v: unknown): AutomationSuggestion | null {
  if (v === undefined) fail('match', 'a suggestion or null')
  return nullable(v, 'match', suggestion)
}

/**
 * `null` when the payload is not an `automation_changed` event. A null
 * `automation_id` is a project-wide change (secret names). `proposed` and
 * `proposed_by` are kept only on a proposal.
 */
export function parseAutomationChange(v: unknown): AutomationChanged | null {
  if (typeof v !== 'object' || v === null) return null
  const { project_id, automation_id, proposed, proposed_by } = v as Obj
  if (typeof project_id !== 'string') return null
  if (automation_id !== null && typeof automation_id !== 'string') return null
  const change = { project_id, automation_id: automation_id as AutomationId | null }
  if (proposed !== true) return change
  return typeof proposed_by === 'string'
    ? { ...change, proposed: true, proposed_by }
    : { ...change, proposed: true }
}
