import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Monitor } from '@tauri-apps/api/window'
import type { WindowState } from '@shared/types/persistence.types'
import {
  clampStateToMonitors,
  getLogicalWorkArea,
  isPositionOnScreen,
  useWindowState
} from './use-window-state'

const { windowMock, persistenceMock, runtimeMock, monitorsMock, primaryMock, LogicalPositionStub, LogicalSizeStub } =
  vi.hoisted(() => {
    class LogicalPositionStub {
      readonly type = 'Logical'
      constructor(
        public x: number,
        public y: number
      ) {}
    }

    class LogicalSizeStub {
      readonly type = 'Logical'
      constructor(
        public width: number,
        public height: number
      ) {}
    }

    return {
      windowMock: {
        isMaximized: vi.fn(async () => false),
        scaleFactor: vi.fn(async () => 1),
        outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
        outerSize: vi.fn(async () => ({ width: 1200, height: 800 })),
        setPosition: vi.fn(async (_position: unknown) => {}),
        setSize: vi.fn(async (_size: unknown) => {}),
        maximize: vi.fn(async () => {}),
        onMoved: vi.fn(async () => vi.fn()),
        onResized: vi.fn(async () => vi.fn()),
        onCloseRequested: vi.fn(async () => vi.fn())
      },
      persistenceMock: {
        read: vi.fn(
          async (): Promise<{ success: boolean; data: WindowState | null }> => ({
            success: false,
            data: null
          })
        ),
        write: vi.fn(async (_key: string, _value: unknown) => ({ success: true })),
        writeDebounced: vi.fn(async (_key: string, _value: unknown) => ({ success: true }))
      },
      runtimeMock: { isTauri: true },
      monitorsMock: vi.fn(async (): Promise<Monitor[]> => []),
      primaryMock: vi.fn(async (): Promise<Monitor | null> => null),
      LogicalPositionStub,
      LogicalSizeStub
    }
  })

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowMock,
  availableMonitors: () => monitorsMock(),
  primaryMonitor: () => primaryMock(),
  LogicalPosition: LogicalPositionStub,
  LogicalSize: LogicalSizeStub
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: persistenceMock
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => runtimeMock.isTauri,
  cleanupTauriListener: (fn: unknown) => {
    if (typeof fn === 'function') fn()
  }
}))

function makeMonitor(overrides: {
  x?: number
  y?: number
  width: number
  height: number
  scaleFactor?: number
}): Monitor {
  const { x = 0, y = 0, width, height, scaleFactor = 1 } = overrides
  return {
    name: 'mock',
    size: { type: 'Physical', width, height } as Monitor['size'],
    position: { type: 'Physical', x, y } as Monitor['position'],
    workArea: {
      position: { type: 'Physical', x, y } as Monitor['workArea']['position'],
      size: { type: 'Physical', width, height } as Monitor['workArea']['size']
    },
    scaleFactor
  }
}

describe('window-state geometry helpers', () => {
  it('converts physical work area into logical pixels using the scale factor', () => {
    const monitor = makeMonitor({ x: 200, y: 100, width: 3840, height: 2160, scaleFactor: 2 })
    expect(getLogicalWorkArea(monitor)).toEqual({ x: 100, y: 50, width: 1920, height: 1080 })
  })

  it('treats a window overlapping a scaled monitor as on-screen', () => {
    // 1080p logical work area on a 4K/200% display.
    const monitor = makeMonitor({ width: 3840, height: 2160, scaleFactor: 2 })
    const onScreen: WindowState = {
      x: 50,
      y: 50,
      width: 1200,
      height: 800,
      isMaximized: false
    }
    expect(isPositionOnScreen(onScreen, [monitor])).toBe(true)

    const offScreen: WindowState = {
      x: 5000,
      y: 5000,
      width: 1200,
      height: 800,
      isMaximized: false
    }
    expect(isPositionOnScreen(offScreen, [monitor])).toBe(false)
  })

  it('clamps oversized/off-screen geometry back inside the work area', () => {
    const monitor = makeMonitor({ width: 1920, height: 1080, scaleFactor: 1 })
    const bad: WindowState = {
      x: 4000,
      y: -500,
      width: 5000,
      height: 4000,
      isMaximized: false
    }
    const clamped = clampStateToMonitors(bad, [monitor])
    expect(clamped.width).toBe(1920)
    expect(clamped.height).toBe(1080)
    expect(clamped.x).toBe(0)
    expect(clamped.y).toBe(0)
  })
})

