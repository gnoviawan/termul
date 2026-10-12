import { describe, expect, it } from 'vitest'

import { UNASSIGNED_PROJECT_ID } from './web-projects.types'

import {
  COMMAND_ID_PATTERN,
  isHumanRelayedCap,
  isOsFulfilledCap,
  MAX_CLIENT_ID_LEN,
  MAX_COMMAND_ID_LEN,
  type ReliabilityTier,
  WS_COMMAND_CLASSES,
  WS_ERROR_CODES,
  WS_EVENT_TIERS,
  WS_EVENT_TYPES,
  WS_HUMAN_RELAYED_CAPS,
  WS_OS_FULFILLED_CAPS,
  WS_PROTOCOL_VERSION,
  WS_RELAY_TIERS,
  WS_REQUEST_TYPES,
  type WsError,
  type WsEvent,
  type WsEventType,
  type WsReply,
  type WsRequest,
  type WsRequestType,
  wsTierOf
} from './web-protocol.types'
import { WEB_TERMINAL_ERROR_CODES } from './web-terminal-protocol.types'

describe('web-protocol.types — event/request type registries (AC2)', () => {
  it('exports exactly 28 event types including durable user prompts, host records, switch markers, worktree renames + delivery frames', () => {
    expect(WS_EVENT_TYPES).toHaveLength(28)
    // The 16 from events.rs (prefix-dropped) + auth_required.
    const expected16FromEvents = [
      'agent_spawned',
      'session_created',
      'message_chunk',
      'tool_call',
      'tool_call_update',
      'plan_update',
      'commands_update',
      'mode_update',
      'config_options_update',
      'permission_request',
      'prompt_complete',
      'agent_error',
      'session_closed',
      'agent_disconnected',
      'session_info_update',
      'usage_update'
    ]
    for (const name of expected16FromEvents) {
      expect(WS_EVENT_TYPES).toContain(name)
    }
    expect(WS_EVENT_TYPES).toContain('auth_required')
    // Epic-4 bridge: desktop project-list live push (agent-level, seq 0).
    expect(WS_EVENT_TYPES).toContain('projects_changed')
    expect(WS_EVENT_TYPES).toContain('user_prompt')
    // Epic-4 bridge: desktop chat-history live push (agent-level, seq 0).
    expect(WS_EVENT_TYPES).toContain('chat_history_changed')
    // Headless ACP auth (spec-acp-terminal-auth): shim-captured auth URL.
    expect(WS_EVENT_TYPES).toContain('browser_open_request')
    // CAP-2 (spec-in-chat-agent-switch): durable agent-switch marker.
    expect(WS_EVENT_TYPES).toContain('agent_switch')
    // Host-authored durable title record (occupies a session-log seq).
    expect(WS_EVENT_TYPES).toContain('local_title_generated')
    // #856: server-side FS watcher change push (agent-level broadcast).
    expect(WS_EVENT_TYPES).toContain('fs_changed')
    expect(WS_EVENT_TYPES).toContain('fs_watch_ended')
    // Story 16 (CAP-5): host worktree branch rename (agent-level broadcast).
    expect(WS_EVENT_TYPES).toContain('worktree_branch_renamed')
    // Delivery frames (no seq): gap after a LOSSY drop, host heartbeat.
    expect(WS_EVENT_TYPES).toContain('gap')
    expect(WS_EVENT_TYPES).toContain('heartbeat')
    expect(WS_REQUEST_TYPES).toContain('list_persisted_sessions')
    expect(WS_REQUEST_TYPES).toContain('open_persisted_session')
    expect(WS_REQUEST_TYPES).toContain('get_session_payload')
  })

  it('exports exactly 46 request types including warm-pool promotion and host-owned session delete', () => {
    expect(WS_REQUEST_TYPES).toHaveLength(46)
    const expected = [
      'send_prompt',
      'cancel_prompt',
      'set_config_option',
      'set_mode',
      'set_model',
      'respond_permission',
      'answer_question',
      'create_session',
      'load_session',
      'resume_session',
      'close_session',
      'dispose_ephemeral_session',
      // Story 8: promote a backend-ephemeral warm-pool session to durable.
      'promote_session',

      'subscribe',
      'ping',
      'list_persisted_sessions',
      // CAP-11: host-owned session delete (desktop parity with acp_history_delete).
      'delete_session',
      'open_persisted_session',
      'get_session_payload',
      'recover_session_snapshot',
      'get_session_payload_tail',
      'get_session_cursor',
      'register_discovered_session',
      'list_sessions',
      'spawn_agent',
      'kill_agent',
      'list_agents',
      'authenticate',
      'authenticate_agent',
      'logout_agent',
      'delete_agent_session',
      'respond_elicitation',
      'list_acp_catalog',
      'set_catalog_opt_in',
      // CAP-6 / Story 9: host-owned verified-atomic ACP install.
      'install_acp_agent',
      // Issue #613: server-side generic key-value store.
      'store_read',
      'store_write',
      'store_delete',
      // Option B: project-list mutations.
      'add_project',
      'update_project',
      'remove_project',
      // Headless ACP auth paste-back (spec-acp-terminal-auth): replay the
      // pasted loopback redirect to the agent's callback listener. Keeps the
      // `acp_` prefix — the wire name is fixed by the contract.
      'acp_deliver_auth_redirect',
      // CAP-2 (spec-in-chat-agent-switch): host-authored durable marker.
      'record_agent_switch',
      // Per-project fs watch.
      'watch_project',
      'unwatch_project',
      // Explicit host-default project change.
      'set_default_project'
    ]
    for (const name of expected) {
      expect(WS_REQUEST_TYPES).toContain(name)
    }
    // create_session maps to acp_new_session, NOT acp_create_session.
    expect(WS_REQUEST_TYPES).toContain('create_session')
  })

  it('event and request type namespaces are disjoint', () => {
    for (const e of WS_EVENT_TYPES) {
      expect(WS_REQUEST_TYPES).not.toContain(e)
    }
  })
})

