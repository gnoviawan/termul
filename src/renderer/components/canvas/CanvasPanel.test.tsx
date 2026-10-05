/**
 * CanvasPanel tests (OpenPencil canvas mode, task 22).
 *
 * Renders the panel against a mocked canvas-store + bridge factory and
 * covers: the iframe shell wiring (src verbatim, allow attribute), the
 * dirty indicator, the conflict dialog's both resolution paths, the theme
 * push on mount and on appearance-mode toggle, the locale push, and the
 * `op-shell/save` / `op-shell/copy` callback wiring into the store/clipboard.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { canvasState, bridgeOptions, bridgeController, clipboardWrite, appearance } = vi.hoisted(
  () => {
    const canvasState = {
      sessions: {} as Record<string, unknown>,
      handleBridgeEvent: vi.fn(),
      handleInitFailed: vi.fn(),
      attachBridge: vi.fn(),
      detachBridge: vi.fn(),
      saveCanvas: vi.fn(async () => {}),
      resolveConflict: vi.fn(),
      dismissConflict: vi.fn(),
      pushTheme: vi.fn(),
      pushLocale: vi.fn()
    }
    const bridgeOptions: { value: unknown } = { value: null }
    const bridgeController = {
      sendTheme: vi.fn(),
      sendLocale: vi.fn(),
      sendSaveCommitted: vi.fn(),
      sendResolveConflict: vi.fn(),
      dispose: vi.fn()
    }
    const clipboardWrite = vi.fn(async () => {})
    const appearance = { mode: 'dark' as 'dark' | 'light' }
    return { canvasState, bridgeOptions, bridgeController, clipboardWrite, appearance }
  }
)

vi.mock('@/stores/canvas-store', () => ({
  useCanvasStore: Object.assign(
    vi.fn((selector: (state: typeof canvasState) => unknown) => selector(canvasState)),
    { getState: () => canvasState }
  )
}))

vi.mock('@/stores/app-settings-store', () => ({
  useAppearanceMode: () => appearance.mode
}))

vi.mock('@/lib/api', () => ({
  clipboardApi: { writeText: clipboardWrite }
}))

vi.mock('@/lib/canvas-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/canvas-bridge')>()
  return {
    ...actual,
    createCanvasBridge: vi.fn((options: unknown) => {
      bridgeOptions.value = options
      return bridgeController
    })
  }
})

import type { CanvasBridgeOptions } from '@/lib/canvas-bridge'
import { CanvasPanel } from './CanvasPanel'

const PROJECT = 'proj-1'
const DOC = 'C:/proj/design.op'
const EMBED_URL = 'http://127.0.0.1:5199/?embed=vscode'

function setSession(overrides: Record<string, unknown> = {}): void {
  canvasState.sessions = {
    [PROJECT]: {
      projectId: PROJECT,
      docPath: DOC,
      docKey: DOC,
      embedUrl: EMBED_URL,
      mcpUrl: 'http://127.0.0.1:5199/canvas/mcp',
      status: 'open',
      bridgeReady: true,
      dirty: false,
      generation: 3,
      revision: 18,
      saving: false,
      conflict: null,
      ...overrides
    }
  }
}

function currentBridgeOptions(): CanvasBridgeOptions {
  return bridgeOptions.value as CanvasBridgeOptions
}

describe('CanvasPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appearance.mode = 'dark'
    setSession()
  })

  afterEach(() => {
    canvasState.sessions = {}
  })

  it('renders the iframe shell with the embed URL verbatim and clipboard allow', async () => {
    const { container } = render(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('src')).toBe(EMBED_URL)
    expect(iframe?.getAttribute('allow')).toBe('clipboard-read; clipboard-write')
    await waitFor(() =>
      expect(canvasState.attachBridge).toHaveBeenCalledWith(PROJECT, bridgeController)
    )
  })

  it('creates the bridge with the iframe origin + init token + mcpUrl', async () => {
    setSession({ bridgeToken: 'cafebabecafebabecafebabecafebabe' })
    render(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    await waitFor(() => expect(bridgeOptions.value).not.toBeNull())
    const options = currentBridgeOptions()
    expect(options.iframeOrigin).toBe('http://127.0.0.1:5199')
    expect(options.token).toBe('cafebabecafebabecafebabecafebabe')
    expect(options.mcpUrl).toBe('http://127.0.0.1:5199/canvas/mcp')
  })

  it('shows the dirty indicator only when the session is dirty', () => {
    const { container, rerender } = render(
      <CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />
    )
    expect(container.querySelector('.bg-primary-fill')).toBeNull()

    setSession({ dirty: true })
    rerender(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    const dirtyDot = container.querySelector('.bg-primary-fill')
    expect(dirtyDot).not.toBeNull()
    expect(dirtyDot?.getAttribute('aria-label')).toBe('Unsaved changes')
  })

  it('Save button dispatches the store save flow', () => {
    render(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    fireEvent.click(screen.getByRole('button', { name: 'Save canvas' }))
    expect(canvasState.saveCanvas).toHaveBeenCalledWith(PROJECT)
  })

  it('Save is disabled until the bridge is ready', () => {
    setSession({ bridgeReady: false })
    render(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    expect(screen.getByRole('button', { name: 'Save canvas' })).toBeDisabled()
  })

  it('conflict dialog: "Keep my changes" resolves use-local; the secondary action resolves accept-remote', () => {
    setSession({ conflict: { serverVersion: 19 } })
    const { rerender } = render(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    expect(screen.getByText('Canvas conflict')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Keep my changes' }))
    expect(canvasState.resolveConflict).toHaveBeenCalledWith(PROJECT, 'use-local')

    setSession({ conflict: { serverVersion: 20 } })
    rerender(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    fireEvent.click(screen.getByRole('button', { name: 'Use the saved version' }))
    expect(canvasState.resolveConflict).toHaveBeenCalledWith(PROJECT, 'accept-remote')

    setSession({ conflict: { serverVersion: 21 } })
    rerender(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(canvasState.dismissConflict).toHaveBeenCalledWith(PROJECT)
  })

  it('pushes the current theme on mount and re-pushes when the appearance mode toggles', () => {
    const { rerender } = render(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    expect(canvasState.pushTheme).toHaveBeenCalledWith(PROJECT, 'dark')

    appearance.mode = 'light'
    rerender(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    expect(canvasState.pushTheme).toHaveBeenCalledWith(PROJECT, 'light')
  })

  it('pushes the host locale on mount', () => {
    render(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    expect(canvasState.pushLocale).toHaveBeenCalledWith(PROJECT, expect.any(String))
  })

  it('op-shell/save runs the store save flow; op-shell/copy writes the clipboard', async () => {
    render(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    await waitFor(() => expect(bridgeOptions.value).not.toBeNull())
    const options = currentBridgeOptions()
    options.onShellSave()
    expect(canvasState.saveCanvas).toHaveBeenCalledWith(PROJECT)
    options.onShellCopy('copied design tokens')
    expect(clipboardWrite).toHaveBeenCalledWith('copied design tokens')
  })

  it('bridge events are dispatched into the store', async () => {
    render(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    await waitFor(() => expect(bridgeOptions.value).not.toBeNull())
    const options = currentBridgeOptions()
    options.onEvent({ type: 'dirty-changed', generation: 4, revision: 19, dirty: true })
    expect(canvasState.handleBridgeEvent).toHaveBeenCalledWith(PROJECT, {
      type: 'dirty-changed',
      generation: 4,
      revision: 19,
      dirty: true
    })
  })

  it('init failure (retry budget exhausted) records the store failure state', async () => {
    render(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    await waitFor(() => expect(bridgeOptions.value).not.toBeNull())
    const options = currentBridgeOptions()
    options.onInitFailed?.()
    expect(canvasState.handleInitFailed).toHaveBeenCalledWith(PROJECT)
  })

  it('an error session shows the failure status label', () => {
    setSession({ status: 'error', errorCode: 'BRIDGE_INIT_FAILED' })
    render(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    expect(screen.getByText('Canvas failed to connect')).toBeDefined()
  })

  it('unmount detaches the bridge', () => {
    const { unmount } = render(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />)
    unmount()
    expect(canvasState.detachBridge).toHaveBeenCalledWith(PROJECT, bridgeController)
  })

  it('an inactive tab keeps the iframe mounted and the bridge attached (tab switch never tears the canvas down)', async () => {
    const { container, rerender } = render(
      <CanvasPanel projectId={PROJECT} docPath={DOC} isVisible />
    )
    await waitFor(() =>
      expect(canvasState.attachBridge).toHaveBeenCalledWith(PROJECT, bridgeController)
    )
    expect(container.querySelector('[data-canvas-tab-state="visible"]')).not.toBeNull()

    rerender(<CanvasPanel projectId={PROJECT} docPath={DOC} isVisible={false} />)

    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('src')).toBe(EMBED_URL)
    expect(container.querySelector('[data-canvas-tab-state="hidden"]')).not.toBeNull()
    expect(canvasState.attachBridge).toHaveBeenCalledTimes(1)
    expect(canvasState.detachBridge).not.toHaveBeenCalled()
  })
})
