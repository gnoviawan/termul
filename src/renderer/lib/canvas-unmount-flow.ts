/**
 * Unmounting canvases before a project closes or the app quits (spine
 * AD-31). The host runs quiesce → save → verify → unmount for each mount;
 * when a save fails the user picks retry, discard or keep editing, so
 * unsaved work is never dropped without their say-so.
 */

import { create } from 'zustand'
import { logFrontendError } from '@/lib/log-api'
import { basename } from '@/lib/path-basename'
import { useCanvasStore } from '@/stores/canvas-store'

export type CanvasUnmountChoice = 'retry' | 'discard' | 'keep'

export interface CanvasUnmountQuestion {
  projectId: string
  docName: string
  message: string
}

interface PromptState {
  question: CanvasUnmountQuestion | null
  answer: (choice: CanvasUnmountChoice) => void
}

let resolveQuestion: ((choice: CanvasUnmountChoice) => void) | null = null

/** The open question, rendered by `CanvasUnmountDialog`. */
export const useCanvasUnmountPrompt = create<PromptState>((set) => ({
  question: null,
  answer: (choice) => {
    const resolve = resolveQuestion
    resolveQuestion = null
    set({ question: null })
    resolve?.(choice)
  }
}))

function ask(question: CanvasUnmountQuestion): Promise<CanvasUnmountChoice> {
  resolveQuestion?.('keep')
  return new Promise((resolve) => {
    resolveQuestion = resolve
    useCanvasUnmountPrompt.setState({ question })
  })
}

function log(level: 'info' | 'warn', message: string): void {
  void logFrontendError({ level, source: 'canvas-unmount-flow', message })
}

/** Unmount one project's canvas, asking the user while its save fails. False
 * when they chose to keep editing. */
async function unmountOne(projectId: string): Promise<boolean> {
  const store = useCanvasStore.getState
  for (;;) {
    const session = store().sessions[projectId]
    if (!session) return true
    const result = await store().unmountCanvas(projectId)
    if (result.success) return true
    const choice = await ask({
      projectId,
      docName: basename(session.docPath),
      message: result.error
    })
    log('warn', `canvas save before unmount failed for project ${projectId}; user chose ${choice}`)
    if (choice === 'keep') return false
    if (choice === 'discard') {
      const discarded = await store().unmountCanvas(projectId, true)
      if (discarded.success) return true
      log('warn', `canvas discard failed for project ${projectId}: ${discarded.code}`)
    }
  }
}

/**
 * Unmount the canvases of `projectIds` (every mounted canvas when omitted),
 * one at a time. False when the user chose to keep editing one of them: the
 * close or quit that asked must not go ahead.
 */
export async function unmountCanvases(projectIds?: string[]): Promise<boolean> {
  const targets = projectIds ?? Object.keys(useCanvasStore.getState().sessions)
  for (const projectId of targets) {
    if (!(await unmountOne(projectId))) {
      log('info', `canvas unmount stopped: the user kept editing project ${projectId}`)
      return false
    }
  }
  return true
}