describe('web-protocol.types — error codes (AC2)', () => {
  it('exports exactly 26 stable error codes', () => {
    const codes = new Set(Object.values(WS_ERROR_CODES))
    expect(codes.size).toBe(26)
    const expected = [
      'not_found',
      'unauthorized',
      'rate_limited',
      'agent_crashed',
      'permission_denied',
      'stale',
      'duplicate',
      'unsupported',
      'not_implemented',
      'agent_auth_required',
      'session_owned_by_other',
      // Versioned handshake refusals.
      'protocol_version_mismatch',
      'invalid_client_identity',
      // Reserved wire names (handlers land in later slices).
      'terminal_limit',
      'project_busy',
      'outcome_unknown',
      'destructive_op_blocked',
      'provider_quota_exceeded',
      'provider_session_limit',
      'provider_request_rejected',
      // Capability refusal + ticket tombstone.
      'forbidden',
      'already_resolved',
      // Deterministic spawn rejections (never auto-retried).
      'agent_unavailable',
      'invalid_agent_config',
      // Command ledger refusals.
      'command_conflict',
      'invalid_command_id'
    ]
    for (const code of expected) {
      expect(codes).toContain(code)
    }
  })

  it('error codes are snake_case machine strings', () => {
    for (const code of Object.values(WS_ERROR_CODES)) {
      expect(code).toMatch(/^[a-z][a-z_]*$/)
    }
  })
})

describe('web-protocol.types — versioned handshake contract (AD-15)', () => {
  it('pins the protocol version and client id length cap shared with the Rust host', () => {
    expect(WS_PROTOCOL_VERSION).toBe(4)
    expect(MAX_CLIENT_ID_LEN).toBe(128)
  })

  it('pins the unassigned-project sentinel shared with the Rust host', () => {
    expect(UNASSIGNED_PROJECT_ID).toBe('__unassigned__')
  })

  it('WsRequest/WsReply carry the optional command_id / visible_at envelope fields', () => {
    // Compile-time + runtime: the snake_case envelope fields are optional,
    // so every legacy frame shape stays valid.
    const legacy: WsRequest = { id: '1', type: 'ping', payload: {} }
    const withCommand: WsRequest = { id: '2', type: 'ping', payload: {}, command_id: 'c-1' }
    const okReply: WsReply = { id: '2', ok: true, visible_at: 42 }
    const errReply: WsReply = {
      id: '3',
      ok: false,
      err: { code: WS_ERROR_CODES.OUTCOME_UNKNOWN, message: 'x' },
      visible_at: 43
    }
    expect(legacy.command_id).toBeUndefined()
    expect(withCommand.command_id).toBe('c-1')
    expect(okReply.visible_at).toBe(42)
    expect(errReply.visible_at).toBe(43)
  })
})

