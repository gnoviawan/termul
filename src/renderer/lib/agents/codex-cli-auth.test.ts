import { describe, expect, it } from 'vitest'
import { codexAuthSyncDecision, isCodexAcpConfig } from './codex-cli-auth'

describe('isCodexAcpConfig', () => {
  it('matches the registry id and the package argument', () => {
    expect(isCodexAcpConfig({ id: 'acp-registry:codex-acp' })).toBe(true)
    expect(isCodexAcpConfig({ args: ['-y', '@agentclientprotocol/codex-acp@1.12.0'] })).toBe(true)
    expect(isCodexAcpConfig({ id: 'acp-registry:claude-acp' })).toBe(false)
    expect(isCodexAcpConfig({ id: 'custom-codex-acp-wrapper' })).toBe(false)
    expect(isCodexAcpConfig({ args: ['/opt/not-codex-acp/bin'] })).toBe(false)
  })
})

describe('codexAuthSyncDecision', () => {
  it('records the first sample and does not restart', () => {
    expect(
      codexAuthSyncDecision({
        previous: null,
        next: 'signed-out',
        authBusy: false,
        hasLiveAgent: true,
        hasAuthError: false
      }).action
    ).toBe('none')
  })

  it('restarts a live agent when the CLI logs out', () => {
    expect(
      codexAuthSyncDecision({
        previous: 'signed-in',
        next: 'signed-out',
        authBusy: false,
        hasLiveAgent: true,
        hasAuthError: false
      }).action
    ).toBe('refresh-after-cli-logout')
  })

  it('restarts when the CLI logs in over an auth error', () => {
    expect(
      codexAuthSyncDecision({
        previous: 'signed-out',
        next: 'signed-in',
        authBusy: false,
        hasLiveAgent: true,
        hasAuthError: true
      }).action
    ).toBe('refresh-after-cli-login')
  })

  it('leaves a working agent alone when the CLI is already signed in', () => {
    expect(
      codexAuthSyncDecision({
        previous: 'signed-out',
        next: 'signed-in',
        authBusy: false,
        hasLiveAgent: true,
        hasAuthError: false
      }).action
    ).toBe('none')
  })

  it('does nothing while Termul sign-in is in progress', () => {
    expect(
      codexAuthSyncDecision({
        previous: 'signed-out',
        next: 'signed-in',
        authBusy: true,
        hasLiveAgent: true,
        hasAuthError: true
      }).action
    ).toBe('none')
  })
})
