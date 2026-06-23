import { describe, expect, it } from 'vitest'
import { mapRecoveredTerminalToStorePatch } from './use-session-recovery'

describe('mapRecoveredTerminalToStorePatch', () => {
  it('maps running terminal to live attachable recovery status', () => {
    expect(
      mapRecoveredTerminalToStorePatch({
        sessionId: 's1',
        kind: 'terminal',
        status: 'running',
        args: [],
        shell: 'bash',
        cwd: '/repo'
      })
    ).toMatchObject({
      ptyId: 's1',
      recoveryStatus: 'live_attachable',
      cwd: '/repo',
      shell: 'bash'
    })
  })

  it('maps lost terminal to lost recovery status', () => {
    expect(
      mapRecoveredTerminalToStorePatch({
        sessionId: 's2',
        kind: 'terminal',
        status: 'lost',
        args: [],
        recoveryReason: 'process_not_found'
      })
    ).toMatchObject({
      ptyId: 's2',
      recoveryStatus: 'lost',
      recoveryReason: 'process_not_found'
    })
  })

  it('maps exited terminal to restored recovery status', () => {
    expect(
      mapRecoveredTerminalToStorePatch({
        sessionId: 's3',
        kind: 'terminal',
        status: 'exited',
        args: [],
        exitCode: 0
      })
    ).toMatchObject({
      ptyId: 's3',
      recoveryStatus: 'restored',
      lastExitCode: 0
    })
  })
})
