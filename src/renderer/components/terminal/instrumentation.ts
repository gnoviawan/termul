import type { TerminalSpawnOptions } from '../../../shared/types/ipc.types'

export const PARTIAL_RESTORE_NOTE =
  '\x1b[33m\r\n[Restore note: alternate-screen or redraw-heavy output may be partially reconstructed from transcript replay]\x1b[0m\r\n'

export function getInstrumentationProjectId(
  spawnOptions?: TerminalSpawnOptions
): string | undefined {
  const candidate = spawnOptions?.projectId
  return typeof candidate === 'string' ? candidate : undefined
}
