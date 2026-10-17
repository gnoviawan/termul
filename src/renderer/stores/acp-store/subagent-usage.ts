/**
 * Extract the small usage scalars of a Claude subagent dispatch from
 * `_meta.claudeCode.toolResponse`. The adapter sends that block in one update
 * and the following status update replaces `_meta` wholesale, so the scalars
 * are lifted into `ToolCall.subagentUsage` at ingest. The block itself (it
 * carries the full prompt and report) is never retained by this path.
 */

import { asRecord } from '@/components/chat/tool-call-summary'
import type { ToolCall } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'

type SubagentUsage = NonNullable<ToolCall['subagentUsage']>
type UsageField = keyof SubagentUsage

const USAGE_FIELDS: readonly UsageField[] = ['totalTokens', 'totalDurationMs', 'totalToolUseCount']

/** Dedup cap for the warn log, FIFO-evicted (an evicted id may re-log once). */
const MAX_WARNED_KEYS = 256
const warnedKeys = new Set<string>()

function warnOnce(toolCallId: string, field: UsageField): void {
  const key = `${toolCallId.slice(0, 128)}:${field}`
  if (warnedKeys.has(key)) return
  if (warnedKeys.size >= MAX_WARNED_KEYS) {
    const oldest = warnedKeys.values().next().value
    if (oldest !== undefined) warnedKeys.delete(oldest)
  }
  warnedKeys.add(key)
  void logFrontendError({
    level: 'warn',
    source: 'acp-store.subagentUsage',
    message: `Subagent ${key.split(':')[0]} reported a non-numeric ${field} in toolResponse`
  })
}

/**
 * Finite non-negative scalars from `_meta.claudeCode.toolResponse`, or
 * undefined when none are usable. Present-but-invalid fields log a warning
 * once per toolCallId and field (ids only, never prompt or output content).
 */
export function extractSubagentUsage(toolCallId: string, meta: unknown): SubagentUsage | undefined {
  const response = asRecord(asRecord(asRecord(meta)?.claudeCode)?.toolResponse)
  if (!response) return undefined
  const usage: SubagentUsage = {}
  for (const field of USAGE_FIELDS) {
    const value = response[field]
    if (value === undefined || value === null) continue
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) usage[field] = value
    else warnOnce(toolCallId, field)
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

/** `call` with `subagentUsage` lifted from its `_meta`; the same object when none. */
export function withSubagentUsage<T extends { toolCallId: string; _meta?: unknown }>(call: T): T {
  const subagentUsage = extractSubagentUsage(call.toolCallId, call._meta)
  return subagentUsage ? { ...call, subagentUsage } : call
}

/** Reset the warn dedup (tests). */
export function _resetSubagentUsageWarningsForTesting(): void {
  warnedKeys.clear()
}
