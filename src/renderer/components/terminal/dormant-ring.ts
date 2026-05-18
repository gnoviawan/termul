/**
 * DormantRing — Ring Buffer for Hidden Terminal Output
 *
 * When a terminal pane is not visible (e.g. background tab), PTY output
 * still arrives. Instead of dropping it or writing to xterm (which may be in
 * transition), buffer it here and flush when the terminal becomes visible again.
 *
 * Cap: 256KB total bytes, 256 individual chunks. Oldest chunks are dropped
 * first on overflow, and an overflow notice is prepended.
 */

export const DORMANT_RING_BYTE_CAP = 256 * 1024; // 256KB
export const DORMANT_RING_CHUNK_CAP = 256;

const OVERFLOW_NOTICE = "[termul: dropped output due to backpressure]\r\n";

export interface DormantRingState {
	chunks: Uint8Array[];
	totalBytes: number;
	overflowed: boolean;
}

export class DormantRing {
	private chunks: Uint8Array[] = [];
	private totalBytes = 0;
	private overflowed = false;

	/**
	 * Push a chunk of PTY data into the ring buffer.
	 * Automatically drops oldest chunks when caps are exceeded.
	 */
	push(data: Uint8Array): void {
		if (!data || data.length === 0) return;

		this.chunks.push(data);
		this.totalBytes += data.length;

		// Enforce chunk cap — drop oldest chunks
		while (this.chunks.length > DORMANT_RING_CHUNK_CAP) {
			const oldest = this.chunks.shift()!;
			this.totalBytes -= oldest.length;
		}

		// Enforce byte cap — drop oldest chunks until under limit
		while (this.totalBytes > DORMANT_RING_BYTE_CAP) {
			const oldest = this.chunks.shift()!;
			this.totalBytes -= oldest.length;
			this.overflowed = true;
		}
	}

	/**
	 * Drain all buffered chunks and return them as a flat list.
	 * If overflow occurred, prepend the overflow notice.
	 * Clears the buffer after drain.
	 */
	drain(): Uint8Array[] {
		const result: Uint8Array[] = [];

		if (this.overflowed) {
			const notice = new TextEncoder().encode(OVERFLOW_NOTICE);
			result.push(notice);
		}

		const chunks = this.chunks;
		const totalLen = this.totalBytes;

		if (chunks.length > 0) {
			// Try to merge into a single Uint8Array for efficiency
			if (chunks.length === 1) {
				result.push(chunks[0]);
			} else {
				const merged = new Uint8Array(totalLen);
				let offset = 0;
				for (const chunk of chunks) {
					merged.set(chunk, offset);
					offset += chunk.length;
				}
				result.push(merged);
			}
		}

		this.clear();
		return result;
	}

	/**
	 * Count of buffered chunks.
	 */
	get chunkCount(): number {
		return this.chunks.length;
	}

	/**
	 * Total buffered bytes.
	 */
	get byteCount(): number {
		return this.totalBytes;
	}

	/**
	 * Whether overflow has occurred since last drain/clear.
	 */
	get hasOverflowed(): boolean {
		return this.overflowed;
	}

	/**
	 * Clear all buffered data and reset overflow flag.
	 */
	clear(): void {
		this.chunks = [];
		this.totalBytes = 0;
		this.overflowed = false;
	}
}

/**
 * Create a DormantRing instance bound to a specific session/PTY ID.
 * Used by the renderer pool to manage per-session output buffering.
 */
export class SessionDormantRing {
	private rings = new Map<string, DormantRing>();

	/**
	 * Push data for a specific session.
	 */
	push(sessionId: string, data: Uint8Array): void {
		let ring = this.rings.get(sessionId);
		if (!ring) {
			ring = new DormantRing();
			this.rings.set(sessionId, ring);
		}
		ring.push(data);
	}

	/**
	 * Drain all buffered data for a session and remove the ring.
	 */
	drain(sessionId: string): Uint8Array[] {
		const ring = this.rings.get(sessionId);
		if (!ring) return [];
		const result = ring.drain();
		this.rings.delete(sessionId);
		return result;
	}

	/**
	 * Check if a session has pending data.
	 */
	hasPending(sessionId: string): boolean {
		const ring = this.rings.get(sessionId);
		return ring ? ring.chunkCount > 0 : false;
	}

	/**
	 * Clear data for a specific session.
	 */
	clearSession(sessionId: string): void {
		const ring = this.rings.get(sessionId);
		if (ring) {
			ring.clear();
			this.rings.delete(sessionId);
		}
	}

	/**
	 * Clear all dormant rings.
	 */
	clearAll(): void {
		this.rings.clear();
	}
}
