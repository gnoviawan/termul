/**
 * ConnectedTerminal's binding of a screen to its PTY, ported from the DOM
 * component's `initTerminal`: attach to an existing PTY (the workspace path)
 * or spawn one, then put back what the screen is missing — the missed-output
 * delta for a cached screen, the transcript or persisted scrollback for a
 * fresh one — and report the bound PTY id. Every replay outcome is a
 * terminal-continuity event, like the DOM client's.
 */
import type { TerminalModes, TerminalSpawnOptions } from '@shared/types/ipc.types'
import type { Terminal as XtermTerminal } from '@xterm/xterm'
import { PARTIAL_RESTORE_NOTE } from '@/components/terminal/instrumentation'
import { snapshotXtermModes } from '@/components/terminal/terminal-modes'
import { flushDetachedOutputNow } from '@/hooks/use-terminal-detached-output'
import { isTerminalPendingPtyAssignment } from '@/hooks/use-terminal-restore'
import { terminalApi } from '@/lib/api'
import {
  getOrCreateProjectContinuityCorrelation,
  recordTerminalContinuityEvent
} from '@/lib/terminal-continuity-instrumentation'
import { useTerminalStore } from '@/stores/terminal-store'
import {
  buildRehydrateSequences,
  clearScrollPosition,
  registerTerminal,
  restoreScrollback,
  restoreScrollPosition
} from '@/utils/terminal-registry'
import { log } from '../log'
import type { TerminalScreen } from './screen'

type ReplayEvent =
  | 'restore-replay-attempted'
  | 'restore-replay-succeeded'
  | 'restore-replay-failed'
  | 'restore-replay-skipped'

export interface SessionBinding {
  screen: TerminalScreen
  /** The screen's xterm facade, as the registry holds it. */
  xterm: XtermTerminal
  /** The screen came out of the terminal cache with its buffer intact. */
  cached: boolean
  externalTerminalId?: string
  storeTerminalId?: string
  autoSpawn: boolean
  spawnOptions?: TerminalSpawnOptions
  initialScrollback?: string[]
  initialModes?: TerminalModes | null
  continuityProjectId: () => string | undefined
  /** False once the component unmounted or rebound, so a late spawn does nothing. */
  isCurrent: () => boolean
  /** Whether a spawn is already running or a PTY is bound. */
  busy: () => boolean
  setSpawning: (spawning: boolean) => void
  bindPty: (ptyId: string) => void
  onSpawned?: (ptyId: string) => void
  onBound?: (ptyId: string) => void
  onError?: (message: string) => void
}

function envLine(env: Record<string, string> | undefined): string | null {
  const count = env ? Object.keys(env).length : 0
  if (!count) return null
  return `\x1b[36m\r\n[Project env: ${count} variable${count !== 1 ? 's' : ''} applied]\x1b[0m\r\n`
}

function looksPartial(transcript: string): boolean {
  return transcript.includes('\u001b[?1049h') || transcript.includes('\u001b[?47h')
}