describe('useWindowState restoration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMock.isTauri = true
    windowMock.isMaximized.mockResolvedValue(false)
    windowMock.scaleFactor.mockResolvedValue(1)
    windowMock.outerPosition.mockResolvedValue({ x: 0, y: 0 })
    windowMock.outerSize.mockResolvedValue({ width: 1200, height: 800 })
    windowMock.onMoved.mockResolvedValue(vi.fn())
    windowMock.onResized.mockResolvedValue(vi.fn())
    windowMock.onCloseRequested.mockResolvedValue(vi.fn())
    persistenceMock.read.mockResolvedValue({ success: false, data: null })
    monitorsMock.mockResolvedValue([makeMonitor({ width: 1920, height: 1080, scaleFactor: 1 })])
    primaryMock.mockResolvedValue(makeMonitor({ width: 1920, height: 1080, scaleFactor: 1 }))
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('restores persisted geometry as logical pixels (no physical/logical drift)', async () => {
    persistenceMock.read.mockResolvedValue({
      success: true,
      data: { x: 120, y: 80, width: 1000, height: 700, isMaximized: false }
    })

    const { result } = renderHook(() => useWindowState())

    await waitFor(() => expect(result.current).toBe(true))

    expect(windowMock.setPosition).toHaveBeenCalledTimes(1)
    const positionArg = windowMock.setPosition.mock.calls[0][0] as InstanceType<
      typeof LogicalPositionStub
    >
    expect(positionArg).toBeInstanceOf(LogicalPositionStub)
    expect(positionArg.x).toBe(120)
    expect(positionArg.y).toBe(80)

    const sizeArg = windowMock.setSize.mock.calls[0][0] as InstanceType<typeof LogicalSizeStub>
    expect(sizeArg).toBeInstanceOf(LogicalSizeStub)
    expect(sizeArg.width).toBe(1000)
    expect(sizeArg.height).toBe(700)

    expect(windowMock.maximize).not.toHaveBeenCalled()
  })

  it('recenters when persisted position is fully off-screen', async () => {
    persistenceMock.read.mockResolvedValue({
      success: true,
      data: { x: 9000, y: 9000, width: 1200, height: 800, isMaximized: false }
    })

    const { result } = renderHook(() => useWindowState())
    await waitFor(() => expect(result.current).toBe(true))

    const positionArg = windowMock.setPosition.mock.calls[0][0] as InstanceType<
      typeof LogicalPositionStub
    >
    // Centered on the 1920x1080 primary monitor work area.
    expect(positionArg.x).toBe(Math.round((1920 - 1200) / 2))
    expect(positionArg.y).toBe(Math.round((1080 - 800) / 2))
  })

  it('re-maximizes when the persisted state was maximized', async () => {
    persistenceMock.read.mockResolvedValue({
      success: true,
      data: { x: 0, y: 0, width: 1200, height: 800, isMaximized: true }
    })

    const { result } = renderHook(() => useWindowState())
    await waitFor(() => expect(result.current).toBe(true))

    expect(windowMock.maximize).toHaveBeenCalledTimes(1)
  })

  it('persists current geometry converted to logical pixels on a HiDPI display', async () => {
    windowMock.scaleFactor.mockResolvedValue(2)
    windowMock.outerPosition.mockResolvedValue({ x: 300, y: 200 })
    windowMock.outerSize.mockResolvedValue({ width: 2400, height: 1600 })

    const { result, unmount } = renderHook(() => useWindowState())
    await waitFor(() => expect(result.current).toBe(true))

    await act(async () => {
      unmount()
      await Promise.resolve()
    })

    expect(persistenceMock.write).toHaveBeenCalled()
    const saved = persistenceMock.write.mock.calls.at(-1)?.[1] as unknown as WindowState
    expect(saved).toMatchObject({ x: 150, y: 100, width: 1200, height: 800 })
  })

  it('is immediately ready outside the Tauri context', async () => {
    runtimeMock.isTauri = false
    const { result } = renderHook(() => useWindowState())
    await waitFor(() => expect(result.current).toBe(true))
    expect(windowMock.setPosition).not.toHaveBeenCalled()
  })
})
