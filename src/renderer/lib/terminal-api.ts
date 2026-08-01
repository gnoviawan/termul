/**
 * Terminal API Singleton
 *
 * Exports a singleton instance of the TerminalApi for use throughout the app.
 * This provides a consistent interface whether running under Electron or Tauri.
 *
 * Usage:
 *   import { terminalApi } from '@/lib/terminal-api'
 *   await terminalApi.spawn({ cwd: '/path' })
 */

import type { IpcResult, TerminalApi } from '@shared/types/ipc.types'
import { isTauriContext } from './tauri-runtime'
import { createTauriTerminalApi } from './tauri-terminal-api'
import { createWebTerminalApi, webTerminalInternals } from './web-terminal-api'

/**
 * Singleton TerminalApi instance
 *
 * Uses Tauri IPC implementation when running in Tauri context.
 * In the future, this could conditionally export an Electron implementation
 * based on build environment.
 */
export const terminalApi: TerminalApi = isTauriContext()
  ? createTauriTerminalApi()
  : createWebTerminalApi()

export async function addRendererRef(ptyId: string, rendererId: string): Promise<IpcResult<void>> {
  if (isTauriContext()) {
    const { addRendererRef: addTauriRendererRef } = await import('./tauri-terminal-api')
    return addTauriRendererRef(ptyId, rendererId)
  }
  return webTerminalInternals.addRendererRef(ptyId, rendererId)
}

export async function removeRendererRef(
  ptyId: string,
  rendererId: string
): Promise<IpcResult<void>> {
  if (isTauriContext()) {
    const { removeRendererRef: removeTauriRendererRef } = await import('./tauri-terminal-api')
    return removeTauriRendererRef(ptyId, rendererId)
  }
  return webTerminalInternals.removeRendererRef(ptyId, rendererId)
}

export async function setTerminalProtected(
  ptyId: string,
  protectedState: boolean
): Promise<IpcResult<void>> {
  if (isTauriContext()) {
    const { setTerminalProtected: setTauriTerminalProtected } = await import('./tauri-terminal-api')
    return setTauriTerminalProtected(ptyId, protectedState)
  }
  return webTerminalInternals.setProtected(ptyId, protectedState)
}