export async function bindSession(binding: SessionBinding): Promise<void> {
  const { screen, xterm, cached, externalTerminalId, storeTerminalId } = binding
  const record = (
    name: ReplayEvent,
    details: Record<string, unknown>,
    ptyId: string | undefined
  ): void => {
    const projectId = binding.continuityProjectId()
    recordTerminalContinuityEvent({
      name,
      correlationId: getOrCreateProjectContinuityCorrelation(projectId),
      projectId,
      terminalId: storeTerminalId,
      ptyId,
      details
    })
  }

  /** A fresh screen: the transcript if the store holds one, else persisted scrollback. */
  const replayHistory = (ptyId: string, source: 'spawned-terminal' | 'external-terminal'): void => {
    const store = useTerminalStore.getState()
    const transcript = store.peekTranscript(ptyId)
    const partial = looksPartial(transcript)
    const scrollback = binding.initialScrollback
    const mode = transcript ? 'transcript' : scrollback?.length ? 'scrollback' : 'none'
    record(
      'restore-replay-attempted',
      {
        mode,
        transcriptLength: transcript.length,
        initialScrollbackLineCount: scrollback?.length ?? 0,
        source,
        alternateScreenDetected: partial
      },
      ptyId
    )
    try {
      if (transcript) {
        // R3: the full captured DEC mode set first; a trimmed transcript may miss its mode sequences.
        screen.write(buildRehydrateSequences(binding.initialModes))
        screen.write(transcript)
        if (partial) screen.write(PARTIAL_RESTORE_NOTE)
        store.consumeTranscript(ptyId)
        record(
          'restore-replay-succeeded',
          {
            mode: 'transcript',
            transcriptLength: transcript.length,
            source,
            fullFidelity: !partial,
            restoreLimitation: partial ? 'alternate-screen-or-in-place-redraw' : undefined
          },
          ptyId
        )
      } else if (scrollback && scrollback.length > 0) {
        restoreScrollback(xterm, scrollback, binding.initialModes)
        record(
          'restore-replay-succeeded',
          {
            mode: 'scrollback',
            initialScrollbackLineCount: scrollback.length,
            modesReplayed: Boolean(binding.initialModes),
            source
          },
          ptyId
        )
      } else {
        record('restore-replay-skipped', { reason: 'no-persisted-history', source }, ptyId)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      record('restore-replay-failed', { mode, error: message, source }, ptyId)
      log.error('terminal', `replay.failed ${JSON.stringify({ source, error: message })}`)
      binding.onError?.(message)
    }
  }

  /**
   * A cached screen (#1123 / #795): exactly the bytes it missed while
   * detached, in order. A trimmed delta lost its head, so the screen is
   * rebuilt from its own mode snapshot before the tail instead.
   */
  const replayDelta = (ptyId: string): boolean => {
    const store = useTerminalStore.getState()
    const transcript = store.peekTranscript(ptyId)
    const trimmed = store.findTerminalByPtyId(ptyId)?.transcriptTrimmed === true
    record(
      'restore-replay-attempted',
      {
        mode: transcript ? 'transcript' : 'none',
        transcriptLength: transcript.length,
        transcriptTrimmed: trimmed,
        source: 'cached-terminal'
      },
      ptyId
    )
    try {
      if (!transcript) {
        if (trimmed) store.consumeTranscript(ptyId)
        record(
          'restore-replay-skipped',
          { reason: 'no-missed-output', source: 'cached-terminal' },
          ptyId
        )
        return false
      }
      if (trimmed) {
        const modes = snapshotXtermModes(screen.terminal)
        screen.terminal.reset()
        screen.write(buildRehydrateSequences(modes))
      }
      screen.write(transcript)
      store.consumeTranscript(ptyId)
      record(
        'restore-replay-succeeded',
        {
          mode: 'transcript',
          transcriptLength: transcript.length,
          source: 'cached-terminal',
          fullFidelity: !trimmed,
          restoreLimitation: trimmed ? 'transcript-trimmed' : undefined
        },
        ptyId
      )
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      record(
        'restore-replay-failed',
        { mode: 'transcript', error: message, source: 'cached-terminal' },
        ptyId
      )
      log.error(
        'terminal',
        `replay.failed ${JSON.stringify({ source: 'cached-terminal', error: message })}`
      )
      binding.onError?.(message)
      return false
    }
  }

  if (externalTerminalId) {
    if (isTerminalPendingPtyAssignment(externalTerminalId)) {
      log.info('terminal', 'session.pending-pty-assignment')
      return
    }
    binding.bindPty(externalTerminalId)
    registerTerminal(externalTerminalId, xterm)
    // Drain detached chunks still waiting for their frame, so the transcript
    // read below holds everything this view missed (#1123).
    flushDetachedOutputNow()
    let deltaWritten = false
    if (cached) deltaWritten = replayDelta(externalTerminalId)
    else replayHistory(externalTerminalId, 'external-terminal')
    // Never into a cached screen: it showed the line already, and injected
    // bytes shift a live TUI's cursor math (#795).
    const line = cached ? null : envLine(binding.spawnOptions?.env)
    if (line) screen.write(line)
    // After a delta the pre-detach viewport would pin the view above the new output.
    if (deltaWritten) clearScrollPosition(externalTerminalId)
    else restoreScrollPosition(externalTerminalId, xterm)
    log.info('terminal', `session.attached ${JSON.stringify({ cached, deltaWritten })}`)
    binding.onBound?.(externalTerminalId)
    return
  }

  if (!binding.autoSpawn || binding.busy()) return
  binding.setSpawning(true)
  try {
    const options = binding.spawnOptions
    const result = await terminalApi.spawn({
      ...options,
      shell: options?.shell || undefined,
      cols: screen.cols || 80,
      rows: screen.rows || 24
    })
    if (!binding.isCurrent()) {
      if (result.success) log.warn('terminal', 'session.spawned-after-unmount')
      return
    }
    if (!result.success) {
      const message = result.error || 'Unknown spawn error'
      log.error('terminal', `session.spawn-failed ${JSON.stringify({ code: result.code })}`)
      screen.write(`\x1b[31m\r\nFailed to spawn terminal process:\r\n${message}\x1b[0m\r\n`)
      binding.onError?.(message)
      return
    }
    const ptyId = result.data.id
    binding.bindPty(ptyId)
    useTerminalStore.getState().setRendererAttached(ptyId, true)
    registerTerminal(ptyId, xterm)
    replayHistory(ptyId, 'spawned-terminal')
    const line = envLine(options?.env)
    if (line) screen.write(line)
    restoreScrollPosition(ptyId, xterm)
    log.info(
      'terminal',
      `session.spawned ${JSON.stringify({ cols: result.data.cols, rows: result.data.rows })}`
    )
    binding.onSpawned?.(ptyId)
    binding.onBound?.(ptyId)
    // CAP-3: the lease goes on the store record once onBound bound its ptyId.
    if (result.data.claim) useTerminalStore.getState().setTerminalClaim(ptyId, result.data.claim)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Spawn failed'
    log.error('terminal', `session.spawn-threw ${JSON.stringify({ error: message })}`)
    screen.write(`\x1b[31m\r\nTerminal spawn exception:\r\n${message}\x1b[0m\r\n`)
    binding.onError?.(message)
  } finally {
    binding.setSpawning(false)
  }
}
