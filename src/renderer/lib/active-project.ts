/**
 * The device's own active project, kept under `PersistenceKeys.activeProject`
 * (device scope: each device keeps its own selection). Only an explicit project
 * switch writes it. The host registry is never touched by navigation, and the
 * host default is only where a device with no choice of its own lands.
 */

import { PersistenceKeys } from '@shared/types/persistence.types'
import { persistenceApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'

/** The saved selection, or `null` when this device has none (or it cannot be read). */
export async function readActiveProject(): Promise<string | null> {
  const result = await persistenceApi.read<string>(PersistenceKeys.activeProject)
  return result.success && typeof result.data === 'string' && result.data ? result.data : null
}

/** Save this device's selection. A lost write only degrades to the host default on reload. */
export function writeActiveProject(projectId: string): void {
  void persistenceApi
    .write(PersistenceKeys.activeProject, projectId)
    .then((result) => {
      if (!result.success) {
        void logFrontendError({
          level: 'warn',
          source: 'active-project.write',
          message: `persisting the active project failed: ${result.error ?? 'unknown'}`
        })
      }
    })
    .catch((error: unknown) => {
      void logFrontendError({
        level: 'warn',
        source: 'active-project.write',
        message: `persisting the active project failed: ${error instanceof Error ? error.message : String(error)}`
      })
    })
}
