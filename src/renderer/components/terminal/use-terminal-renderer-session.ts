import { useRef, useEffect, useCallback, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import type { SerializeAddon } from '@xterm/addon-serialize'
import type { WebglAddon } from '@xterm/addon-webgl'
import {
	acquireSlot,
	releaseSlot,
	getSlot,
	markSlotFocused,
	markSlotBlurred,
	type PoolSlot,
} from './terminal-renderer-pool'
import { SessionDormantRing } from './dormant-ring'

/** Shared session-level dormant ring for hidden terminal output. */
const sessionDormantRing = new SessionDormantRing()

export interface UseTerminalRendererSessionOptions {
	/** Unique leaf/pane ID for pool tracking */
	leafId: string
	/** Whether this terminal is currently visible */
	isVisible?: boolean
	/** Optional platform string */
	platform?: string
	/** Initial terminal configuration to apply when creating a new slot */
	initialConfig?: {
		fontFamily?: string
		fontSize?: number
		scrollback?: number
	}
	/** Callback when a slot is acquired (terminal ready) */
	onSlotAcquired?: (slot: PoolSlot) => void
	/** Callback when PTY data arrives for a hidden terminal (for dormant buffering) */
	onData?: (data: Uint8Array) => void
}

export interface UseTerminalRendererSessionReturn {
	/** The acquired pool slot, or null if not yet acquired */
	slot: PoolSlot | null
	/** Ref to attach to the container element where the slot's host will live */
	containerRef: React.RefObject<HTMLDivElement | null>
	/** Whether this session owns an acquired slot */
	isAcquired: boolean
	/** Manually acquire/re-acquire the slot */
	acquire: () => void
	/** Manually release the slot */
	release: () => void
	/** Flush any dormant-buffered data for this leaf */
	flushDormantData: (write: (data: Uint8Array) => void) => void
	/** Push PTY data to dormant buffer (when terminal is hidden) */
	pushDormantData: (data: Uint8Array) => void
}

/**
 * Hook that manages a terminal's lifecycle via the TerminalRendererPool.
 *
 * When visible: acquires a pool slot and makes it available to the component.
 * When hidden: releases the slot and buffers any incoming PTY data in a
 *              DormantRing, to be flushed when the terminal becomes visible again.
 *
 * Usage:
 * ```tsx
 * const { slot, containerRef, flushDormantData, pushDormantData } =
 *   useTerminalRendererSession({ leafId: paneId, isVisible })
 * ```
 */
export function useTerminalRendererSession(
	options: UseTerminalRendererSessionOptions,
): UseTerminalRendererSessionReturn {
	const {
		leafId,
		isVisible = true,
		platform,
		initialConfig,
		onSlotAcquired,
		onData,
	} = options

	const containerRef = useRef<HTMLDivElement | null>(null)
	const [slot, setSlot] = useState<PoolSlot | null>(null)
	const isAcquiredRef = useRef(false)

	// Stable callback refs
	const onDataRef = useRef(onData)
	onDataRef.current = onData

	/**
	 * Acquire a slot from the pool and bind it to this leaf.
	 */
	const acquire = useCallback(() => {
		if (isAcquiredRef.current) return
		const container = containerRef.current
		if (!container) return

		const acquired = acquireSlot(leafId, container, {
			platform,
			initialOptions: initialConfig,
		})

		if (acquired) {
			isAcquiredRef.current = true
			setSlot(acquired)
			onSlotAcquired?.(acquired)
		}
	}, [leafId, platform, initialConfig, onSlotAcquired])

	/**
	 * Release the slot back to the pool, preserving its state.
	 */
	const release = useCallback(() => {
		if (!isAcquiredRef.current) return
		releaseSlot(leafId)
		isAcquiredRef.current = false
		setSlot(null)
	}, [leafId])

	/**
	 * Flush any dormant-buffered data for this leaf by writing it to the terminal.
	 */
	const flushDormantData = useCallback(
		(write: (data: Uint8Array) => void): void => {
			const chunks = sessionDormantRing.drain(leafId)
			for (const chunk of chunks) {
				write(chunk)
			}
		},
		[leafId],
	)

	/**
	 * Push PTY data to the dormant buffer (for when terminal is hidden).
	 * This data will be flushed when the terminal becomes visible again.
	 */
	const pushDormantData = useCallback(
		(data: Uint8Array): void => {
			sessionDormantRing.push(leafId, data)
			onDataRef.current?.(data)
		},
		[leafId],
	)

	// Acquire on mount, release on unmount
	useEffect(() => {
		acquire()
		return () => {
			release()
		}
	}, [acquire, release])

	// Track visibility changes
	useEffect(() => {
		if (isVisible) {
			// Becoming visible — ensure we have a slot
			if (!isAcquiredRef.current) {
				acquire()
			}
		}
		// Note: when becoming hidden, we keep the slot
		// The actual visibility toggle (visibility: hidden) keeps the slot alive.
		// Only release on unmount (handled above).
	}, [isVisible, acquire])

	// Track focus/blur for eviction scoring
	const handleFocus = useCallback(() => {
		markSlotFocused(leafId)
	}, [leafId])

	const handleBlur = useCallback(() => {
		markSlotBlurred(leafId)
	}, [leafId])

	return {
		slot,
		containerRef,
		isAcquired: isAcquiredRef.current,
		acquire,
		release,
		flushDormantData,
		pushDormantData,
	}
}
