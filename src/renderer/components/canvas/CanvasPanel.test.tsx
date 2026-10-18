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
  mountSeq: 4
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

beforeEach(() => {
  phoneWidth.value = false
  useCanvasStore.setState(original, true)
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
      `http://127.0.0.1:5199/canvas/cv0123456789abcdef/?embed=kiosk&ct=cafe&ho=${origin}&ms=4`
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
    setPhase({ kind: 'failed', code: 'BUNDLE_PIN_MISMATCH', message: 'Bundle mismatch.' })
    renderPanel()

    expect(screen.getByTestId('canvas-mount-failed').textContent).toBe('Bundle mismatch.')
    expect(screen.queryByTitle(/Canvas —/)).toBeNull()
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
