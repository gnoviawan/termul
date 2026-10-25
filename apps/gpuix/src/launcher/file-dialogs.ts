/**
 * The native file dialogs behind `DesktopHost.openFiles` and `saveFile`:
 * GPUI's path prompts (the xdg-desktop-portal file chooser on Linux), which
 * exist only once the window does. `fileAt` hands a picked path to the shared
 * attachment code as the same lazy `File` an OS drop gives it.
 */

import os from 'node:os'
import path from 'node:path'
import type { DesktopHost } from '@/lib/desktop-host'
import { openDroppedFile } from '../env/files'
import { log } from '../log'

/** The renderer methods the dialogs use. `promptForNewPath` comes from native patch gpuix/0008. */
export interface PathPrompter {
  promptForPaths(options?: { files?: boolean; multiple?: boolean }): Promise<string[] | null>
  promptForNewPath?(options: { directory: string; suggestedName?: string }): Promise<string | null>
}

export type FileDialogs = Pick<DesktopHost, 'openFiles' | 'saveFile' | 'fileAt'>

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function logged<T>(kind: string, prompt: () => Promise<T>): Promise<T> {
  try {
    return await prompt()
  } catch (error) {
    log.warn('file-dialog', `${kind} failed: ${describe(error)}`)
    throw error
  }
}

export function createFileDialogs(
  prompter: () => PathPrompter | null,
  directory: () => string = os.homedir
): FileDialogs {
  const ready = (): PathPrompter => {
    const renderer = prompter()
    if (!renderer) throw new Error('The window is not open yet')
    return renderer
  }
  return {
    openFiles: ({ multiple }) =>
      logged('open', () => ready().promptForPaths({ files: true, multiple })),
    saveFile: ({ defaultPath }) =>
      logged('save', async () => {
        const renderer = ready()
        if (!renderer.promptForNewPath) {
          throw new Error('This GPUIX build has no save dialog (native patch gpuix/0008)')
        }
        if (defaultPath && path.isAbsolute(defaultPath)) {
          return renderer.promptForNewPath({
            directory: path.dirname(defaultPath),
            suggestedName: path.basename(defaultPath)
          })
        }
        return renderer.promptForNewPath({ directory: directory(), suggestedName: defaultPath })
      }),
    fileAt: openDroppedFile
  }
}
