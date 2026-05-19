import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock the pool module
const mockAcquireSlot = vi.fn()
const mockReleaseSlot = vi.fn()

vi.mock('./terminal-renderer-pool', () => ({
	acquireSlot: (...args: unknown[]) => mockAcquireSlot(...args),
	releaseSlot: (...args: unknown[]) => mockReleaseSlot(...args),
	getSlot: vi.fn(),
	markSlotFocused: vi.fn(),
	markSlotBlurred: vi.fn(),
	POOL_MAX_SIZE: 5,
}))

const createMockSlot = (leafId: string) => ({
	id: 0,
	term: {
		options: {},
		loadAddon: vi.fn(),
		onData: vi.fn(() => ({ dispose: vi.fn() })),
		open: vi.fn(),
		write: vi.fn(),
		focus: vi.fn(),
		dispose: vi.fn(),
		cols: 80,
		rows: 24,
	},
	fitAddon: { fit: vi.fn(), dispose: vi.fn() },
	searchAddon: {
		findNext: vi.fn(),
		findPrevious: vi.fn(),
		clearDecorations: vi.fn(),
		dispose: vi.fn(),
	},
	serializeAddon: { serialize: vi.fn(() => ''), dispose: vi.fn() },
	webglAddon: null,
	host: document.createElement('div'),
	currentLeafId: leafId,
	lastUsedAt: Date.now(),
	isAltScreen: false,
	isFocused: false,
	snapshot: null,
})

import { useTerminalRendererSession } from './use-terminal-renderer-session'

describe('useTerminalRendererSession', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockAcquireSlot.mockImplementation((leafId: string) => {
			return createMockSlot(leafId)
		})
	})

	it('should provide expected API surface', () => {
		const { result } = renderHook(() =>
			useTerminalRendererSession({ leafId: 'leaf-1' }),
		)

		expect(result.current).toHaveProperty('slot')
		expect(result.current).toHaveProperty('containerRef')
		expect(result.current).toHaveProperty('isAcquired')
		expect(result.current).toHaveProperty('acquire')
		expect(result.current).toHaveProperty('release')
		expect(result.current).toHaveProperty('flushDormantData')
		expect(result.current).toHaveProperty('pushDormantData')
	})

	it('should push dormant data for buffering', () => {
		const { result } = renderHook(() =>
			useTerminalRendererSession({ leafId: 'leaf-2' }),
		)

		act(() => {
			result.current.pushDormantData(new Uint8Array([1, 2, 3]))
		})
		// Push should succeed without throwing
	})

	it('should flush dormant data through write callback', () => {
		const { result } = renderHook(() =>
			useTerminalRendererSession({ leafId: 'leaf-3' }),
		)

		// Push some data first
		act(() => {
			result.current.pushDormantData(new Uint8Array([1, 2, 3]))
		})

		// Then flush
		const write = vi.fn()
		act(() => {
			result.current.flushDormantData(write)
		})

		// Verify write was called with the data
		expect(write).toHaveBeenCalled()
	})
})