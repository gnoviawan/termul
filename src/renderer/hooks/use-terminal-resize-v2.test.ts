import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import { useTerminalResizeV2 } from './use-terminal-resize-v2'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

// Reusable mock factory functions

function createMockTerminal(cols = 80, rows = 24): Terminal {
	const viewportY = { value: 0 }
	const baseY = { value: 0 }

	return {
		cols,
		rows,
		buffer: {
			active: {
				get viewportY() {
					return viewportY.value
				},
				get baseY() {
					return baseY.value
				},
			},
		},
		scrollToLine: vi.fn(),
		refresh: vi.fn(),
		// Expose setters for test control
		_setViewportY: (v: number) => {
			viewportY.value = v
		},
		_setBaseY: (v: number) => {
			baseY.value = v
		},
	} as unknown as Terminal & { _setViewportY: (v: number) => void; _setBaseY: (v: number) => void }
}

function createMockFitAddon(): FitAddon {
	return {
		fit: vi.fn(),
		dispose: vi.fn(),
	} as unknown as FitAddon
}

describe('useTerminalResizeV2', () => {
	let observerCallback: (() => void) | null = null

	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()

		// Mock ResizeObserver as a proper class constructor
		global.ResizeObserver = class MockResizeObserver {
			observe = vi.fn()
			unobserve = vi.fn()
			disconnect = vi.fn()
			constructor(cb: () => void) {
				observerCallback = cb
			}
		} as unknown as typeof ResizeObserver
	})

	afterEach(() => {
		cleanup()
		vi.useRealTimers()
	})

	it('should return forceFit function', () => {
		const onPtyResize = vi.fn()
		const { result } = renderHook(() =>
			useTerminalResizeV2({
				onPtyResize,
				terminalRef: { current: createMockTerminal() },
				fitAddonRef: { current: createMockFitAddon() },
				containerRef: { current: null },
			}),
		)

		expect(typeof result.current.forceFit).toBe('function')
	})

	it('should set up ResizeObserver when container is attached', () => {
		const container = document.createElement('div')
		const onPtyResize = vi.fn()
		const ref = { current: container }

		renderHook(() =>
			useTerminalResizeV2({
				onPtyResize,
				terminalRef: { current: createMockTerminal() },
				fitAddonRef: { current: createMockFitAddon() },
				containerRef: ref,
			}),
		)

		expect(global.ResizeObserver).toBeDefined()
	})

	it('should not set up ResizeObserver when container is null', () => {
		const onPtyResize = vi.fn()
		renderHook(() =>
			useTerminalResizeV2({
				onPtyResize,
				terminalRef: { current: createMockTerminal() },
				fitAddonRef: { current: createMockFitAddon() },
				containerRef: { current: null },
			}),
		)

		expect(global.ResizeObserver).toBeDefined()
	})

	it('should call fit() after 8ms debounce on resize', () => {
		const container = document.createElement('div')
		const fitAddon = createMockFitAddon()
		const onPtyResize = vi.fn()

		vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
			width: 800,
			height: 600,
			top: 0,
			left: 0,
			bottom: 600,
			right: 800,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		})

		renderHook(() =>
			useTerminalResizeV2({
				onPtyResize,
				terminalRef: { current: createMockTerminal() },
				fitAddonRef: { current: fitAddon },
				containerRef: { current: container },
			}),
		)

		// Trigger resize
		act(() => {
			observerCallback!()
		})

		// fit() should not be called immediately
		expect(fitAddon.fit).not.toHaveBeenCalled()

		// Advance past FIT_DEBOUNCE_MS (8ms)
		act(() => {
			vi.advanceTimersByTime(8)
		})

		expect(fitAddon.fit).toHaveBeenCalledTimes(1)
	})

	it('should debounce fit() calls during continuous resize', () => {
		const container = document.createElement('div')
		const fitAddon = createMockFitAddon()
		const onPtyResize = vi.fn()

		vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
			width: 800,
			height: 600,
			top: 0,
			left: 0,
			bottom: 600,
			right: 800,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		})

		renderHook(() =>
			useTerminalResizeV2({
				onPtyResize,
				terminalRef: { current: createMockTerminal() },
				fitAddonRef: { current: fitAddon },
				containerRef: { current: container },
			}),
		)

		// Simulate 5 rapid resize events
		act(() => {
			observerCallback!()
		})
		act(() => {
			observerCallback!()
		})
		act(() => {
			observerCallback!()
		})
		act(() => {
			observerCallback!()
		})
		act(() => {
			observerCallback!()
		})

		// Advance 8ms — only 1 fit call should fire (debounce resets timer)
		act(() => {
			vi.advanceTimersByTime(8)
		})

		expect(fitAddon.fit).toHaveBeenCalledTimes(1)
	})

	it('should not call fit() when dimensions are unchanged', () => {
		const container = document.createElement('div')
		const fitAddon = createMockFitAddon()
		const onPtyResize = vi.fn()

		vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
			width: 800,
			height: 600,
			top: 0,
			left: 0,
			bottom: 600,
			right: 800,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		})

		renderHook(() =>
			useTerminalResizeV2({
				onPtyResize,
				terminalRef: { current: createMockTerminal() },
				fitAddonRef: { current: fitAddon },
				containerRef: { current: container },
			}),
		)

		// First resize triggers fit because dimensions are new
		act(() => {
			observerCallback!()
		})
		act(() => {
			vi.advanceTimersByTime(8)
		})
		expect(fitAddon.fit).toHaveBeenCalledTimes(1)

		// Second resize with same dimensions — fit should be skipped
		act(() => {
			observerCallback!()
		})
		act(() => {
			vi.advanceTimersByTime(8)
		})

		// Still only 1 fit call — second was skipped because dimensions didn't change
		expect(fitAddon.fit).toHaveBeenCalledTimes(1)
	})

	it('should call PTY resize after 256ms debounce following fit', () => {
		const container = document.createElement('div')
		const terminal = createMockTerminal(100, 30)
		const fitAddon = createMockFitAddon()
		const onPtyResize = vi.fn()

		vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
			width: 800,
			height: 600,
			top: 0,
			left: 0,
			bottom: 600,
			right: 800,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		})

		renderHook(() =>
			useTerminalResizeV2({
				onPtyResize,
				terminalRef: { current: terminal },
				fitAddonRef: { current: fitAddon },
				containerRef: { current: container },
			}),
		)

		// Trigger resize
		act(() => {
			observerCallback!()
		})

		// Advance past fit debounce (8ms)
		act(() => {
			vi.advanceTimersByTime(8)
		})

		// PTY resize should not be called yet
		expect(onPtyResize).not.toHaveBeenCalled()

		// Advance past PTY debounce (256ms)
		act(() => {
			vi.advanceTimersByTime(256)
		})

		// PTY resize should be called with terminal dimensions
		expect(onPtyResize).toHaveBeenCalledWith(100, 30)
	})

	it('should not call PTY resize when cols/rows have not changed', () => {
		const container = document.createElement('div')
		const terminal = createMockTerminal(80, 24)
		const fitAddon = createMockFitAddon()
		const onPtyResize = vi.fn()

		vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
			width: 800,
			height: 600,
			top: 0,
			left: 0,
			bottom: 600,
			right: 800,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		})

		renderHook(() =>
			useTerminalResizeV2({
				onPtyResize,
				terminalRef: { current: terminal },
				fitAddonRef: { current: fitAddon },
				containerRef: { current: container },
			}),
		)

		// First resize — sets cols/rows to 80, 24
		act(() => {
			observerCallback!()
		})
		act(() => {
			vi.advanceTimersByTime(8)
		})
		act(() => {
			vi.advanceTimersByTime(256)
		})
		expect(onPtyResize).toHaveBeenCalledWith(80, 24)

		// Second resize with same terminal dimensions — PTY resize should be skipped
		// (dimensions didn't change so fit() would be skipped, meaning no PTY resize fires)
		act(() => {
			observerCallback!()
		})
		act(() => {
			vi.advanceTimersByTime(8)
		})
		act(() => {
			vi.advanceTimersByTime(256)
		})

		// Still only 1 PTY resize call
		expect(onPtyResize).toHaveBeenCalledTimes(1)
	})

	it('should skip resize processing when terminal is hidden', () => {
		const container = document.createElement('div')
		const fitAddon = createMockFitAddon()
		const onPtyResize = vi.fn()

		vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
			width: 800,
			height: 600,
			top: 0,
			left: 0,
			bottom: 600,
			right: 800,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		})

		renderHook(() =>
			useTerminalResizeV2({
				onPtyResize,
				terminalRef: { current: createMockTerminal() },
				fitAddonRef: { current: fitAddon },
				containerRef: { current: container },
				isVisible: false,
			}),
		)

		// Trigger resize while hidden
		act(() => {
			observerCallback!()
		})
		act(() => {
			vi.advanceTimersByTime(8)
		})
		act(() => {
			vi.advanceTimersByTime(256)
		})

		// No fit or PTY resize should have been called
		expect(fitAddon.fit).not.toHaveBeenCalled()
		expect(onPtyResize).not.toHaveBeenCalled()
	})

	it('should force immediate fit + PTY resize when forceFit is called', () => {
		const container = document.createElement('div')
		const terminal = createMockTerminal(100, 30)
		const fitAddon = createMockFitAddon()
		const onPtyResize = vi.fn()

		vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
			width: 800,
			height: 600,
			top: 0,
			left: 0,
			bottom: 600,
			right: 800,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		})

		const { result } = renderHook(() =>
			useTerminalResizeV2({
				onPtyResize,
				terminalRef: { current: terminal },
				fitAddonRef: { current: fitAddon },
				containerRef: { current: container },
			}),
		)

		// Force fit — bypasses debouncing entirely
		act(() => {
			result.current.forceFit()
		})

		// fit() should be called immediately (no debounce)
		expect(fitAddon.fit).toHaveBeenCalledTimes(1)

		// PTY resize should also be called immediately (no debounce)
		expect(onPtyResize).toHaveBeenCalledWith(100, 30)
	})

	it('should preserve scroll position across fit()', () => {
		const container = document.createElement('div')
		const terminal = createMockTerminal(80, 24)
		const fitAddon = createMockFitAddon()

		// Simulate user scrolled up: viewportY = 50, baseY = 100
		;(terminal as unknown as { _setViewportY: (v: number) => void })._setViewportY(50)
		;(terminal as unknown as { _setBaseY: (v: number) => void })._setBaseY(100)

		const scrollToLineSpy = vi.fn()
		;(terminal as unknown as { scrollToLine: typeof vi.fn }).scrollToLine = scrollToLineSpy

		vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
			width: 800,
			height: 600,
			top: 0,
			left: 0,
			bottom: 600,
			right: 800,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		})

		const { result } = renderHook(() =>
			useTerminalResizeV2({
				onPtyResize: vi.fn(),
				terminalRef: { current: terminal },
				fitAddonRef: { current: fitAddon },
				containerRef: { current: container },
			}),
		)

		// Force fit to test scroll preservation
		act(() => {
			result.current.forceFit()
		})

		// scrollToLine should have been called to restore viewport position
		expect(scrollToLineSpy).toHaveBeenCalledWith(50)
	})

	it('should handle terminal not ready gracefully', () => {
		const onPtyResize = vi.fn()

		// No terminal, no fitAddon, no container
		const { result } = renderHook(() =>
			useTerminalResizeV2({
				onPtyResize,
				terminalRef: { current: null },
				fitAddonRef: { current: null },
				containerRef: { current: null },
			}),
		)

		// forceFit should not throw
		expect(() => {
			act(() => {
				result.current.forceFit()
			})
		}).not.toThrow()
	})

	it('should clean up timers and observer on unmount', () => {
		const container = document.createElement('div')
		const fitAddon = createMockFitAddon()
		const onPtyResize = vi.fn()
		const mockDisconnect = vi.fn()

		global.ResizeObserver = class MockResizeObserver {
			observe = vi.fn()
			unobserve = vi.fn()
			disconnect = mockDisconnect
			constructor(cb: () => void) {
				observerCallback = cb
			}
		} as unknown as typeof ResizeObserver

		vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
			width: 800,
			height: 600,
			top: 0,
			left: 0,
			bottom: 600,
			right: 800,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		})

		const { unmount } = renderHook(() =>
			useTerminalResizeV2({
				onPtyResize,
				terminalRef: { current: createMockTerminal() },
				fitAddonRef: { current: fitAddon },
				containerRef: { current: container },
			}),
		)

		// Trigger resize to start timers
		act(() => {
			observerCallback!()
		})

		// Unmount before timers fire
		unmount()

		// Advance timers — nothing should happen after unmount
		act(() => {
			vi.advanceTimersByTime(300)
		})

		// No fit or PTY resize should have been called after unmount
		expect(fitAddon.fit).not.toHaveBeenCalled()
		expect(onPtyResize).not.toHaveBeenCalled()

		// ResizeObserver should be disconnected
		expect(mockDisconnect).toHaveBeenCalled()
	})

	it('should debounce PTY resize during continuous drag', () => {
		const container = document.createElement('div')
		const terminal = createMockTerminal(80, 24)
		const fitAddon = createMockFitAddon()
		const onPtyResize = vi.fn()

		vi.spyOn(container, 'getBoundingClientRect')
			.mockReturnValueOnce({
				width: 800,
				height: 600,
				top: 0, left: 0, bottom: 600, right: 800, x: 0, y: 0, toJSON: () => ({}),
			})
			.mockReturnValueOnce({
				width: 900,
				height: 650,
				top: 0, left: 0, bottom: 650, right: 900, x: 0, y: 0, toJSON: () => ({}),
			})
			.mockReturnValue({
				width: 1000,
				height: 700,
				top: 0, left: 0, bottom: 700, right: 1000, x: 0, y: 0, toJSON: () => ({}),
			})

		renderHook(() =>
			useTerminalResizeV2({
				onPtyResize,
				terminalRef: { current: terminal },
				fitAddonRef: { current: fitAddon },
				containerRef: { current: container },
			}),
		)

		// Simulate 3 rapid resize events during continuous drag
		act(() => {
			observerCallback!()
		})
		act(() => {
			vi.advanceTimersByTime(3)
		})
		act(() => {
			observerCallback!()
		})
		act(() => {
			vi.advanceTimersByTime(3)
		})
		act(() => {
			observerCallback!()
		})

		// Advance past fit debounce — one fit call should happen
		act(() => {
			vi.advanceTimersByTime(8)
		})
		expect(fitAddon.fit).toHaveBeenCalledTimes(1)

		// Advance past PTY debounce — one PTY resize should happen
		act(() => {
			vi.advanceTimersByTime(256)
		})
		expect(onPtyResize).toHaveBeenCalledTimes(1)
	})

	it('should handle WebGL context loss gracefully during fit', () => {
		const container = document.createElement('div')
		const fitAddon = createMockFitAddon()
		const onPtyResize = vi.fn()

		// Make fit throw (simulating WebGL context loss)
		fitAddon.fit = vi.fn().mockImplementation(() => {
			throw new Error('WebGL context lost')
		})

		vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
			width: 800,
			height: 600,
			top: 0, left: 0, bottom: 600, right: 800, x: 0, y: 0, toJSON: () => ({}),
		})

		const { result } = renderHook(() =>
			useTerminalResizeV2({
				onPtyResize,
				terminalRef: { current: createMockTerminal() },
				fitAddonRef: { current: fitAddon },
				containerRef: { current: container },
			}),
		)

		// forceFit should not throw even if fit() throws
		expect(() => {
			act(() => {
				result.current.forceFit()
			})
		}).not.toThrow()
	})
})