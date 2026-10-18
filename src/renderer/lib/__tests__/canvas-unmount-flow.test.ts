/**
 * The project-close / quit unmount flow against the real canvas store and a
 * mocked facade: a failed save asks the user, and only their answer decides
 * whether the work is retried, discarded or kept.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { close } = vi.hoisted(() => ({ close: vi.fn() }))

vi.mock('@/lib/canvas-api', () => ({ canvasApi: { close } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import type { CanvasOpenInfo } from '@shared/types/canvas.types'
import { type CanvasSession, useCanvasStore } from '@/stores/canvas-store'
import {
  type CanvasUnmountChoice,
  unmountCanvases,
  useCanvasUnmountPrompt
} from '../canvas-unmount-flow'

const INFO: CanvasOpenInfo = {
  canvasId: 'cv0123456789abcdef',
  baseUrl: 'http://127.0.0.1:5199',
  canvasToken: 'cafe',
  pinTag: 'termul-v1',
  docKey: 'C:/proj/design.figcraft',
  mountSeq: 4
}

const UNMOUNTED = {
  success: true,
  data: { unmounted: true, savedVersion: '7', discarded: false }
} as const
const SAVE_FAILED = { success: false, error: 'disk full', code: 'SAVE_FAILED' } as const

function session(projectId: string): CanvasSession {
  return {
    projectId,
    docPath: `C:/${projectId}/design.figcraft`,
    phase: { kind: 'ready', mount: { mountSeq: 4, info: INFO } },
    dirty: true,
    contentVersion: '7',
    savedVersion: '6',
    saving: false,
    saveError: null,
    closing: false
  }
}

/** Answer the next question the flow asks with `choice`. */
async function answerNext(choice: CanvasUnmountChoice): Promise<string> {
  await vi.waitFor(() => expect(useCanvasUnmountPrompt.getState().question).not.toBeNull())
  const question = useCanvasUnmountPrompt.getState().question
  useCanvasUnmountPrompt.getState().answer(choice)
  return question?.docName ?? ''
}

const original = useCanvasStore.getState()

beforeEach(() => {
  close.mockReset()
  useCanvasStore.setState({ ...original, sessions: { a: session('a'), b: session('b') } }, true)
})

afterEach(() => {
  useCanvasStore.setState(original, true)
  useCanvasUnmountPrompt.setState({ question: null })
})

describe('unmountCanvases', () => {
  it('unmounts every canvas through the host when each save succeeds', async () => {
    close.mockResolvedValue(UNMOUNTED)
    await expect(unmountCanvases()).resolves.toBe(true)
    expect(close.mock.calls).toEqual([
      ['a', false],
      ['b', false]
    ])
    expect(useCanvasStore.getState().sessions).toEqual({})
  })

  it('a failed save asks, and retry saves again', async () => {
    close.mockResolvedValueOnce(SAVE_FAILED).mockResolvedValue(UNMOUNTED)
    const done = unmountCanvases(['a'])
    expect(await answerNext('retry')).toBe('design.figcraft')
    await expect(done).resolves.toBe(true)
    expect(close.mock.calls).toEqual([
      ['a', false],
      ['a', false]
    ])
  })

  it('discard drops the changes only after the user chose it', async () => {
    close.mockResolvedValueOnce(SAVE_FAILED).mockResolvedValue({
      success: true,
      data: { unmounted: true, savedVersion: null, discarded: true }
    })
    const done = unmountCanvases(['a'])
    await answerNext('discard')
    await expect(done).resolves.toBe(true)
    expect(close).toHaveBeenLastCalledWith('a', true)
    expect(useCanvasStore.getState().sessions.a).toBeUndefined()
  })

  it('keep editing stops the close and leaves the canvas mounted', async () => {
    close.mockResolvedValue(SAVE_FAILED)
    const done = unmountCanvases()
    await answerNext('keep')
    await expect(done).resolves.toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
    expect(useCanvasStore.getState().sessions.a?.phase.kind).toBe('ready')
    expect(useCanvasStore.getState().sessions.b).toBeDefined()
  })
})
