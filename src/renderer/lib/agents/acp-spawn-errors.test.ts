import { describe, expect, it } from 'vitest'
import type { AuthMethod } from '@/lib/acp-api'
import {
  AmbiguousAuthError,
  classifySetupError,
  formatAcpSpawnError,
  isAgentAuthRequiredError,
  isAmbiguousAuthError,
  SETUP_ERROR_LABELS
} from './acp-spawn-errors'

describe('formatAcpSpawnError', () => {
  it('passes non-ENOENT messages through verbatim', () => {
    expect(formatAcpSpawnError('boom')).toBe('boom')
    expect(formatAcpSpawnError(new Error('session/new timed out after 60s'))).toBe(
      'session/new timed out after 60s'
    )
  })

  it('rewrites ENOENT for npx, uvx, and named commands', () => {
    expect(formatAcpSpawnError('spawn npx ENOENT', { command: 'npx' })).toMatch(/Install Node\.js/)
    expect(formatAcpSpawnError('program not found', { command: 'uvx' })).toMatch(/Install uv/)
    expect(formatAcpSpawnError('command not found', { command: 'cursor-agent' })).toMatch(
      /"cursor-agent"/
    )
  })
})

describe('AmbiguousAuthError', () => {
  const methods: AuthMethod[] = [
    { id: 'cursor_login', name: 'Cursor' },
    { id: 'api_key', name: 'API key' }
  ]

  it('lists method names and carries a stable marker code', () => {
    const err = new AmbiguousAuthError(methods)
    expect(err.message).toContain('Cursor')
    expect(err.message).toContain('API key')
    expect(err.methods).toEqual(methods)
    expect(isAmbiguousAuthError(err)).toBe(true)
  })

  it('recognizes a marker-carrying plain object (post-serialization)', () => {
    expect(isAmbiguousAuthError({ code: 'ACP_MULTI_AUTH' })).toBe(true)
    expect(isAmbiguousAuthError(new Error('nope'))).toBe(false)
    expect(isAmbiguousAuthError('nope')).toBe(false)
  })
})

describe('classifySetupError order and categories (P4)', () => {
  it('multi-auth wins over everything', () => {
    const result = classifySetupError(new AmbiguousAuthError([{ id: 'a', name: 'A' }]))
    expect(result.category).toBe('multi-auth')
    expect(result.label).toBe(SETUP_ERROR_LABELS['multi-auth'])
  })

  it('spawn (ENOENT) is classified with friendly detail from the raw error', () => {
    const result = classifySetupError('spawn cursor-agent ENOENT', { command: 'npx' })
    expect(result.category).toBe('spawn')
    // Category comes from the RAW error; detail is the friendly rewrite.
    expect(result.detail).toMatch(/Install Node\.js/)
  })

  it('does NOT reclassify an already-friendly ENOENT string as unknown', () => {
    // The formatted message contains no ENOENT keywords, but classification is
    // always driven by the RAW error, so callers must pass the raw value.
    const raw = 'Error: spawn npx ENOENT'
    const result = classifySetupError(raw)
    expect(result.category).toBe('spawn')
  })

  it('classifies transport failures (destroyed stream, refused, reset)', () => {
    expect(classifySetupError('the stream was destroyed').category).toBe('transport')
    expect(classifySetupError('connection refused').category).toBe('transport')
    expect(classifySetupError('ECONNRESET').category).toBe('transport')
    expect(classifySetupError('agent thread is no longer running').category).toBe('transport')
  })

  it('treats "connection timed out" as transport, not timeout (evicts the process)', () => {
    const result = classifySetupError('connection timed out')
    expect(result.category).toBe('transport')
  })

  it('prefers transport when both auth and connection wording are present', () => {
    const result = classifySetupError('authentication failed: connection reset by peer')
    expect(result.category).toBe('transport')
  })

  it('classifies authentication failures', () => {
    expect(classifySetupError('Please run `cursor login` to authenticate').category).toBe('auth')
    expect(classifySetupError('not logged in').category).toBe('auth')
    expect(classifySetupError('401 Unauthorized').category).toBe('auth')
  })

  it('maps the additive agent_auth_required transport code to auth (sign-in actionable)', () => {
    const err = Object.assign(new Error('create_session rejected: transport closed'), {
      code: 'agent_auth_required'
    })
    const result = classifySetupError(err)
    // The explicit code wins over the transport-sounding message wording.
    expect(result.category).toBe('auth')
    expect(result.label).toBe(SETUP_ERROR_LABELS.auth)
    expect(result.detail).toBe('create_session rejected: transport closed')
  })

  it('maps the legacy ACP_AUTH_REQUIRED message prefix to auth', () => {
    const result = classifySetupError(new Error('ACP_AUTH_REQUIRED: run `gemini auth login`'))
    expect(result.category).toBe('auth')
    expect(result.detail).toContain('gemini auth login')
  })

  it('old servers without the code/prefix keep the generic classification', () => {
    expect(isAgentAuthRequiredError(new Error('connection refused'))).toBe(false)
    expect(isAgentAuthRequiredError('boom')).toBe(false)
    expect(isAgentAuthRequiredError({ code: 'closed' })).toBe(false)
    expect(classifySetupError('some unexpected agent error').category).toBe('unknown')
  })

  it('classifies a plain initialize/session timeout as timeout', () => {
    expect(classifySetupError('session/new timed out after 60s').category).toBe('timeout')
    expect(classifySetupError('initialize timed out after 30s').category).toBe('timeout')
  })

  it('falls back to unknown and preserves the diagnostic detail', () => {
    const result = classifySetupError('some unexpected agent error')
    expect(result.category).toBe('unknown')
    expect(result.detail).toBe('some unexpected agent error')
    expect(result.label).toBe(SETUP_ERROR_LABELS.unknown)
  })

  it('never labels a classified failure "Model unavailable"', () => {
    for (const raw of [
      'connection reset',
      'not logged in',
      'session/new timed out after 60s',
      'weird failure'
    ]) {
      expect(classifySetupError(raw).label).not.toBe('Model unavailable')
    }
  })
})
