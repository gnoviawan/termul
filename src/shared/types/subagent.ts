/**
 * The canonical subagent record. The host (Rust, `src-tauri/src/acp/subagents/`)
 * maps every agent's subagent signals (ACP RFD/AIR subagent sessions, Claude
 * `Agent`/`Task` calls, Codex collab calls, a conservative tool heuristic)
 * onto this one shape. It rides the subagent's dispatch tool call as
 * `_meta["termul/subagent"]` on live events and in the durable tool-call log,
 * so live, reopened, desktop and web chats read the same record. The host
 * sends the full record whenever it changes; a later record replaces the
 * earlier one.
 */

/** `_meta` key on a dispatch tool call that carries its {@link Subagent}. */
export const SUBAGENT_META_KEY = 'termul/subagent'

/**
 * `_meta` key on a call that steers existing subagents instead of starting one
 * (Codex `wait`, `sendInput`, `closeAgent`, activity cards). Carries a
 * {@link SubagentControl}.
 */
export const SUBAGENT_CONTROL_META_KEY = 'termul/subagentControl'

/** Child session id, dispatch tool call id, or agent thread id. */
export type SubagentId = string & { readonly __brand: 'SubagentId' }

/** Which mapper produced the record. */
export type SubagentSource =
  | 'acp-rfd'
  | 'acp-air'
  | 'claude-meta'
  | 'codex-collab'
  | 'cursor-task'
  | 'opencode-task'
  | 'gemini-agent'
  | 'tool-heuristic'

export type SubagentEndReason = 'completed' | 'cancelled' | 'failed' | 'unexplained'

export interface SubagentEnd {
  reason: SubagentEndReason
  /** Agent-reported error text for a `failed` end. */
  error?: string
}

/**
 * Current work state (ACP RFD semantics). `idle` ends the current work and is
 * the only state with an {@link SubagentEnd}; an idle child may run again.
 * `unknown` means the agent cannot observe the child: it is not an end and not
 * a failure.
 */
export type SubagentState =
  | { activity: 'running' }
  | { activity: 'requires_action' }
  | { activity: 'idle'; end: SubagentEnd }
  | { activity: 'unknown' }

export type SubagentActivity = SubagentState['activity']

export interface SubagentUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  toolUses?: number
  durationMs?: number
}

export interface SubagentCaps {
  /** How the host can stop this one subagent; null when it cannot. */
  stop: 'session-cancel' | null
  /**
   * `live`: the subagent's own tool calls and text stream into the chat under
   * its dispatch. `final`: only its result arrives. `none`: neither.
   */
  transcript: 'live' | 'final' | 'none'
  /**
   * The source reports state changes as they happen, so `running` holds across
   * turns until the source reports the end. When false, `activity` only mirrors
   * the dispatch tool call, whose completion a cancelled turn can lose.
   */
  liveProgress: boolean
  /** The source reports {@link SubagentUsage}. */
  usage: boolean
}

interface SubagentFields {
  id: SubagentId
  /** The chat session the subagent belongs to. */
  rootSessionId: string
  /** The subagent that spawned this one (nested subagents). */
  parentId?: SubagentId
  /** The tool call that represents the subagent in the chat. */
  dispatchToolCallId: string
  source: SubagentSource
  title: string
  /** Role or purpose, when the agent states one apart from the title. */
  description?: string
  /** Agent type (`subagent_type`), when the agent names one. */
  role?: string
  /** The task the parent gave the subagent (bounded). */
  prompt?: string
  /** The dispatch returned at launch; the subagent continues after it. */
  background: boolean
  /** Host clock (epoch ms) when the host first saw the subagent. */
  startedAt?: number
  /** Host clock (epoch ms) when the current work ended. */
  endedAt?: number
  model?: string
  usage?: SubagentUsage
  /** File that receives a background subagent's output, when the agent names one. */
  outputFile?: string
  caps: SubagentCaps
}

export type Subagent = SubagentFields & SubagentState

export interface SubagentControl {
  /** Subagents the call steers. */
  subagentIds: SubagentId[]
}
