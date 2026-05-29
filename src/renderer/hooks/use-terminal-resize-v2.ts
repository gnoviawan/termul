import { useEffect, useRef, useCallback } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

/**
 * Two-stage resize debounce pipeline for terminal panes.
 *
 * Stage 1 (8ms): Debounces fitAddon.fit() calls so the UI stays responsive
 * during continuous drag without calling fit() on every ResizeObserver tick.
 *
 * Stage 2 (256ms): Debounces PTY resize IPC so we don't spam the backend
 * with resize calls during drag. Only fires after the user has stopped
 * dragging for 256ms, or on the final dimension change.
 *
 * Both stages skip entirely when container dimensions haven't changed,
 * and scroll position is preserved across fit() calls.
 */

/** Debounce for fit() — keeps UI responsive during drag */
const FIT_DEBOUNCE_MS = 8

/** Debounce for PTY resize IPC — caps at ~4 calls/sec */
const PTY_RESIZE_DEBOUNCE_MS = 256

export interface UseTerminalResizeV2Options {
	/** Called with new cols/rows after a confirmed dimension change */
	onPtyResize: (cols: number, rows: number) => void
	/** Ref to the xterm.js Terminal instance (updated lazily) */
	terminalRef: React.RefObject<Terminal | null>
	/** Ref to the FitAddon instance (updated lazily) */
	fitAddonRef: React.RefObject<FitAddon | null>
	/** The container element to observe */
	containerRef: React.RefObject<HTMLDivElement | null>
	/** Whether the terminal is currently visible (skips processing when hidden) */
	isVisible?: boolean
}

export interface UseTerminalResizeV2Return {
	/** Force an immediate fit + PTY resize (used after visibility change, init, etc.) */
	forceFit: () => void
}

