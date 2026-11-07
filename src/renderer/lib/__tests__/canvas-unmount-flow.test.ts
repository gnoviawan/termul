/**
 * The project-close / quit unmount flow against the real canvas store and a
 * mocked facade: a failed save asks the user, and only their answer decides
 * whether the work is retried, discarded or kept.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { close, open } = vi.hoisted(() => ({ close: vi.fn(), open: vi.fn() }))

vi.mock('@/lib/canvas-api', () => ({ canvasApi: { close, open } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import type { CanvasOpenInfo } from '@shared/types/canvas.types'
import { type CanvasSession, useCanvasStore } from '@/stores/canvas-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import {
  type CanvasUnmountChoice,
  unmountCanvases,
  unmountCanvasesFor,
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
  open.mockReset()
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
      ['a', 4, false],
      ['b', 4, false]
    ])
    expect(useCanvasStore.getState().sessions).toEqual({})
  })

  it('a failed save asks, and retry saves again', async () => {
    close.mockResolvedValueOnce(SAVE_FAILED).mockResolvedValue(UNMOUNTED)
    const done = unmountCanvases(['a'])
    expect(await answerNext('retry')).toBe('design.figcraft')
    await expect(done).resolves.toBe(true)
    expect(close.mock.calls).toEqual([
      ['a', 4, false],
      ['a', 4, false]
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
    expect(close).toHaveBeenLastCalledWith('a', 4, true)
    expect(useCanvasStore.getState().sessions.a).toBeUndefined()
  })

  it('concurrent flows each get their own question and answer', async () => {
    close.mockImplementation((projectId: string, _mountSeq: number, discard: boolean) =>
      Promise.resolve(
        discard
          ? { success: true, data: { unmounted: true, savedVersion: null, discarded: true } }
          : close.mock.calls.filter(([id]) => id === projectId).length > 1
            ? UNMOUNTED
            : SAVE_FAILED
      )
    )
    const first = unmountCanvases(['a'])
    const second = unmountCanvases(['b'])
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(useCanvasUnmountPrompt.getState().question?.projectId).toBe('a'))
    useCanvasUnmountPrompt.getState().answer('retry')
    await vi.waitFor(() => expect(useCanvasUnmountPrompt.getState().question?.projectId).toBe('b'))
    useCanvasUnmountPrompt.getState().answer('discard')
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(close.mock.calls).toEqual([
      ['a', 4, false],
      ['b', 4, false],
      ['a', 4, false],
      ['b', 4, true]
    ])
    expect(useCanvasUnmountPrompt.getState().question).toBeNull()
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

describe('unmountCanvasesFor', () => {
  it('mounts the canvases again, without opening their tabs, when the host refuses afterwards', async () => {
    close.mockResolvedValue(UNMOUNTED)
    open.mockResolvedValue({ success: true, data: { ...INFO, mountSeq: 9, evicted: [] } })
    const addCanvasTab = vi.spyOn(useWorkspaceStore.getState(), 'addCanvasTab')

    const remount = await unmountCanvasesFor(['a'])
    expect(useCanvasStore.getState().sessions.a).toBeUndefined()
    expect(remount).not.toBeNull()

    remount?.()
    await vi.waitFor(() => expect(useCanvasStore.getState().sessions.a?.phase.kind).toBe('loading'))
    expect(open).toHaveBeenCalledWith('C:/a/design.figcraft', 'a', expect.any(Object))
    expect(addCanvasTab).not.toHaveBeenCalled()
    addCanvasTab.mockRestore()
  })

  it('leaves a canvas the user opened meanwhile in place', async () => {
    close.mockResolvedValue(UNMOUNTED)
    const remount = await unmountCanvasesFor(['a'])
    const newer = { ...session('a'), docPath: 'C:/a/poster.figcraft' }
    useCanvasStore.setState({ sessions: { ...useCanvasStore.getState().sessions, a: newer } })

    remount?.()
    await Promise.resolve()
    expect(useCanvasStore.getState().sessions.a).toEqual(newer)
    expect(close).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })

  it('is null when the user keeps editing', async () => {
    close.mockResolvedValue(SAVE_FAILED)
    const done = unmountCanvasesFor(['a'])
    await answerNext('keep')
    await expect(done).resolves.toBeNull()
  })
})
