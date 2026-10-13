import { describe, expect, it } from 'vitest'
import type { AuthMethod } from '@/lib/acp-api'
import { AcpTransportError } from '@/lib/acp-transport/types'
import {
  AGENT_AUTH_REQUIRED_CODE,
  AmbiguousAuthError,
  classifySetupError,
  formatAcpSpawnError,
  isAgentAuthRequiredError,
  isAmbiguousAuthError,
  isDefiniteSpawnRejection,
  PROVIDER_ERROR_LABELS,
  PROVIDER_ERROR_MESSAGES,
  providerCodeOf,
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

  it.each([
    'provider_quota_exceeded',
    'provider_session_limit',
    'provider_request_rejected'
  ] as const)('classifies the host code %s as provider whatever the wording', (code) => {
    // Wording that the heuristics would read as transport / auth / timeout.
    for (const wording of [
      'connection limit: authentication token quota timed out',
      'You have hit your limit',
      ''
    ]) {
      const result = classifySetupError(new AcpTransportError(code, wording))
      expect(result.category).toBe('provider')
      expect(result.providerCode).toBe(code)
      expect(result.label).toBe(PROVIDER_ERROR_LABELS[code])
      expect(result.detail).toContain(PROVIDER_ERROR_MESSAGES[code])
      if (wording) expect(result.detail).toContain(wording)
    }
  })

  it('classifies a serialized { code, message } provider failure', () => {
    const result = classifySetupError({
      code: 'provider_session_limit',
      message: 'resets 8:20pm'
    })
    expect(result.category).toBe('provider')
    expect(result.detail).toBe(`${PROVIDER_ERROR_MESSAGES.provider_session_limit} (resets 8:20pm)`)
  })

  it('keeps auth and definite spawn rejections ahead of a provider code', () => {
    expect(
      classifySetupError(new AcpTransportError('agent_auth_required', 'sign in')).category
    ).toBe('auth')
    expect(classifySetupError(new AcpTransportError('agent_unavailable', 'quota')).category).toBe(
      'spawn'
    )
  })

  it('reads provider wording without a host code through the old heuristics only', () => {
    // No code: nothing new is guessed from wording; it falls to the old paths.
    expect(classifySetupError('You have reached your usage limit').category).toBe('unknown')
    expect(providerCodeOf('provider_quota_exceeded')).toBeUndefined()
    expect(providerCodeOf({ code: 'rate_limited' })).toBeUndefined()
    expect(providerCodeOf({ code: 'provider_quota_exceeded' })).toBe('provider_quota_exceeded')
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
  it('classifies an explicit agent_auth_required code as auth even without auth wording', () => {
    // New servers (story 7) tag create_session auth failures with an explicit
    // code — the code is authoritative even when the message has no auth wording.
    const err = Object.assign(new Error('setup did not complete'), {
      code: AGENT_AUTH_REQUIRED_CODE
    })
    const result = classifySetupError(err)
    expect(result.category).toBe('auth')
    expect(result.label).toBe(SETUP_ERROR_LABELS.auth)
    expect(result.detail).toBe('setup did not complete')
  })

  it('lets an explicit agent_auth_required code beat transport wording in the message', () => {
    const err = Object.assign(new Error('connection reset by peer'), {
      code: AGENT_AUTH_REQUIRED_CODE
    })
    expect(classifySetupError(err).category).toBe('auth')
  })

  it('lets an explicit agent_auth_required code beat spawn (ENOENT) wording', () => {
    // Ordering lock: the code check runs before the whole pattern table.
    const err = Object.assign(new Error('spawn codex ENOENT'), {
      code: AGENT_AUTH_REQUIRED_CODE
    })
    expect(classifySetupError(err).category).toBe('auth')
  })

  it('never renders "[object Object]" for a coded error without a message', () => {
    expect(classifySetupError({ code: AGENT_AUTH_REQUIRED_CODE }).detail).toBe(
      AGENT_AUTH_REQUIRED_CODE
    )
  })

  it('classifies a serialized (plain-object) agent_auth_required error as auth', () => {
    const result = classifySetupError({
      code: AGENT_AUTH_REQUIRED_CODE,
      message: 'authenticate first'
    })
    expect(result.category).toBe('auth')
    expect(result.detail).toBe('authenticate first')
  })

  it('leaves errors without the code on the message-pattern path (old servers)', () => {
    // Old servers never send agent_auth_required — classification is unchanged.
    expect(classifySetupError(new Error('setup did not complete')).category).toBe('unknown')
    expect(classifySetupError({ message: 'setup did not complete' }).category).toBe('unknown')
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

describe('definite spawn rejections (AD-5)', () => {
  it('recognises the /ws codes and the desktop message prefixes, nothing else', () => {
    expect(
      isDefiniteSpawnRejection(Object.assign(new Error('x'), { code: 'agent_unavailable' }))
    ).toBe(true)
    expect(isDefiniteSpawnRejection({ code: 'invalid_agent_config' })).toBe(true)
    expect(isDefiniteSpawnRejection('ACP_AGENT_UNAVAILABLE: program not found')).toBe(true)
    expect(isDefiniteSpawnRejection(new Error('ACP_INVALID_AGENT_CONFIG: empty name'))).toBe(true)
    expect(isDefiniteSpawnRejection(Object.assign(new Error('x'), { code: 'timeout' }))).toBe(false)
    expect(isDefiniteSpawnRejection('agent initialize failed: eof')).toBe(false)
  })

  it('classifies a definite rejection as a spawn failure even when its text sounds like auth or transport', () => {
    const unavailable = classifySetupError(
      Object.assign(new Error('Claude Code CLI is not signed in; connection refused'), {
        code: 'agent_unavailable'
      })
    )
    expect(unavailable).toMatchObject({ category: 'spawn', definite: true })

    const invalid = classifySetupError(
      'ACP_INVALID_AGENT_CONFIG: spawn_agent requires a non-empty `config.command`'
    )
    expect(invalid).toMatchObject({
      category: 'spawn',
      definite: true,
      detail: 'spawn_agent requires a non-empty `config.command`'
    })
  })

  it('strips the desktop prefixes from the text the user reads, whichever formatter shows it', () => {
    expect(formatAcpSpawnError('ACP_AGENT_UNAVAILABLE: program `gemini` not found')).toBe(
      'program `gemini` not found'
    )
    expect(formatAcpSpawnError(new Error('ACP_INVALID_AGENT_CONFIG: empty name'))).toBe(
      'empty name'
    )
    expect(formatAcpSpawnError(new Error('plain failure'))).toBe('plain failure')
  })

  it('shows the message of a serialized { code, message } error, never [object Object]', () => {
    expect(formatAcpSpawnError({ code: 'agent_unavailable', message: 'not installed' })).toBe(
      'not installed'
    )
    expect(
      classifySetupError({ code: 'invalid_agent_config', message: 'empty command' })
    ).toMatchObject({ category: 'spawn', definite: true, detail: 'empty command' })
    expect(formatAcpSpawnError({ message: 'ACP_AGENT_UNAVAILABLE: agent exited at startup' })).toBe(
      'agent exited at startup'
    )
  })

  it('leaves ordinary spawn/transport failures retryable (no definite flag)', () => {
    expect(classifySetupError(new Error('failed to spawn agent')).definite).toBeUndefined()
    expect(classifySetupError(new Error('connection refused')).definite).toBeUndefined()
  })
})