export function useTerminalResizeV2(
	options: UseTerminalResizeV2Options,
): UseTerminalResizeV2Return {
	const { onPtyResize, terminalRef, fitAddonRef, containerRef, isVisible = true } =
		options

	// Refs for timer IDs — must be refs to avoid stale closures in ResizeObserver
	const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const ptyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	// Track last known dimensions to detect skips
	const lastContainerWidthRef = useRef<number>(0)
	const lastContainerHeightRef = useRef<number>(0)
	const lastColsRef = useRef<number>(0)
	const lastRowsRef = useRef<number>(0)

	// Track visibility to suppress resize processing when hidden
	const isVisibleRef = useRef(isVisible)
	isVisibleRef.current = isVisible

	// Stable callback refs
	const onPtyResizeRef = useRef(onPtyResize)
	onPtyResizeRef.current = onPtyResize

	/**
	 * Perform fit() and conditionally schedule PTY resize.
	 * Returns true if fit was actually performed (dimensions changed).
	 */
	const performFit = useCallback(
		(force = false): boolean => {
			const fitAddon = fitAddonRef.current
			const terminal = terminalRef.current
			const container = containerRef.current
			if (!fitAddon || !terminal || !container) return false

			const rect = container.getBoundingClientRect()
			const width = Math.round(rect.width)
			const height = Math.round(rect.height)

			// Guard against fitting to a collapsed container. After a Windows
			// minimize→restore the webview reflows over several frames; during that
			// window getBoundingClientRect() can report a tiny height. Calling fit()
			// then collapses the terminal grid to 1-2 rows (the PTY redraws tiny,
			// showing "1-2 lines" until a later fit corrects it). Never fit unless
			// the container is large enough to hold a usable grid — this protects
			// every caller (ResizeObserver, forceFit, recovery).
			const MIN_FIT_WIDTH = 40
			const MIN_FIT_HEIGHT = 40
			if (width < MIN_FIT_WIDTH || height < MIN_FIT_HEIGHT) {
				return false
			}

			// Skip if dimensions haven't changed (and not forced)
			if (
				!force &&
				width === lastContainerWidthRef.current &&
				height === lastContainerHeightRef.current
			) {
				return false
			}

			// Save scroll position before fit to preserve it across the v6 viewport rewrite.
			const buffer = terminal.buffer?.active
			const scrollTop = buffer?.viewportY ?? 0
			const baseY = buffer?.baseY ?? 0

			try {
				fitAddon.fit()
			} catch {
				// fit() can throw if terminal is not ready
				return false
			}

			// Update tracked dimensions after successful fit
			if (width > 0 && height > 0) {
				lastContainerWidthRef.current = width
				lastContainerHeightRef.current = height
			}

			// Restore scroll position if user was scrolled up
			if (scrollTop > 0 && scrollTop < baseY) {
				terminal.scrollToLine(scrollTop)
			}

			return true
		},
		[fitAddonRef, terminalRef, containerRef],
	)

	const performFitRef = useRef(performFit)
	performFitRef.current = performFit

	/**
	 * Handle the PTY resize stage. Called after fit() confirms new dimensions.
	 */
	const schedulePtyResize = useCallback(
		(cols: number, rows: number): void => {
			// Skip if dimensions haven't changed
			if (
				cols === lastColsRef.current &&
				rows === lastRowsRef.current
			) {
				return
			}

			// Clear any pending PTY resize
			if (ptyTimerRef.current) {
				clearTimeout(ptyTimerRef.current)
			}

			// Debounce PTY resize IPC
			ptyTimerRef.current = setTimeout(() => {
				ptyTimerRef.current = null
				if (
					cols === lastColsRef.current &&
					rows === lastRowsRef.current
				) {
					// Dimensions already reported — skip
					return
				}
				lastColsRef.current = cols
				lastRowsRef.current = rows
				onPtyResizeRef.current(cols, rows)
			}, PTY_RESIZE_DEBOUNCE_MS)
		},
		[],
	)

	const schedulePtyResizeRef = useRef(schedulePtyResize)
	schedulePtyResizeRef.current = schedulePtyResize

	/**
	 * Force an immediate fit + PTY resize, bypassing both debounce stages.
	 * Used when the terminal becomes visible after being hidden, or on init.
	 */
	const forceFit = useCallback((): void => {
		// Clear any pending PTY debounce timer to prevent stale overwrites
		if (ptyTimerRef.current) {
			clearTimeout(ptyTimerRef.current)
			ptyTimerRef.current = null
		}

		const didFit = performFitRef.current(true)
		const terminal = terminalRef.current
		if (didFit && terminal) {
			const cols = terminal.cols
			const rows = terminal.rows
			// Force immediate PTY resize — skip debounce
			lastColsRef.current = cols
			lastRowsRef.current = rows
			onPtyResizeRef.current(cols, rows)
		}
	}, [terminalRef])

	// Set up ResizeObserver for the two-stage pipeline
	useEffect(() => {
		const container = containerRef.current
		if (!container) return

		const handleResize = (): void => {
			// Skip resize processing when terminal is hidden
			if (!isVisibleRef.current) return

			// Stage 1: Fit debounce (8ms)
			if (fitTimerRef.current) {
				clearTimeout(fitTimerRef.current)
			}

			fitTimerRef.current = setTimeout(() => {
				fitTimerRef.current = null

				const didFit = performFitRef.current(false)
				if (!didFit) return

				// Stage 2: PTY resize debounce (256ms)
				const term = terminalRef.current
				if (!term) return

				const cols = term.cols
				const rows = term.rows
				schedulePtyResizeRef.current(cols, rows)
			}, FIT_DEBOUNCE_MS)
		}

		const observer = new ResizeObserver(handleResize)
		observer.observe(container)

		return () => {
			observer.disconnect()
			if (fitTimerRef.current) {
				clearTimeout(fitTimerRef.current)
				fitTimerRef.current = null
			}
			if (ptyTimerRef.current) {
				clearTimeout(ptyTimerRef.current)
				ptyTimerRef.current = null
			}
		}
	}, [containerRef, terminalRef])

	return { forceFit }
}