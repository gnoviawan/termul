import { describe, it, expect } from 'vitest'
import { DormantRing, SessionDormantRing, DORMANT_RING_BYTE_CAP, DORMANT_RING_CHUNK_CAP } from './dormant-ring'

describe('DormantRing', () => {
	it('should push and drain data', () => {
		const ring = new DormantRing()
		ring.push(new Uint8Array([1, 2, 3]))
		ring.push(new Uint8Array([4, 5, 6]))

		const chunks = ring.drain()
		expect(chunks.length).toBe(1) // merged into single array
		expect(chunks[0]).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
	})

	it('should clear buffer after drain', () => {
		const ring = new DormantRing()
		ring.push(new Uint8Array([1, 2, 3]))
		ring.drain()

		expect(ring.chunkCount).toBe(0)
		expect(ring.byteCount).toBe(0)
		expect(ring.hasOverflowed).toBe(false)
	})

	it('should handle empty push', () => {
		const ring = new DormantRing()
		ring.push(new Uint8Array([]))
		expect(ring.chunkCount).toBe(0)
	})

	it('should drop oldest chunks when chunk cap exceeded', () => {
		const ring = new DormantRing()
		for (let i = 0; i < DORMANT_RING_CHUNK_CAP + 10; i++) {
			ring.push(new Uint8Array([i]))
		}
		expect(ring.chunkCount).toBe(DORMANT_RING_CHUNK_CAP)
	})

	it('should drop oldest chunks when byte cap exceeded', () => {
		const ring = new DormantRing()
		// Push one chunk larger than the cap
		const huge = new Uint8Array(DORMANT_RING_BYTE_CAP + 1000)
		ring.push(huge)
		// After pushing, the overflow flag should be marked
		expect(ring.hasOverflowed).toBe(true)
	})

	it('should prepend overflow notice on drain when overflow occurred', () => {
		const ring = new DormantRing()
		// Force overflow by exceeding byte cap
		const bigChunk = new Uint8Array(DORMANT_RING_BYTE_CAP + 100)
		ring.push(new Uint8Array([1])) // small initial chunk
		ring.push(bigChunk) // force overflow
		ring.push(new Uint8Array([42])) // data after overflow

		const chunks = ring.drain()
		expect(chunks.length).toBe(2) // overflow notice + merged data
		// First chunk is the overflow notice
		const noticeText = new TextDecoder().decode(chunks[0])
		expect(noticeText).toContain('[termul: dropped output')
	})

	it('should merge single chunk directly on drain', () => {
		const ring = new DormantRing()
		ring.push(new Uint8Array([7, 8, 9]))

		const chunks = ring.drain()
		expect(chunks.length).toBe(1)
		expect(chunks[0]).toEqual(new Uint8Array([7, 8, 9]))
	})

	it('should clear ring state', () => {
		const ring = new DormantRing()
		ring.push(new Uint8Array([1, 2, 3]))
		ring.clear()

		expect(ring.chunkCount).toBe(0)
		expect(ring.byteCount).toBe(0)
		expect(ring.hasOverflowed).toBe(false)
	})
})

describe('SessionDormantRing', () => {
	it('should push and drain data per session', () => {
		const sdr = new SessionDormantRing()
		sdr.push('session-1', new Uint8Array([1, 2, 3]))
		sdr.push('session-2', new Uint8Array([4, 5, 6]))

		const chunks1 = sdr.drain('session-1')
		expect(chunks1.length).toBe(1)
		expect(chunks1[0]).toEqual(new Uint8Array([1, 2, 3]))

		const chunks2 = sdr.drain('session-2')
		expect(chunks2.length).toBe(1)
		expect(chunks2[0]).toEqual(new Uint8Array([4, 5, 6]))
	})

	it('should return empty array for unknown session', () => {
		const sdr = new SessionDormantRing()
		const chunks = sdr.drain('unknown')
		expect(chunks).toEqual([])
	})

	it('should check pending data', () => {
		const sdr = new SessionDormantRing()
		expect(sdr.hasPending('session-1')).toBe(false)

		sdr.push('session-1', new Uint8Array([1]))
		expect(sdr.hasPending('session-1')).toBe(true)
	})

	it('should clear specific session', () => {
		const sdr = new SessionDormantRing()
		sdr.push('session-1', new Uint8Array([1]))
		sdr.push('session-2', new Uint8Array([2]))

		sdr.clearSession('session-1')
		expect(sdr.hasPending('session-1')).toBe(false)
		expect(sdr.hasPending('session-2')).toBe(true)
	})

	it('should clear all sessions', () => {
		const sdr = new SessionDormantRing()
		sdr.push('session-1', new Uint8Array([1]))
		sdr.push('session-2', new Uint8Array([2]))

		sdr.clearAll()
		expect(sdr.hasPending('session-1')).toBe(false)
		expect(sdr.hasPending('session-2')).toBe(false)
	})
})