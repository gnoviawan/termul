import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock @xterm packages before importing the module under test
const mockTermInstances: Array<{
	loadAddon: ReturnType<typeof vi.fn>
	open: ReturnType<typeof vi.fn>
	write: ReturnType<typeof vi.fn>
	reset: ReturnType<typeof vi.fn>
	dispose: ReturnType<typeof vi.fn>
	options: Record<string, unknown>
	onData: ReturnType<typeof vi.fn>
	element: HTMLDivElement | null
	cols: number
	rows: number
}> = []

vi.mock('@xterm/xterm', () => {
	return {
		Terminal: class MockTerminal {
			options: Record<string, unknown> = {}
			element: HTMLDivElement | null = document.createElement('div')
			loadAddon = vi.fn()
			open = vi.fn()
			write = vi.fn()
			reset = vi.fn()
			dispose = vi.fn()
			onData = vi.fn(() => ({ dispose: vi.fn() }))
			cols = 80
			rows = 24

			constructor() {
				mockTermInstances.push(this as unknown as typeof mockTermInstances[number])
			}
		},
	}
})

vi.mock('@xterm/addon-fit', () => ({
	FitAddon: class MockFitAddon {
		fit = vi.fn()
		dispose = vi.fn()
	},
}))

vi.mock('@xterm/addon-search', () => ({
	SearchAddon: class MockSearchAddon {
		findNext = vi.fn()
		findPrevious = vi.fn()
		clearDecorations = vi.fn()
		dispose = vi.fn()
	},
}))

vi.mock('@xterm/addon-webgl', () => ({
	WebglAddon: class MockWebglAddon {
		onContextLoss = vi.fn()
		dispose = vi.fn()
	},
}))

vi.mock('@xterm/addon-serialize', () => ({
	SerializeAddon: class MockSerializeAddon {
		serialize = vi.fn(() => '')
		dispose = vi.fn()
	},
}))

vi.mock('./terminal-config', () => ({
	getTerminalOptions: () => ({
		cursorBlink: true,
		fontSize: 14,
		fontFamily: 'monospace',
		scrollback: 10000,
	}),
}))

import {
	acquireSlot,
	releaseSlot,
	clearPool,
	getPoolStats,
	POOL_MAX_SIZE,
} from './terminal-renderer-pool'

describe('TerminalRendererPool', () => {
	let container1: HTMLDivElement
	let container2: HTMLDivElement

	beforeEach(() => {
		clearPool()
		mockTermInstances.length = 0
		container1 = document.createElement('div')
		container1.id = 'container-1'
		document.body.appendChild(container1)
		container2 = document.createElement('div')
		container2.id = 'container-2'
		document.body.appendChild(container2)
	})

	afterEach(() => {
		clearPool()
		container1.remove()
		container2.remove()
	})

	it('should create and acquire a slot', () => {
		const slot = acquireSlot('leaf-1', container1)

		expect(slot).not.toBeNull()
		expect(slot!.id).toBe(0)
		expect(slot!.currentLeafId).toBe('leaf-1')
		expect(slot!.term).toBeDefined()
		expect(slot!.fitAddon).toBeDefined()
		expect(slot!.searchAddon).toBeDefined()
		expect(slot!.serializeAddon).toBeDefined()
		expect(slot!.host).toBeDefined()
	})

	it('should reuse same slot for repeated acquire of same leaf', () => {
		const slot1 = acquireSlot('leaf-1', container1)
		const slot2 = acquireSlot('leaf-1', container1)

		expect(slot1).toBe(slot2) // same reference
	})

	it('should create up to POOL_MAX_SIZE slots', () => {
		for (let i = 0; i < POOL_MAX_SIZE; i++) {
			const slot = acquireSlot(`leaf-${i}`, container1)
			expect(slot).not.toBeNull()
			expect(slot!.currentLeafId).toBe(`leaf-${i}`)
		}

		const stats = getPoolStats()
		expect(stats.totalSlots).toBe(POOL_MAX_SIZE)
	})

	it('should release a slot back to the pool', () => {
		acquireSlot('leaf-1', container1)

		releaseSlot('leaf-1')

		const stats = getPoolStats()
		expect(stats.activeSlots).toBe(0)
		expect(stats.freeSlots).toBe(1)
	})

	it('should reuse a released slot for a new leaf', () => {
		const slot1 = acquireSlot('leaf-1', container1)
		const slotId = slot1!.id

		releaseSlot('leaf-1')

		const slot2 = acquireSlot('leaf-2', container1)

		expect(slot2).not.toBeNull()
		expect(slot2!.id).toBe(slotId) // reused same slot
	})

	it('should evict the lowest-priority slot when pool is full', () => {
		// Fill the pool
		for (let i = 0; i < POOL_MAX_SIZE; i++) {
			acquireSlot(`leaf-${i}`, container1)
		}

		// Add one more — should evict a slot
		const newSlot = acquireSlot('leaf-evicted', container1)
		expect(newSlot).not.toBeNull()
		expect(newSlot!.currentLeafId).toBe('leaf-evicted')

		const stats = getPoolStats()
		expect(stats.totalSlots).toBe(POOL_MAX_SIZE) // still capped at 5
	})

	it('should handle release of unbound leaf gracefully', () => {
		expect(() => releaseSlot('unknown-leaf')).not.toThrow()
	})

	it('should move host div to container on acquire', () => {
		const slot = acquireSlot('leaf-1', container1)

		// The host should be inside the container
		expect(container1.contains(slot!.host)).toBe(true)
	})

	it('should move host div out of container on release', () => {
		acquireSlot('leaf-1', container1)

		releaseSlot('leaf-1')

		// The host should not be in the old container
		expect(container1.contains(document.querySelector('[data-termul-recycler]')!)).toBe(false)
	})

	it('should track pool stats correctly', () => {
		acquireSlot('leaf-1', container1)
		acquireSlot('leaf-2', container1)

		const stats = getPoolStats()
		expect(stats.totalSlots).toBe(2)
		expect(stats.activeSlots).toBe(2)
		expect(stats.freeSlots).toBe(0)
		expect(stats.boundLeaves).toEqual(['leaf-1', 'leaf-2'])
	})

	it('should clear pool and dispose all terminals', () => {
		acquireSlot('leaf-1', container1)
		acquireSlot('leaf-2', container1)

		clearPool()

		const stats = getPoolStats()
		expect(stats.totalSlots).toBe(0)
	})
})