describe('web-protocol.types — reliability tier registry (AC5)', () => {
  it('defines exactly three tiers', () => {
    expect(WS_RELAY_TIERS.LOSSY).toBe('lossy')
    expect(WS_RELAY_TIERS.RELIABLE).toBe('reliable')
    expect(WS_RELAY_TIERS.IDEMPOTENT).toBe('idempotent')
  })

  it('maps every event type to a tier (no gaps)', () => {
    for (const type of WS_EVENT_TYPES) {
      expect(WS_EVENT_TIERS[type]).toBeDefined()
    }
  })

  it('marks the 4 high-frequency streams as lossy', () => {
    const lossy: WsEventType[] = [
      'message_chunk',
      'tool_call_update',
      'commands_update',
      'plan_update'
    ]
    for (const type of lossy) {
      expect(WS_EVENT_TIERS[type]).toBe('lossy')
    }
  })

  it('marks prompt_complete as idempotent (dedup by turn-id)', () => {
    expect(WS_EVENT_TIERS.prompt_complete).toBe('idempotent')
  })

  it('marks permission_request as reliable', () => {
    expect(WS_EVENT_TIERS.permission_request).toBe('reliable')
  })

  it('marks all lifecycle/state events as reliable', () => {
    const reliable: WsEventType[] = [
      'agent_spawned',
      'session_created',
      'session_closed',
      'agent_disconnected',
      'agent_error',
      'tool_call',
      'mode_update',
      'config_options_update',
      'session_info_update',
      'usage_update',
      'auth_required',
      'projects_changed',
      'worktree_branch_renamed',
      'gap',
      'heartbeat'
    ]
    for (const type of reliable) {
      expect(WS_EVENT_TIERS[type]).toBe('reliable')
    }
  })

  it('wsTierOf returns the tier for a known type', () => {
    expect(wsTierOf('message_chunk')).toBe('lossy')
    expect(wsTierOf('prompt_complete')).toBe('idempotent')
    expect(wsTierOf('permission_request')).toBe('reliable')
  })
})

describe('web-protocol.types — OS vs human cap boundary (AC8)', () => {
  it('lists OS-fulfilled caps (fs/* + terminal/* prefix)', () => {
    expect(WS_OS_FULFILLED_CAPS).toContain('fs/read_text_file')
    expect(WS_OS_FULFILLED_CAPS).toContain('fs/write_text_file')
    expect(WS_OS_FULFILLED_CAPS).toContain('terminal/*')
  })

  it('lists human-relayed caps (session_notification + request_permission)', () => {
    expect(WS_HUMAN_RELAYED_CAPS).toContain('session_notification')
    expect(WS_HUMAN_RELAYED_CAPS).toContain('request_permission')
  })

  it('isOsFulfilledCap matches exact fs caps', () => {
    expect(isOsFulfilledCap('fs/read_text_file')).toBe(true)
    expect(isOsFulfilledCap('fs/write_text_file')).toBe(true)
  })

  it('isOsFulfilledCap matches the terminal/* prefix', () => {
    expect(isOsFulfilledCap('terminal/run_command')).toBe(true)
    expect(isOsFulfilledCap('terminal/anything_here')).toBe(true)
  })

  it('isOsFulfilledCap rejects human-relayed and unknown caps', () => {
    expect(isOsFulfilledCap('request_permission')).toBe(false)
    expect(isOsFulfilledCap('session_notification')).toBe(false)
    expect(isOsFulfilledCap('unknown/cap')).toBe(false)
  })

  it('isHumanRelayedCap matches the two human caps', () => {
    expect(isHumanRelayedCap('request_permission')).toBe(true)
    expect(isHumanRelayedCap('session_notification')).toBe(true)
  })

  it('isHumanRelayedCap rejects OS and unknown caps', () => {
    expect(isHumanRelayedCap('fs/read_text_file')).toBe(false)
    expect(isHumanRelayedCap('terminal/run_command')).toBe(false)
    expect(isHumanRelayedCap('unknown/cap')).toBe(false)
  })
})

