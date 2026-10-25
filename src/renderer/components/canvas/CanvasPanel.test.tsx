/**
 * CanvasPanel and CanvasMountLayer against the real canvas store: what each
 * mount phase renders, the iframe URL, the hidden mount a closed tab leaves
 * (AD-19), the phone-width gate, theme/locale re-sends, and the unsaved dot,
 * Save button and save error.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { phoneWidth } = vi.hoisted(() => ({ phoneWidth: { value: false } }))

vi.mock('@/hooks/use-mobile-web-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-mobile-web-shell')>()
  return { ...actual, useMobileWebShell: () => phoneWidth.value }
})
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import type { CanvasOpenInfo } from '@shared/types/canvas.types'
import { COLOR_THEME_CHANGED_EVENT } from '@/lib/themes'
import { type CanvasPhase, type CanvasSession, useCanvasStore } from '@/stores/canvas-store'
import { CanvasMountLayer } from './CanvasMountLayer'
import { CanvasPanel } from './CanvasPanel'
import { OFFSCREEN_FRAME_STYLE } from './CanvasShell'

const PROJECT = 'proj-1'
const DOC = 'C:/proj/design.figcraft'
const INFO: CanvasOpenInfo = {
  canvasId: 'cv0123456789abcdef',
  baseUrl: 'http://127.0.0.1:5199',
  canvasToken: 'cafe',
  pinTag: 'termul-v1',
  docKey: DOC,
  mountSeq: 4,
  evicted: [],
  fallbackFonts: []
}

function setPhase(phase: CanvasPhase, projection: Partial<CanvasSession> = {}): void {
  useCanvasStore.setState({
    sessions: {
      [PROJECT]: {
        projectId: PROJECT,
        docPath: DOC,
        phase,
        dirty: false,
        contentVersion: null,
        savedVersion: null,
        saving: false,
        saveError: null,
        closing: false,
        ...projection
      }
    }
  })
}

/** The workspace as `WorkspaceLayout` renders it: the tab's panel (absent
 * once the tab is closed) beside the mount layer. */
function Workspace({ tab }: { tab: 'visible' | 'hidden' | 'closed' }): React.JSX.Element {
  return (
    <>
      {tab !== 'closed' && (
        <CanvasPanel projectId={PROJECT} docPath={DOC} isVisible={tab === 'visible'} />
      )}
      <CanvasMountLayer />
    </>
  )
}

function renderPanel() {
  return render(<Workspace tab="visible" />)
}

function frame(): HTMLIFrameElement {
  return screen.getByTitle('Canvas — design.figcraft') as HTMLIFrameElement
}

/** The editor in `iframe` reports `event.ready` to its bridge. */
function editorReady(iframe: HTMLIFrameElement): void {
  const event = new MessageEvent('message', { data: { method: 'event.ready', mountSeq: 4 } })
  Object.defineProperty(event, 'origin', { value: 'http://127.0.0.1:5199' })
  Object.defineProperty(event, 'source', { value: iframe.contentWindow })
  act(() => {
    window.dispatchEvent(event)
  })
}

const original = useCanvasStore.getState()
const setCanvasVisible = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  phoneWidth.value = false
  setCanvasVisible.mockClear()
  useCanvasStore.setState({ ...original, setCanvasVisible }, true)
})

afterEach(() => {
  useCanvasStore.setState(original, true)
})

