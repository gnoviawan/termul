/**
 * Shared terminal-domain fixtures for tests.
 *
 * Census (spec-06 Part B): `{id, name, projectId, shell, …}` `Terminal`
 * literals, `{id, name, shell, cwd, scrollback}` `PersistedTerminal` literals,
 * `{id, shell, cwd, pid, cols, rows, claim}` `SpawnedTerminal` /
 * `PreservedTerminalEntry` literals, and `TerminalAttachResult` payloads were
 * hand-copied across ~20 test files. These factories cover the union of
 * observed fields; per-call overrides keep each test's assertions intact.
 *
 * NOTE: this file is covered by `typecheck:web` (not just the test config) —
 * keep imports limited to type-only contracts and plain functions. Never
 * generate UUIDs here — parity-checklist bans direct crypto UUID calls
 * outside `@/lib/uuid` (and even mentioning the literal API name trips the
 * scan).
 */
import type {
  PreservedTerminalEntry,
  SpawnedTerminal,
  TerminalAttachResult,
  TerminalStateSnapshot
} from '@shared/types/ipc.types'
import type { PersistedTerminal, PersistedTerminalLayout } from '@shared/types/persistence.types'
import type { TerminalDescriptor } from '@shared/types/workspace-manifest.types'
import type { Terminal } from '@/types/project'

/** In-memory store `Terminal` record. */
export function mockTerminal(overrides: Partial<Terminal> = {}): Terminal {
  return {
    id: 'term-1',
    name: 'Terminal 1',
    projectId: 'project-1',
    shell: 'bash',
    ...overrides
  }
}

/** On-disk persisted terminal record (`terminals/{projectId}.json` entry). */
export function mockPersistedTerminal(
  overrides: Partial<PersistedTerminal> = {}
): PersistedTerminal {
  return {
    id: 'term-1',
    name: 'Terminal 1',
    shell: 'bash',
    ...overrides
  }
}

/** On-disk persisted layout (`{activeTerminalId, terminals, updatedAt}`). */
export function mockPersistedLayout(
  overrides: Partial<PersistedTerminalLayout> = {}
): PersistedTerminalLayout {
  return {
    activeTerminalId: null,
    terminals: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

/**
 * Spawn-response `data` payload. `claim` defaults to a fixed string because
 * most spawn mocks exercise the claim path — pass an explicit override when
 * the scenario needs a different value, or drop the field entirely when the
 * scenario asserts a claim-less spawn.
 */
export function mockSpawnedTerminal(overrides: Partial<SpawnedTerminal> = {}): SpawnedTerminal {
  return {
    id: 'pty-1',
    shell: 'bash',
    cwd: '/test',
    pid: 1,
    cols: 80,
    rows: 24,
    claim: 'claim-pty-1',
    ...overrides
  }
}

/** `snapshot` sub-object carried by `TerminalAttachResult`. */
export function mockTerminalStateSnapshot(
  overrides: Partial<TerminalStateSnapshot> = {}
): TerminalStateSnapshot {
  return {
    cwd: null,
    gitBranch: null,
    gitStatus: null,
    exitCode: null,
    exited: false,
    ...overrides
  }
}

/** Attach-response `data` payload (latestSeq + gap + state snapshot). */
export function mockAttachResult(
  overrides: Partial<TerminalAttachResult> = {}
): TerminalAttachResult {
  return {
    id: 'pty-1',
    shell: 'bash',
    cwd: '/test',
    pid: 1,
    cols: 80,
    rows: 24,
    latestSeq: 0,
    gap: false,
    snapshot: mockTerminalStateSnapshot(),
    ...overrides
  }
}

/** `listPreserved` entry — host-preserved PTY metadata + optional claim. */
export function mockPreservedPty(
  overrides: Partial<PreservedTerminalEntry> = {}
): PreservedTerminalEntry {
  return {
    id: 'pty-1',
    shell: 'bash',
    cwd: '/test',
    pid: 1,
    cols: 80,
    rows: 24,
    ...overrides
  }
}

/** Workspace-manifest terminal descriptor (portable cross-client record). */
export function mockTerminalDescriptor(
  overrides: Partial<TerminalDescriptor> = {}
): TerminalDescriptor {
  return {
    terminalId: 'term-1',
    projectId: 'project-1',
    shell: 'bash',
    cwd: '/test',
    name: 'Terminal 1',
    ...overrides
  }
}