describe('web-protocol.types — envelope shapes (AC2 + AC3)', () => {
  it('WsEvent envelope uses snake_case fields with camelCase payload passthrough', () => {
    const evt: WsEvent = {
      sid: 'sess-1',
      seq: 7,
      type: 'message_chunk',
      // payload is the existing camelCase ACP event struct value — passed through.
      payload: {
        agentId: 'a1',
        sessionId: 'sess-1',
        role: 'agent',
        content: { type: 'text', text: 'hi' }
      }
    }
    expect(evt.sid).toBe('sess-1')
    expect(evt.seq).toBe(7)
    expect(evt.type).toBe('message_chunk')
    expect((evt.payload as { agentId: string }).agentId).toBe('a1')
  })

  it('WsEvent allows null sid for agent-level / relay-level events', () => {
    const agentLevel: WsEvent = { sid: null, seq: 0, type: 'agent_spawned', payload: {} }
    const relayLevel: WsEvent = { sid: null, seq: 0, type: 'auth_required', payload: {} }
    expect(agentLevel.sid).toBeNull()
    expect(relayLevel.sid).toBeNull()
  })

  it('WsRequest uses id + type + payload', () => {
    const req: WsRequest = { id: 'r1', type: 'authenticate', payload: { token: 'abc' } }
    expect(req.id).toBe('r1')
    expect(req.type).toBe('authenticate')
  })

  it('WsReply success variant carries payload', () => {
    const ok: WsReply<{ token: string }> = { id: 'r1', ok: true, payload: { token: 'xyz' } }
    expect(ok.ok).toBe(true)
    expect(ok.payload?.token).toBe('xyz')
  })

  it('WsReply failure variant carries err with stable code + message', () => {
    const err: WsReply = {
      id: 'r2',
      ok: false,
      err: { code: 'unauthorized', message: 'pre-auth: send authenticate first' }
    }
    expect(err.ok).toBe(false)
    expect(err.err?.code).toBe('unauthorized')
    expect(err.err?.message).toContain('authenticate')
  })

  it('WsError shape is { code, message }', () => {
    const e: WsError = { code: 'stale', message: 'cursor gap' }
    expect(e.code).toBe('stale')
    expect(e.message).toBe('cursor gap')
  })

  it('compile-time: WsEventType / WsRequestType / ReliabilityTier are string unions', () => {
    const e: WsEventType = 'message_chunk'
    const r: WsRequestType = 'send_prompt'
    const t: ReliabilityTier = 'lossy'
    expect(typeof e).toBe('string')
    expect(typeof r).toBe('string')
    expect(typeof t).toBe('string')
  })
})

describe('web-protocol.types — command classes (AD-5)', () => {
  it('classifies exactly the request types, with a replay policy on create/command only', () => {
    expect(Object.keys(WS_COMMAND_CLASSES).sort()).toEqual([...WS_REQUEST_TYPES].sort())
    for (const [kind, replay] of Object.values(WS_COMMAND_CLASSES)) {
      expect(replay !== null).toBe(kind === 'create' || kind === 'command')
    }
  })

  it('keeps the credential-bearing kinds receipt-only and the prompt on its turn id', () => {
    for (const type of [
      'authenticate_agent',
      'respond_elicitation',
      'acp_deliver_auth_redirect'
    ] as const) {
      expect(WS_COMMAND_CLASSES[type]).toEqual(['command', 'receipt-only'])
    }
    expect(WS_COMMAND_CLASSES.send_prompt).toEqual(['command', 'entity'])
    expect(WS_COMMAND_CLASSES.create_session).toEqual(['create', 'entity'])
  })

  it('accepts 1-128 chars of [A-Za-z0-9_-] as a commandId and nothing else', () => {
    expect(MAX_COMMAND_ID_LEN).toBe(128)
    expect(COMMAND_ID_PATTERN.test('3f2b9c0e-1d4a-4b7e-9a10-aabbccddeeff')).toBe(true)
    expect(COMMAND_ID_PATTERN.test('a'.repeat(128))).toBe(true)
    expect(COMMAND_ID_PATTERN.test('a'.repeat(129))).toBe(false)
    expect(COMMAND_ID_PATTERN.test('')).toBe(false)
    expect(COMMAND_ID_PATTERN.test('has space')).toBe(false)
    expect(COMMAND_ID_PATTERN.test('new\nline')).toBe(false)
  })
})

describe('web-terminal-protocol.types — error codes', () => {
  it('mirrors the Rust terminal_ws codes, including the view-only refusal and the command verdicts', () => {
    expect(Object.values(WEB_TERMINAL_ERROR_CODES).sort()).toEqual([
      'COMMAND_CONFLICT',
      'FORBIDDEN',
      'INVALID_CLIENT_IDENTITY',
      'INVALID_COMMAND_ID',
      'OUTCOME_UNKNOWN',
      'PROTOCOL_VERSION_MISMATCH',
      'UNAUTHORIZED'
    ])
  })

  it('FORBIDDEN is the SCREAMING form of the /ws `forbidden` code', () => {
    expect(WEB_TERMINAL_ERROR_CODES.FORBIDDEN.toLowerCase()).toBe(WS_ERROR_CODES.FORBIDDEN)
  })

  it('the command verdicts are the SCREAMING form of the /ws codes', () => {
    expect(WEB_TERMINAL_ERROR_CODES.OUTCOME_UNKNOWN.toLowerCase()).toBe(
      WS_ERROR_CODES.OUTCOME_UNKNOWN
    )
    expect(WEB_TERMINAL_ERROR_CODES.COMMAND_CONFLICT.toLowerCase()).toBe(
      WS_ERROR_CODES.COMMAND_CONFLICT
    )
    expect(WEB_TERMINAL_ERROR_CODES.INVALID_COMMAND_ID.toLowerCase()).toBe(
      WS_ERROR_CODES.INVALID_COMMAND_ID
    )
  })
})