describe('CanvasPanel', () => {
  it('mounts the editor at the kiosk URL for the current mount', () => {
    setPhase({ kind: 'loading', mount: { mountSeq: 4, info: INFO } })
    renderPanel()

    const iframe = screen.getByTitle('Canvas — design.figcraft') as HTMLIFrameElement
    const origin = encodeURIComponent(window.location.origin)
    expect(iframe.src).toBe(
      `http://127.0.0.1:5199/canvas/cv0123456789abcdef/cafe/?embed=kiosk&ho=${origin}&ms=4`
    )
    expect(iframe.dataset.canvasMountSeq).toBe('4')
    expect(screen.getByText('Loading editor…')).toBeTruthy()
  })

  it('lays the iframe over the visible panel', async () => {
    setPhase({ kind: 'ready', mount: { mountSeq: 4, info: INFO } })
    renderPanel()
    await waitFor(() => expect(frame().dataset.canvasFrameState).toBe('visible'))
    expect(frame().style.position).toBe('fixed')
    expect(frame().style.left).not.toBe(OFFSCREEN_FRAME_STYLE.left)
  })

  it('closing the tab keeps the same iframe mounted offscreen 1×1, never display:none', async () => {
    setPhase({ kind: 'ready', mount: { mountSeq: 4, info: INFO } })
    const view = renderPanel()
    const mounted = frame()
    const postMessage = vi.spyOn(mounted.contentWindow as Window, 'postMessage')
    editorReady(mounted)

    view.rerender(<Workspace tab="closed" />)

    await waitFor(() => expect(frame().dataset.canvasFrameState).toBe('hidden'))
    expect(frame()).toBe(mounted)
    expect(mounted.isConnected).toBe(true)
    expect(mounted.style.display).not.toBe('none')
    expect(getComputedStyle(mounted).display).not.toBe('none')
    expect(getComputedStyle(mounted).visibility).not.toBe('hidden')
    expect(mounted.style).toMatchObject({
      position: 'fixed',
      left: '-10000px',
      width: '1px',
      height: '1px'
    })
    expect(mounted.getAttribute('aria-hidden')).toBe('true')

    // Agent calls still reach the hidden editor.
    void useCanvasStore.getState().callCanvas(PROJECT, 'document.inspect')
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'document.inspect', mountSeq: 4 }),
        'http://127.0.0.1:5199'
      )
    )

    // Reopening the tab shows the same mount: no remount, same mountSeq.
    view.rerender(<Workspace tab="visible" />)
    await waitFor(() => expect(frame().dataset.canvasFrameState).toBe('visible'))
    expect(frame()).toBe(mounted)
    expect(frame().dataset.canvasMountSeq).toBe('4')
  })

  it('a tab switched away hides the frame the same way', async () => {
    setPhase({ kind: 'ready', mount: { mountSeq: 4, info: INFO } })
    const view = renderPanel()
    const mounted = frame()
    view.rerender(<Workspace tab="hidden" />)
    await waitFor(() => expect(frame().dataset.canvasFrameState).toBe('hidden'))
    expect(frame()).toBe(mounted)
    expect(mounted.style.left).toBe('-10000px')
  })

  it('only the host unmount ends the mount: dropping the session closes its bridge', async () => {
    setPhase({ kind: 'loading', mount: { mountSeq: 4, info: INFO } })
    const view = renderPanel()
    const pending = useCanvasStore.getState().callCanvas(PROJECT, 'document.inspect')
    view.rerender(<Workspace tab="closed" />)
    await expect(Promise.race([pending, Promise.resolve('waiting')])).resolves.toBe('waiting')

    act(() => useCanvasStore.setState({ sessions: {} }))
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CANVAS_CLOSED' } })
    expect(screen.queryByTitle(/Canvas —/)).toBeNull()
  })

  it('shows why a mount failed instead of an iframe', () => {
    setPhase({
      kind: 'failed',
      code: 'BUNDLE_PIN_MISMATCH',
      message: 'Bundle mismatch.',
      mountSeq: 4
    })
    renderPanel()

    expect(screen.getByTestId('canvas-mount-failed').textContent).toBe('Bundle mismatch.')
    expect(screen.queryByTitle(/Canvas —/)).toBeNull()
  })

  it('shows a canvas open in another window with a Take back that opens it here', async () => {
    const openCanvas = vi.fn().mockResolvedValue(true)
    setPhase({ kind: 'elsewhere' })
    useCanvasStore.setState({ openCanvas })
    renderPanel()

    expect(screen.getByTestId('canvas-open-elsewhere').textContent).toContain(
      'open in another window'
    )
    expect(screen.queryByTitle(/Canvas —/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Save canvas' })).toHaveProperty('disabled', true)
    const takeBack = screen.getByRole('button', { name: 'Take back' })
    fireEvent.click(takeBack)
    expect(openCanvas).toHaveBeenCalledWith(PROJECT, DOC)
    expect(takeBack).toHaveProperty('disabled', true)
    await waitFor(() => expect(takeBack).toHaveProperty('disabled', false))
  })

  it('tells the host while a mounted canvas is on screen, and when it leaves', async () => {
    setPhase({ kind: 'ready', mount: { mountSeq: 4, info: INFO } })
    const view = renderPanel()
    await waitFor(() => expect(setCanvasVisible).toHaveBeenCalledWith(PROJECT, 4, true))

    view.rerender(<Workspace tab="hidden" />)
    await waitFor(() => expect(setCanvasVisible).toHaveBeenLastCalledWith(PROJECT, 4, false))
  })

  it('a canvas whose tab was never shown reports nothing', () => {
    setPhase({ kind: 'ready', mount: { mountSeq: 4, info: INFO } })
    render(<Workspace tab="hidden" />)
    expect(setCanvasVisible).not.toHaveBeenCalled()
  })

  it('an evicted canvas says it was unloaded to save memory and reopens on click', () => {
    const openCanvas = vi.fn().mockResolvedValue(true)
    setPhase({ kind: 'unloaded', reason: 'evicted', message: null })
    useCanvasStore.setState({ openCanvas })
    renderPanel()

    expect(screen.getByTestId('canvas-unloaded').textContent).toContain(
      'unloaded to save memory. Click to reopen'
    )
    expect(screen.getByText('Unloaded')).toBeTruthy()
    expect(screen.queryByTitle(/Canvas —/)).toBeNull()
    expect(setCanvasVisible).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Reopen canvas' }))
    expect(openCanvas).toHaveBeenCalledWith(PROJECT, DOC)
  })

  it('an open blocked by an unsaved canvas shows the typed error and offers to try again', () => {
    const openCanvas = vi.fn().mockResolvedValue(true)
    setPhase({
      kind: 'unloaded',
      reason: 'blocked',
      message: 'could not unload the least recently active canvas (project p2) to make room'
    })
    useCanvasStore.setState({ openCanvas })
    renderPanel()

    expect(screen.getByTestId('canvas-unloaded').textContent).toContain(
      'could not unload the least recently active canvas (project p2)'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(openCanvas).toHaveBeenCalledWith(PROJECT, DOC)
  })

  it('is gated off on phone-width viewports', () => {
    phoneWidth.value = true
    setPhase({ kind: 'loading', mount: { mountSeq: 4, info: INFO } })
    renderPanel()

    expect(screen.getByTestId('canvas-unsupported-surface')).toBeTruthy()
    expect(frame().dataset.canvasFrameState).toBe('hidden')
  })

  it('re-sends theme and locale when they change, without remounting', () => {
    const pushTheme = vi.fn()
    const pushLocale = vi.fn()
    setPhase({ kind: 'ready', mount: { mountSeq: 4, info: INFO } })
    useCanvasStore.setState({ pushTheme, pushLocale })
    renderPanel()
    const iframe = screen.getByTitle('Canvas — design.figcraft')

    act(() => {
      window.dispatchEvent(new CustomEvent(COLOR_THEME_CHANGED_EVENT, { detail: {} }))
      window.dispatchEvent(new Event('languagechange'))
    })

    expect(pushTheme).toHaveBeenCalledWith(PROJECT)
    expect(pushLocale).toHaveBeenCalledWith(PROJECT)
    expect(screen.getByTitle('Canvas — design.figcraft')).toBe(iframe)
  })

  it('shows the unsaved dot while dirty and saves on the Save button', () => {
    const saveCanvas = vi.fn().mockResolvedValue(true)
    setPhase({ kind: 'ready', mount: { mountSeq: 4, info: INFO } }, { dirty: true })
    useCanvasStore.setState({ saveCanvas })
    renderPanel()

    expect(screen.getByLabelText('Unsaved changes')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save canvas' }))
    expect(saveCanvas).toHaveBeenCalledWith(PROJECT)
  })

  it('clears the dot when saved, disables Save while loading or saving, shows a save error', () => {
    setPhase({ kind: 'loading', mount: { mountSeq: 4, info: INFO } })
    const view = renderPanel()
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save canvas' }).hasAttribute('disabled')).toBe(true)
    view.unmount()

    setPhase(
      { kind: 'ready', mount: { mountSeq: 4, info: INFO } },
      { saving: true, saveError: 'could not write the canvas document: disk full' }
    )
    renderPanel()
    expect(screen.getByRole('button', { name: 'Save canvas' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('canvas-save-error').getAttribute('title')).toContain('disk full')
  })
})

describe('CanvasPanel recovery', () => {
  const READY: CanvasPhase = { kind: 'ready', mount: { mountSeq: 4, info: INFO } }
  const CONFLICT = { diskHash: 'ab'.repeat(32), version: '5' }

  it('checks the document on disk when the canvas is shown', () => {
    const checkDisk = vi.fn(async () => {})
    setPhase(READY)
    useCanvasStore.setState({ checkDisk })
    renderPanel()
    expect(checkDisk).toHaveBeenCalledWith(PROJECT)
  })

  it('offers keep mine, take disk and save a copy for a conflict', () => {
    const resolveConflict = vi.fn(async () => true)
    setPhase(READY, { dirty: true, conflict: CONFLICT })
    useCanvasStore.setState({ resolveConflict, checkDisk: vi.fn(async () => {}) })
    renderPanel()

    const bar = screen.getByRole('alertdialog', { name: 'Canvas changed on disk' })
    expect(bar.textContent).toContain('Autosave is paused')
    for (const [label, choice] of [
      ['Keep mine', 'keepMine'],
      ['Take disk', 'takeDisk'],
      ['Save a copy', 'saveCopy']
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(resolveConflict).toHaveBeenLastCalledWith(PROJECT, choice)
    }
  })

  it('offers only keep mine for a deleted document, and nothing while resolving', () => {
    setPhase(READY, { conflict: { diskHash: null, version: '3' }, resolving: true })
    useCanvasStore.setState({ checkDisk: vi.fn(async () => {}) })
    renderPanel()
    expect(screen.getByTestId('canvas-conflict').textContent).toContain('was deleted')
    expect(screen.queryByRole('button', { name: 'Take disk' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save a copy' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Keep mine' }).hasAttribute('disabled')).toBe(true)
  })

  it('shows what a crash lost until dismissed', () => {
    const sinceMs = new Date(2026, 9, 18, 9, 30, 0).getTime()
    setPhase(
      { kind: 'loading', mount: { mountSeq: 6, info: { ...INFO, mountSeq: 6 } } },
      {
        crash: {
          previousMountSeq: 4,
          mountSeq: 6,
          reason: '3 consecutive calls timed out',
          lost: { count: 4, sinceMs }
        }
      }
    )
    renderPanel()
    const notice = screen.getByTestId('canvas-crash-notice')
    expect(notice.textContent).toContain(
      `4 unsaved changes since ${new Date(sinceMs).toLocaleTimeString()} were lost.`
    )
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('canvas-crash-notice')).toBeNull()
    expect(useCanvasStore.getState().sessions[PROJECT]?.crash).toBeNull()
  })

  it('says nothing was lost when the editor was clean', () => {
    setPhase(READY, {
      crash: { previousMountSeq: 4, mountSeq: 6, reason: 'x', lost: null }
    })
    useCanvasStore.setState({ checkDisk: vi.fn(async () => {}) })
    renderPanel()
    const text = screen.getByTestId('canvas-crash-notice').textContent ?? ''
    expect(text).toContain('reloaded from the last save')
    expect(text).not.toContain('lost')
  })
})
