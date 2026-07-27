import { describe, expect, it } from 'vitest'

import {
  isHumanRelayedCap,
  isOsFulfilledCap,
  type ReliabilityTier,
  WS_ERROR_CODES,
  WS_EVENT_TIERS,
  WS_EVENT_TYPES,
  WS_HUMAN_RELAYED_CAPS,
  WS_OS_FULFILLED_CAPS,
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

describe('web-protocol.types — event/request type registries (AC2)', () => {
  it('exports exactly 18 event types (16 acp:* prefix-dropped + auth_required + projects_changed)', () => {
    expect(WS_EVENT_TYPES).toHaveLength(18)
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
  })

  it('exports exactly 17 request types (16 acp_* prefix-dropped + subscribe)', () => {
    expect(WS_REQUEST_TYPES).toHaveLength(17)
    const expected = [
      'send_prompt',
      'cancel_prompt',
      'set_config_option',
      'set_mode',
      'set_model',
      'respond_permission',
      'create_session',
      'load_session',
      'resume_session',
      'close_session',
      'list_sessions',
      'spawn_agent',
      'kill_agent',
      'list_agents',
      'switch_project',
      'authenticate',
      'subscribe'
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
  it('exports exactly 10 stable error codes', () => {
    const codes = new Set(Object.values(WS_ERROR_CODES))
    expect(codes.size).toBe(10)
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
      'no_agent'
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
      'auth_required'
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
