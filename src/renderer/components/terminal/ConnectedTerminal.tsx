import {
	useEffect,
	useRef,
	memo,
	useCallback,
	useMemo,
	useImperativeHandle,
	useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import type { TerminalSpawnOptions } from "../../../shared/types/ipc.types";
import { getTerminalOptions, RESIZE_DEBOUNCE_MS } from "./terminal-config";
import {
	registerTerminal,
	unregisterTerminal,
	restoreScrollback,
	captureScrollPosition,
	restoreScrollPosition,
} from "../../utils/terminal-registry";
import {
	useTerminalFontFamily,
	useTerminalFontSize,
	useTerminalBufferSize,
} from "@/stores/app-settings-store";
import {
	useKeyboardShortcutsStore,
	normalizeKeyEvent,
} from "@/stores/keyboard-shortcuts-store";
import { useTerminalStore } from "@/stores/terminal-store";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useTerminalClipboard } from "@/hooks/use-terminal-clipboard";
import { terminalApi, systemApi } from "@/lib/api";
import { addRendererRef, removeRendererRef } from "@/lib/tauri-terminal-api";
import { isTerminalPendingPtyAssignment } from "@/hooks/use-terminal-restore";
import {
	getOrCreateProjectContinuityCorrelation,
	recordTerminalContinuityEvent,
} from "@/lib/terminal-continuity-instrumentation";

// Module-level constants - defined once per module
const MAX_WEBGL_RECOVERY_ATTEMPTS = 3;
const WEBGL_CONTEXT_LOSS_RECOVERY_DELAY_MS = 100; // GPU driver recovery time
const VISIBILITY_RECOVERY_DELAY_MS = 150; // DOM reflow after tab becomes visible
const POWER_RESUME_RECOVERY_DELAY_MS = 300; // System stabilize after wake
const ACTIVITY_DEBOUNCE_MS = 1000; // Debounce activity updates to max 1 per second
const CLIPBOARD_RATE_LIMIT_MS = 100; // Minimum ms between clipboard operations

export interface TerminalSearchHandle {
	findNext: (term: string) => boolean;
	findPrevious: (term: string) => boolean;
	clearDecorations: () => void;
	writeText: (text: string) => void;
}

export interface ConnectedTerminalProps {
	terminalId?: string;
	storeTerminalId?: string;
	spawnOptions?: TerminalSpawnOptions;
	onSpawned?: (terminalId: string) => void;
	autoSpawn?: boolean;
	onBoundToStoreTerminal?: (ptyId: string) => void;
	onExit?: (exitCode: number, signal?: number) => void;
	onError?: (error: string) => void;
	onCommand?: (command: string) => void;
	className?: string;
	autoFocus?: boolean;
	initialScrollback?: string[]; // Scrollback to restore on mount
	searchRef?: React.Ref<TerminalSearchHandle>;
	isVisible?: boolean; // Whether this terminal is currently visible (for fit triggering)
}

const PARTIAL_RESTORE_NOTE =
	"\x1b[33m\r\n[Restore note: alternate-screen or redraw-heavy output may be partially reconstructed from transcript replay]\x1b[0m\r\n";

function getInstrumentationProjectId(
	spawnOptions?: TerminalSpawnOptions,
): string | undefined {
	const candidate = spawnOptions?.projectId;
	return typeof candidate === "string" ? candidate : undefined;
}

function ConnectedTerminalComponent({
	terminalId: externalTerminalId,
	storeTerminalId,
	spawnOptions,
	onSpawned,
	autoSpawn = true,
	onExit,
	onError,
	onCommand,
	onBoundToStoreTerminal,
	className = "",
	autoFocus = true,
	initialScrollback,
	searchRef,
	isVisible = true,
}: ConnectedTerminalProps): React.JSX.Element {
	// DEBUG: Unique instance ID for tracking
	const instanceIdRef = useRef<string>(
		`conn-${Math.random().toString(36).slice(2, 9)}`,
	);
	const instanceId = instanceIdRef.current;

	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const searchAddonRef = useRef<SearchAddon | null>(null);
	const webglAddonRef = useRef<WebglAddon | null>(null);
	const webglRecoveryAttemptsRef = useRef<number>(0);
	const webglRecoveryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const loadWebglAddonRef = useRef<
		((term: Terminal, isRecovery?: boolean) => void) | null
	>(null);
	// Track WebGL context loss for recovery decisions
	const webglContextLostRef = useRef<boolean>(false);

	// Get font settings from app settings store
	const fontFamily = useTerminalFontFamily();
	const fontSize = useTerminalFontSize();
	const bufferSize = useTerminalBufferSize();

	// Get keyboard shortcuts to intercept app shortcuts before xterm handles them
	const shortcuts = useKeyboardShortcutsStore((state) => state.shortcuts);
	// Use ref to avoid stale closure in attachCustomKeyEventHandler
	const shortcutsRef = useRef(shortcuts);
	shortcutsRef.current = shortcuts;
	const cleanupDataListenerRef = useRef<(() => void) | null>(null);
	const cleanupExitListenerRef = useRef<(() => void) | null>(null);
	// Use ref to track current PTY ID for listener callbacks to avoid stale closures
	const ptyIdRef = useRef<string | null>(null);
	const spawnInFlightRef = useRef(false);
	const didInitRef = useRef(false);
	const initializedTerminalIdRef = useRef<string | undefined>(undefined);
	// Use refs for callbacks to avoid dependency changes
	const onExitRef = useRef(onExit);
	onExitRef.current = onExit;
	const onCommandRef = useRef(onCommand);
	onCommandRef.current = onCommand;
	const onBoundToStoreTerminalRef = useRef(onBoundToStoreTerminal);
	onBoundToStoreTerminalRef.current = onBoundToStoreTerminal;
	// Track current input line for command history
	const currentLineRef = useRef<string>("");
	const continuityProjectIdRef = useRef<string | undefined>(
		getInstrumentationProjectId(spawnOptions),
	);
	// Flag: set when tab becomes visible before PTY is ready, to flush fit+resize after spawn
	const terminalInitializedForRef = useRef<string | undefined>(undefined);
	const needsResizeOnReadyRef = useRef<boolean>(false);
	// Resize debounce timer ref
	const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Activity timeout timer ref
	const activityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Debounced activity tracking refs
	const lastActivityUpdateRef = useRef<number>(0);
	const pendingActivityUpdateRef = useRef<{ id: string } | null>(null);

	// Rate limiting for clipboard operations
	const lastClipboardOpRef = useRef<number>(0);

	// State to track terminal instance for clipboard hook
	const [terminalInstance, setTerminalInstance] = useState<Terminal | null>(
		null,
	);

	// Clipboard functionality
	const { copySelection, pasteFromClipboard, hasSelection } =
		useTerminalClipboard({
			terminal: terminalInstance,
		});

	// Sync ptyIdRef with external terminal ID when provided
	useEffect(() => {
		if (externalTerminalId) {
			ptyIdRef.current = externalTerminalId;
		}
	}, [externalTerminalId]);

	const instrumentationProjectId = getInstrumentationProjectId(spawnOptions);

	useEffect(() => {
		if (instrumentationProjectId) {
			continuityProjectIdRef.current = instrumentationProjectId;
		}
	}, [instrumentationProjectId]);

	useEffect(() => {
		if (
			!externalTerminalId ||
			isTerminalPendingPtyAssignment(externalTerminalId)
		) {
			return;
		}

		const store = useTerminalStore.getState();
		store.setRendererAttached(externalTerminalId, true);

		return () => {
			useTerminalStore
				.getState()
				.setRendererAttached(externalTerminalId, false);
		};
	}, [externalTerminalId]);

	// Memoize spawn options to prevent unnecessary re-spawns
	const memoizedSpawnOptions = useMemo(
		() => spawnOptions,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[
			spawnOptions?.shell,
			spawnOptions?.cwd,
			spawnOptions?.cols,
			spawnOptions?.rows,
			spawnOptions?.env,
		],
	);

	// Handle input from xterm to PTY
	const handleTerminalData = useCallback(
		async (data: string): Promise<void> => {
			const ptyId = ptyIdRef.current;
			if (!ptyId) return;

			// Track command input for history
			if (data === "\r" || data === "\n") {
				// Enter pressed - capture command
				const command = currentLineRef.current;
				currentLineRef.current = "";
				if (command && onCommandRef.current) {
					onCommandRef.current(command);
				}
			} else if (data === "\x7f" || data === "\b") {
				// Backspace
				currentLineRef.current = currentLineRef.current.slice(0, -1);
			} else if (data === "\x03") {
				// Ctrl+C - clear current line
				currentLineRef.current = "";
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
				// Printable character
				currentLineRef.current += data;
			} else if (data.length > 1) {
				// Pasted text
				currentLineRef.current += data;
			}

			try {
				const result = await terminalApi.write(ptyId, data);
				if (!result.success && onError) {
					onError(result.error);
				}
			} catch (err) {
				if (onError) {
					onError(err instanceof Error ? err.message : "Write failed");
				}
			}
		},
		[onError],
	);

	// Handle resize events with debouncing to prevent IPC flooding
	const handleResize = useCallback(
		async (cols: number, rows: number): Promise<void> => {
			const ptyId = ptyIdRef.current;
			if (!ptyId) return;

			// Clear existing timeout
			if (resizeTimeoutRef.current) {
				clearTimeout(resizeTimeoutRef.current);
			}

			// Debounce resize IPC calls - re-read ptyId inside timeout to avoid stale closure
			resizeTimeoutRef.current = setTimeout(async () => {
				const currentPtyId = ptyIdRef.current;
				if (!currentPtyId) return;

				try {
					await terminalApi.resize(currentPtyId, cols, rows);
				} catch {
					// Ignore resize errors during rapid resize
				}
			}, RESIZE_DEBOUNCE_MS);
		},
		[],
	);

	// Expose search methods via ref
	useImperativeHandle(
		searchRef,
		() => ({
			findNext: (term: string) => {
				if (!searchAddonRef.current) return false;
				return searchAddonRef.current.findNext(term, {
					decorations: {
						matchBackground: "#444444",
						matchBorder: "#888888",
						matchOverviewRuler: "#888888",
						activeMatchBackground: "#FFFF00",
						activeMatchBorder: "#FFFF00",
						activeMatchColorOverviewRuler: "#FFFF00",
					},
				});
			},
			findPrevious: (term: string) => {
				if (!searchAddonRef.current) return false;
				return searchAddonRef.current.findPrevious(term, {
					decorations: {
						matchBackground: "#444444",
						matchBorder: "#888888",
						matchOverviewRuler: "#888888",
						activeMatchBackground: "#FFFF00",
						activeMatchBorder: "#FFFF00",
						activeMatchColorOverviewRuler: "#FFFF00",
					},
				});
			},
			clearDecorations: () => {
				if (searchAddonRef.current) {
					searchAddonRef.current.clearDecorations();
				}
			},
			writeText: (text: string) => {
				const ptyId = ptyIdRef.current;
				if (!ptyId) return;
				terminalApi.write(ptyId, text);
			},
		}),
		[],
	);

	const shouldDebugLog = import.meta.env.DEV;
	const devLog = (...args: unknown[]): void => {
		if (shouldDebugLog) {
			console.log(...args);
		}
	};

	// Initialize terminal, set up IPC listeners, and spawn PTY
	useEffect(() => {
		const debugId = `${instanceId}-${Date.now().toString().slice(-6)}`;

		devLog(`[ConnectedTerminal] MOUNT [${debugId}]`, {
			instanceId,
			externalTerminalId,
			autoSpawn,
			spawnOptions,
			isVisible,
		});

		if (!containerRef.current) {
			devLog(`[ConnectedTerminal] SKIP [${debugId}]: no container`);
			return;
		}

		// Check if we're initializing a new terminal (different from previous)
		const terminalKey = externalTerminalId ?? "new";
		devLog(`[ConnectedTerminal] terminalKey check [${debugId}]`, {
			terminalKey,
			didInit: didInitRef.current,
			initializedKey: initializedTerminalIdRef.current,
			willSkip:
				didInitRef.current && initializedTerminalIdRef.current === terminalKey,
		});

		if (
			didInitRef.current &&
			initializedTerminalIdRef.current === terminalKey
		) {
			devLog(
				`[ConnectedTerminal] SKIP [${debugId}]: already initialized for ${terminalKey}`,
			);
			return;
		}

		// Reset init state for new terminal
		didInitRef.current = true;
		initializedTerminalIdRef.current = terminalKey;

		devLog(
			`[ConnectedTerminal] INITIALIZING [${debugId}] for key: ${terminalKey}`,
		);

		// Merge platform-aware options with dynamic app settings
		const terminalOptions = {
			...getTerminalOptions(navigator.platform),
			fontFamily,
			fontSize,
			scrollback: bufferSize,
		};
		const terminal = new Terminal(terminalOptions);
		terminalRef.current = terminal;
		setTerminalInstance(terminal);

		const fitAddon = new FitAddon();
		fitAddonRef.current = fitAddon;
		terminal.loadAddon(fitAddon);

		const webLinksAddon = new WebLinksAddon();
		terminal.loadAddon(webLinksAddon);

		// Load search addon
		const searchAddon = new SearchAddon();
		searchAddonRef.current = searchAddon;
		terminal.loadAddon(searchAddon);

		terminal.open(containerRef.current);

		// Intercept keyboard shortcuts before xterm processes them
		// Return false to prevent xterm from handling, true to let xterm handle
		terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
			if (event.type !== "keydown") return true;

			const normalized = normalizeKeyEvent(event);
			const shortcuts = shortcutsRef.current;

			// Check if this key matches any app shortcut
			for (const shortcut of Object.values(shortcuts)) {
				const activeKey = shortcut.customKey ?? shortcut.defaultKey;
				if (normalized === activeKey) {
					// Don't call stopPropagation() - let event bubble to window handler
					// Return false to prevent xterm from handling the event
					return false;
				}
			}

			// Handle copy/paste/select all keyboard shortcuts
			const isCtrlOrCmd = event.ctrlKey || event.metaKey;

			if (isCtrlOrCmd) {
				// Rate limit check
				const now = Date.now();
				if (now - lastClipboardOpRef.current < CLIPBOARD_RATE_LIMIT_MS) {
					return false; // Rate limited - prevent xterm handling but don't process
				}

				switch (event.key.toLowerCase()) {
					case "c":
						// Copy: if selection exists, copy and prevent xterm handling
						// Otherwise allow xterm to handle (for interrupt signal)
						if (terminal.hasSelection()) {
							event.preventDefault();
							const selection = terminal.getSelection();
							if (selection) {
								lastClipboardOpRef.current = now;
								// Use the hook's copySelection for consistency
								void copySelection();
							}
							return false;
						}
						// No selection - allow xterm to send Ctrl+C (interrupt signal)
						return true;

					case "v":
						// Paste: read clipboard and paste to terminal
						event.preventDefault();
						lastClipboardOpRef.current = now;
						// Use the hook's pasteFromClipboard for consistency
						void pasteFromClipboard();
						return false;

					case "a":
						// Select all
						terminal.selectAll();
						return false;
				}
			}

			return true;
		});

		// WebGL addon loading with context loss recovery
		const loadWebglAddon = (
			term: Terminal,
			isRecovery: boolean = false,
		): void => {
			if (webglRecoveryAttemptsRef.current >= MAX_WEBGL_RECOVERY_ATTEMPTS) {
				console.warn(
					"WebGL recovery attempts exhausted, falling back to canvas renderer",
				);
				return;
			}
			try {
				const webglAddon = new WebglAddon();
				webglAddon.onContextLoss(() => {
					webglAddon.dispose();
					webglAddonRef.current = null;
					// Mark context as lost for recovery decisions
					webglContextLostRef.current = true;
					// Increment recovery counter BEFORE scheduling recovery
					webglRecoveryAttemptsRef.current++;
					// Clear any pending recovery timeout
					if (webglRecoveryTimeoutRef.current) {
						clearTimeout(webglRecoveryTimeoutRef.current);
					}
					// Delay before recovery to avoid rapid-fire loops
					webglRecoveryTimeoutRef.current = setTimeout(() => {
						webglRecoveryTimeoutRef.current = null;
						loadWebglAddon(term, true);
					}, WEBGL_CONTEXT_LOSS_RECOVERY_DELAY_MS);
				});
				term.loadAddon(webglAddon);
				webglAddonRef.current = webglAddon;
				// Clear context lost flag on successful load
				webglContextLostRef.current = false;
				// Note: Counter NOT reset here - only increments on context loss or failure
				// This prevents infinite recovery loops on persistent GPU issues
			} catch (error) {
				console.warn(
					"WebGL addon failed to load, falling back to canvas renderer:",
					error,
				);
				webglAddonRef.current = null;
				webglRecoveryAttemptsRef.current++;
			}
		};

		loadWebglAddon(terminal);
		// Store reference for recovery handlers to use
		loadWebglAddonRef.current = loadWebglAddon;

		// Defer initial fit to next animation frame so the WebGL renderer has time
		// to fully initialize its internal _renderer.value before we call dimensions.
		// Calling fit() synchronously after loadWebglAddon() causes an uncaught
		// "Cannot read properties of undefined (reading 'dimensions')" from xterm.
		requestAnimationFrame(() => {
			if (!fitAddonRef.current) return;
			try {
				fitAddonRef.current.fit();
			} catch {
				// Ignore fit errors on initial mount if container is 0x0
			}
		});

		if (autoFocus) {
			terminal.focus();
		}

		// Set up resize observer
		const resizeObserver = new ResizeObserver(() => {
			requestAnimationFrame(() => {
				if (fitAddonRef.current && terminalRef.current) {
					try {
						fitAddonRef.current.fit();
					} catch {
						// Ignore fit errors during rapid resize
					}
				}
			});
		});
		resizeObserver.observe(containerRef.current);

		// Listen for input from xterm
		const dataDisposable = terminal.onData(handleTerminalData);
		const resizeDisposable = terminal.onResize(({ cols, rows }) => {
			handleResize(cols, rows);
		});

		// Set up IPC listeners BEFORE spawning to avoid missing data
		// Cache ptyId -> terminalId mapping to avoid repeated store lookups
		let cachedTerminalId: string | null = null;
		cleanupDataListenerRef.current = terminalApi.onData(
			(id: string, data: string) => {
				if (id === ptyIdRef.current && terminalRef.current) {
					terminalRef.current.write(data);
					// Resolve terminal record ID (cached to avoid linear scan)
					if (!cachedTerminalId) {
						const terminalRecord = useTerminalStore
							.getState()
							.findTerminalByPtyId(id);
						if (terminalRecord) {
							cachedTerminalId = terminalRecord.id;
						}
					}
					if (cachedTerminalId) {
						const now = Date.now();
						const timeSinceLastUpdate = now - lastActivityUpdateRef.current;

						// If enough time has passed since last update, update immediately
						if (timeSinceLastUpdate >= ACTIVITY_DEBOUNCE_MS) {
							useTerminalStore
								.getState()
								.updateTerminalActivityBatch(cachedTerminalId, true, now);
							lastActivityUpdateRef.current = now;
						} else {
							// Otherwise, store pending update for later
							pendingActivityUpdateRef.current = { id: cachedTerminalId };
						}

						// Clear existing activity timeout and set new one
						if (activityTimeoutRef.current) {
							clearTimeout(activityTimeoutRef.current);
						}
						const termId = cachedTerminalId;
						activityTimeoutRef.current = setTimeout(() => {
							// Flush any pending activity update
							if (pendingActivityUpdateRef.current) {
								useTerminalStore
									.getState()
									.updateTerminalActivityBatch(
										pendingActivityUpdateRef.current.id,
										false,
										Date.now(),
									);
								pendingActivityUpdateRef.current = null;
							} else {
								// Clear activity after 2 seconds of inactivity
								useTerminalStore
									.getState()
									.updateTerminalActivityBatch(termId, false, Date.now());
							}
							activityTimeoutRef.current = null;
							lastActivityUpdateRef.current = 0;
						}, 2000);
					}
				}
			},
		);

		cleanupExitListenerRef.current = terminalApi.onExit(
			(id: string, exitCode: number, signal?: number) => {
				if (id === ptyIdRef.current && onExitRef.current) {
					onExitRef.current(exitCode, signal);
				}
			},
		);

		// Spawn terminal if no external ID provided and auto-spawn enabled
		const initTerminal = async (): Promise<void> => {
			const spawnDebugId = `${instanceId}-spawn-${Date.now().toString().slice(-6)}`;
			const recordReplayEvent = (
				name:
					| "restore-replay-attempted"
					| "restore-replay-succeeded"
					| "restore-replay-failed"
					| "restore-replay-skipped",
				details?: Record<string, unknown>,
				terminalEventId?: string,
				ptyId?: string,
			): void => {
				const projectId = continuityProjectIdRef.current;
				recordTerminalContinuityEvent({
					name,
					correlationId: getOrCreateProjectContinuityCorrelation(projectId),
					projectId,
					terminalId: terminalEventId,
					ptyId,
					details,
				});
			};

			devLog(`[ConnectedTerminal.initTerminal] START [${spawnDebugId}]`, {
				externalTerminalId,
				autoSpawn,
				spawnInFlight: spawnInFlightRef.current,
				hasPtyId: !!ptyIdRef.current,
			});

			// Fit to get real dimensions BEFORE spawning
			try {
				fitAddon.fit();
			} catch {
				// Ignore fit errors if container not properly laid out yet
			}
			const spawnCols = terminal.cols || 80;
			const spawnRows = terminal.rows || 24;

			if (!externalTerminalId) {
				if (!autoSpawn) {
					devLog(
						`[ConnectedTerminal.initTerminal] SKIP [${spawnDebugId}]: autoSpawn is false`,
					);
					return;
				}
				if (spawnInFlightRef.current || ptyIdRef.current) {
					devLog(
						`[ConnectedTerminal.initTerminal] SKIP [${spawnDebugId}]: already spawning or has PTY`,
					);
					return;
				}
			} else if (isTerminalPendingPtyAssignment(externalTerminalId)) {
				devLog(
					`SKIP autoSpawn: terminal ${externalTerminalId} pending PTY assignment from restore`,
				);
				return;
			}

			if (!externalTerminalId) {
				spawnInFlightRef.current = true;
				devLog(`[ConnectedTerminal.initTerminal] SPAWNING [${spawnDebugId}]`, {
					cols: spawnCols,
					rows: spawnRows,
					spawnOpts: memoizedSpawnOptions,
				});

				try {
					const spawnOpts = {
						...memoizedSpawnOptions,
						// Ensure empty shell string is treated as undefined so Rust uses default
						shell: memoizedSpawnOptions?.shell || undefined,
						cols: spawnCols,
						rows: spawnRows,
					};
					const result = await terminalApi.spawn(spawnOpts);
					devLog(
						`[ConnectedTerminal.initTerminal] SPAWN RESULT [${spawnDebugId}]`,
						{
							success: result.success,
							error: result.success ? undefined : result.error,
							ptyId: result.success ? result.data.id : "FAILED",
						},
					);

					if (result.success) {
						// Update ref immediately so listener can start processing data
						ptyIdRef.current = result.data.id;
						useTerminalStore
							.getState()
							.setRendererAttached(result.data.id, true);
						void addRendererRef(result.data.id, instanceIdRef.current);
						// If tab was visible before PTY was ready, flush deferred fit+resize now
						if (needsResizeOnReadyRef.current) {
							needsResizeOnReadyRef.current = false;
							try {
								fitAddonRef.current?.fit();
							} catch {
								/* ignore */
							}
							terminalApi
								.resize(result.data.id, terminal.cols, terminal.rows)
								.catch(() => {});
						}
						// Register terminal for scrollback persistence
						registerTerminal(result.data.id, terminal);
						const terminalStoreState = useTerminalStore.getState();
						const transcript = terminalStoreState.peekTranscript(result.data.id);
						const transcriptLooksPartial =
							transcript.includes("\u001b[?1049h") || transcript.includes("\u001b[?47h");
						recordReplayEvent(
							"restore-replay-attempted",
							{
								mode: transcript ? "transcript" : initialScrollback?.length ? "scrollback" : "none",
								transcriptLength: transcript.length,
								initialScrollbackLineCount: initialScrollback?.length ?? 0,
								source: "spawned-terminal",
								alternateScreenDetected: transcriptLooksPartial,
							},
							storeTerminalId,
							result.data.id,
						);
						try {
							if (transcript) {
								terminal.write(transcript);
								if (transcriptLooksPartial) {
									terminal.write(PARTIAL_RESTORE_NOTE);
								}
								terminalStoreState.consumeTranscript(result.data.id);
								recordReplayEvent(
									"restore-replay-succeeded",
									{
										mode: "transcript",
										transcriptLength: transcript.length,
										source: "spawned-terminal",
										fullFidelity: !transcriptLooksPartial,
										restoreLimitation: transcriptLooksPartial
											? "alternate-screen-or-in-place-redraw"
											: undefined,
									},
									storeTerminalId,
									result.data.id,
								);
							} else if (initialScrollback && initialScrollback.length > 0) {
								restoreScrollback(terminal, initialScrollback);
								recordReplayEvent(
									"restore-replay-succeeded",
									{
										mode: "scrollback",
										initialScrollbackLineCount: initialScrollback.length,
										source: "spawned-terminal",
									},
									storeTerminalId,
									result.data.id,
								);
							} else {
								recordReplayEvent(
									"restore-replay-skipped",
									{
										reason: "no-persisted-history",
										source: "spawned-terminal",
									},
									storeTerminalId,
									result.data.id,
								);
							}
						} catch (error) {
							const replayError = error instanceof Error ? error.message : String(error);
							recordReplayEvent(
								"restore-replay-failed",
								{
									mode: transcript ? "transcript" : initialScrollback?.length ? "scrollback" : "none",
									error: replayError,
									source: "spawned-terminal",
								},
								storeTerminalId,
								result.data.id,
							);
							console.error("[Terminal Replay Failed]", replayError);
							if (onError) onError(replayError);
						}
						// Write one-time info line if project env vars were applied
						if (
							memoizedSpawnOptions?.env &&
							Object.keys(memoizedSpawnOptions.env).length > 0
						) {
							const envCount = Object.keys(memoizedSpawnOptions.env).length;
							terminal.write(
								`\x1b[36m\r\n[Project env: ${envCount} variable${envCount !== 1 ? "s" : ""} applied]\x1b[0m\r\n`,
							);
						}
						// Restore scroll position if cached from previous pane
						restoreScrollPosition(result.data.id, terminal);
						if (onSpawned) {
							onSpawned(result.data.id);
						}
						if (onBoundToStoreTerminalRef.current) {
							onBoundToStoreTerminalRef.current(result.data.id);
						}
					} else {
						const errorMsg = result.error || "Unknown spawn error";
						console.error("[Terminal Spawn Failed]", errorMsg);
						terminal.write(
							`\x1b[31m\r\nFailed to spawn terminal process:\r\n${errorMsg}\x1b[0m\r\n`,
						);
						if (onError) onError(errorMsg);
					}
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : "Spawn failed";
					console.error("[Terminal Spawn Exception]", errorMsg);
					terminal.write(
						`\x1b[31m\r\nTerminal spawn exception:\r\n${errorMsg}\x1b[0m\r\n`,
					);
					if (onError) onError(errorMsg);
				} finally {
					spawnInFlightRef.current = false;
				}
			} else {
				// External terminal ID provided - register and restore scrollback
				devLog(
					`[ConnectedTerminal.initTerminal] EXTERNAL PTY [${spawnDebugId}]`,
					{
						externalTerminalId,
					},
				);
				void addRendererRef(externalTerminalId, instanceIdRef.current);
				registerTerminal(externalTerminalId, terminal);
				const terminalStoreState = useTerminalStore.getState();
				const transcript = terminalStoreState.peekTranscript(externalTerminalId);
				const transcriptLooksPartial =
					transcript.includes("\u001b[?1049h") || transcript.includes("\u001b[?47h");
				recordReplayEvent(
					"restore-replay-attempted",
					{
						mode: transcript ? "transcript" : initialScrollback?.length ? "scrollback" : "none",
						transcriptLength: transcript.length,
						initialScrollbackLineCount: initialScrollback?.length ?? 0,
						source: "external-terminal",
						alternateScreenDetected: transcriptLooksPartial,
					},
					storeTerminalId,
					externalTerminalId,
				);
				try {
					if (transcript) {
						terminal.write(transcript);
						if (transcriptLooksPartial) {
							terminal.write(PARTIAL_RESTORE_NOTE);
						}
						terminalStoreState.consumeTranscript(externalTerminalId);
						recordReplayEvent(
							"restore-replay-succeeded",
							{
								mode: "transcript",
								transcriptLength: transcript.length,
								source: "external-terminal",
								fullFidelity: !transcriptLooksPartial,
								restoreLimitation: transcriptLooksPartial
									? "alternate-screen-or-in-place-redraw"
									: undefined,
							},
							storeTerminalId,
							externalTerminalId,
						);
					} else if (initialScrollback && initialScrollback.length > 0) {
						restoreScrollback(terminal, initialScrollback);
						recordReplayEvent(
							"restore-replay-succeeded",
							{
								mode: "scrollback",
								initialScrollbackLineCount: initialScrollback.length,
								source: "external-terminal",
							},
							storeTerminalId,
							externalTerminalId,
						);
					} else {
						recordReplayEvent(
							"restore-replay-skipped",
							{
								reason: "no-persisted-history",
								source: "external-terminal",
							},
							storeTerminalId,
							externalTerminalId,
						);
					}
				} catch (error) {
					const replayError = error instanceof Error ? error.message : String(error);
					recordReplayEvent(
						"restore-replay-failed",
						{
							mode: transcript ? "transcript" : initialScrollback?.length ? "scrollback" : "none",
							error: replayError,
							source: "external-terminal",
						},
						storeTerminalId,
						externalTerminalId,
					);
					console.error("[Terminal Replay Failed]", replayError);
					if (onError) onError(replayError);
				}
				// Write one-time info line if project env vars were applied
				// (env should be passed via spawnOptions by the caller if this terminal was spawned with env vars)
				if (
					memoizedSpawnOptions?.env &&
					Object.keys(memoizedSpawnOptions.env).length > 0
				) {
					const envCount = Object.keys(memoizedSpawnOptions.env).length;
					terminal.write(
						`\x1b[36m\r\n[Project env: ${envCount} variable${envCount !== 1 ? "s" : ""} applied]\x1b[0m\r\n`,
					);
				}
				// Restore scroll position if cached from previous pane
				restoreScrollPosition(externalTerminalId, terminal);
				if (onBoundToStoreTerminalRef.current) {
					onBoundToStoreTerminalRef.current(externalTerminalId);
				}
			}
		};

		devLog(`[ConnectedTerminal] Calling initTerminal [${debugId}]`);
		initTerminal();

		return () => {
			devLog(`[ConnectedTerminal] UNMOUNT [${debugId}]`, {
				instanceId,
				ptyId: ptyIdRef.current,
				externalTerminalId,
			});
			// Capture scroll position BEFORE unregistering for pane transitions
			const terminalId = ptyIdRef.current || externalTerminalId;
			if (terminalId && terminalRef.current) {
				captureScrollPosition(terminalId);
				if (!externalTerminalId) {
					useTerminalStore.getState().setRendererAttached(terminalId, false);
				}
				void removeRendererRef(terminalId, instanceId);
			}

			// Unregister terminal from registry
			if (ptyIdRef.current) {
				unregisterTerminal(ptyIdRef.current);
			} else if (externalTerminalId) {
				unregisterTerminal(externalTerminalId);
			}

			// PTY lifecycle is handled by explicit terminal close, not component unmount
			resizeObserver.disconnect();
			dataDisposable.dispose();
			resizeDisposable.dispose();
			if (cleanupDataListenerRef.current) {
				cleanupDataListenerRef.current();
				cleanupDataListenerRef.current = null;
			}
			if (cleanupExitListenerRef.current) {
				cleanupExitListenerRef.current();
				cleanupExitListenerRef.current = null;
			}
			// Clean up resize debounce timer
			if (resizeTimeoutRef.current) {
				clearTimeout(resizeTimeoutRef.current);
			}
			// Clean up activity timeout timer
			if (activityTimeoutRef.current) {
				clearTimeout(activityTimeoutRef.current);
			}
			// Flush pending activity update on unmount
			if (pendingActivityUpdateRef.current) {
				useTerminalStore
					.getState()
					.updateTerminalActivityBatch(
						pendingActivityUpdateRef.current.id,
						true,
						Date.now(),
					);
				pendingActivityUpdateRef.current = null;
			}
			// Clean up WebGL recovery timeout to prevent race condition
			if (webglRecoveryTimeoutRef.current) {
				clearTimeout(webglRecoveryTimeoutRef.current);
				webglRecoveryTimeoutRef.current = null;
			}

			// Cursor cleanup: Disable cursor blink before WebGL disposal to prevent ghost cursors
			if (terminalRef.current) {
				terminalRef.current.options.cursorBlink = false;
			}

			// Dispose WebGL addon BEFORE terminal disposal for proper cursor layer cleanup
			if (webglAddonRef.current) {
				webglAddonRef.current.dispose();
				webglAddonRef.current = null;
			}

			terminal.dispose();
			terminalRef.current = null;
			setTerminalInstance(null);
			fitAddonRef.current = null;
			searchAddonRef.current = null;
			ptyIdRef.current = null;
			spawnInFlightRef.current = false;
			// Reset init flag so a new terminal can be created if component remounts
			didInitRef.current = false;
			initializedTerminalIdRef.current = undefined;
			// Reset WebGL recovery state for next terminal creation
			webglRecoveryAttemptsRef.current = 0;
			webglContextLostRef.current = false;
			loadWebglAddonRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Update terminal font settings when app settings change (without recreating terminal)
	useEffect(() => {
		if (terminalRef.current) {
			terminalRef.current.options.fontFamily = fontFamily;
			terminalRef.current.options.fontSize = fontSize;
			// Re-fit terminal after font change
			if (fitAddonRef.current) {
				try {
					fitAddonRef.current.fit();
				} catch {
					// Ignore fit errors
				}
			}
		}
	}, [fontFamily, fontSize]);

	// Trigger fit + PTY resize when terminal becomes visible
	// Uses double requestAnimationFrame for proper timing after pane transitions
	useEffect(() => {
		if (isVisible && fitAddonRef.current && terminalRef.current) {
			// Double RAF ensures DOM is fully rendered after pane transition
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					try {
						fitAddonRef.current?.fit();
					} catch {
						// Ignore fit errors
					}

					const terminal = terminalRef.current;
					const ptyId = ptyIdRef.current;
					if (terminal) {
						// Only focus if no interactive element (button, input, etc.) currently has focus.
						// This prevents stealing focus from TitleBar window controls when tab switch happens.
						const active = document.activeElement;
						const isInteractiveElementFocused =
							active &&
							active !== document.body &&
							(active.tagName === "BUTTON" ||
								active.tagName === "INPUT" ||
								active.tagName === "TEXTAREA" ||
								active.tagName === "SELECT" ||
								active.tagName === "A");
						if (!isInteractiveElementFocused) {
							terminal.focus();
						}

						if (ptyId) {
							// Restore scroll position after fit (in case of pane transition)
							restoreScrollPosition(ptyId, terminal);

							const resizePromise = terminalApi.resize(
								ptyId,
								terminal.cols,
								terminal.rows,
							);
							if (resizePromise && typeof resizePromise.catch === "function") {
								resizePromise.catch(() => {
									// Ignore resize errors when toggling visibility
								});
							}
						} else {
							// PTY not ready yet — defer resize until spawn completes
							needsResizeOnReadyRef.current = true;
						}
					}
				});
			});
		}
	}, [isVisible]);

	// Shared terminal recovery logic - re-fit and check WebGL health
	const performTerminalRecovery = useCallback((): void => {
		if (!fitAddonRef.current || !terminalRef.current) return;

		// Only recreate WebGL addon if context was actually lost and not already recovering
		// webglAddonRef is null after onContextLoss, so check !webglAddonRef.current
		if (webglContextLostRef.current && !webglAddonRef.current) {
			try {
				// Cancel any pending auto-recovery timeout to avoid double-creation race
				if (webglRecoveryTimeoutRef.current) {
					clearTimeout(webglRecoveryTimeoutRef.current);
					webglRecoveryTimeoutRef.current = null;
				}
				console.warn(
					"WebGL context was lost, recreating addon during recovery",
				);
				// Use shared loadWebglAddon for proper recovery (addon already disposed in onContextLoss)
				if (loadWebglAddonRef.current && terminalRef.current) {
					loadWebglAddonRef.current(terminalRef.current, true);
				}
			} catch (error) {
				console.warn("WebGL context recovery failed:", error);
			}
		}

		// Re-fit terminal to current dimensions
		try {
			fitAddonRef.current?.fit();
		} catch (error) {
			console.warn("Terminal fit failed during recovery:", error);
		}

		// Sync PTY dimensions
		const terminal = terminalRef.current;
		const ptyId = ptyIdRef.current;
		if (terminal && ptyId) {
			terminalApi.resize(ptyId, terminal.cols, terminal.rows).catch(() => {
				// Ignore resize errors - terminal may have been killed
			});
		}
	}, []);

	// Recovery handler for visibility change (app regains focus after idle)
	useEffect(() => {
		// Track timeout to prevent firing after unmount
		let recoveryTimeoutId: ReturnType<typeof setTimeout> | null = null;

		const handleVisibilityChange = (): void => {
			if (document.visibilityState === "visible") {
				// Clear any pending timeout before scheduling new one
				if (recoveryTimeoutId) {
					clearTimeout(recoveryTimeoutId);
				}
				recoveryTimeoutId = setTimeout(() => {
					recoveryTimeoutId = null;
					performTerminalRecovery();
				}, VISIBILITY_RECOVERY_DELAY_MS);
			}
		};

		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			if (recoveryTimeoutId) {
				clearTimeout(recoveryTimeoutId);
			}
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [performTerminalRecovery]);

	// Recovery handler for power resume (wake from sleep, screen unlock)
	useEffect(() => {
		// Track timeout to prevent firing after unmount
		let recoveryTimeoutId: ReturnType<typeof setTimeout> | null = null;

		const cleanup = systemApi.onPowerResume(() => {
			// Clear any pending timeout before scheduling new one
			if (recoveryTimeoutId) {
				clearTimeout(recoveryTimeoutId);
			}
			recoveryTimeoutId = setTimeout(() => {
				recoveryTimeoutId = null;
				performTerminalRecovery();
			}, POWER_RESUME_RECOVERY_DELAY_MS);
		});
		return () => {
			if (recoveryTimeoutId) {
				clearTimeout(recoveryTimeoutId);
			}
			cleanup();
		};
	}, [performTerminalRecovery]);

	// Handle Select All
	const handleSelectAll = useCallback((): void => {
		if (terminalRef.current) {
			terminalRef.current.selectAll();
		}
	}, []);

	// Focus terminal when container is clicked (important for split panes)
	const handleContainerClick = useCallback((): void => {
		terminalRef.current?.focus();
	}, []);

	// Memoized context menu handlers to prevent unnecessary re-renders
	const contextMenuHandlers = useMemo(
		() => ({
			copy: copySelection,
			paste: pasteFromClipboard,
			selectAll: handleSelectAll,
		}),
		[copySelection, pasteFromClipboard, handleSelectAll],
	);

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					ref={containerRef}
					className={`w-full h-full bg-[#1e1e1e] px-4 py-0.5 pb-1 ${className}`}
					onClick={handleContainerClick}
					onMouseDown={(e) => {
						// Prevent event from bubbling to window/parent handlers
						// that might steal focus back or interfere with UI
						e.stopPropagation();
						if (terminalRef.current) {
							terminalRef.current.focus();
						}
					}}
				/>
			</ContextMenuTrigger>
			<ContextMenuContent className="w-40">
				<ContextMenuItem
					onClick={contextMenuHandlers.copy}
					disabled={!hasSelection}
					className="cursor-pointer"
					aria-label="Copy selected text"
					aria-keyshortcuts="Ctrl+C"
				>
					Copy
					<span className="ml-auto text-xs text-muted-foreground">Ctrl+C</span>
				</ContextMenuItem>
				<ContextMenuItem
					onClick={contextMenuHandlers.paste}
					className="cursor-pointer"
					aria-label="Paste from clipboard"
					aria-keyshortcuts="Ctrl+V"
				>
					Paste
					<span className="ml-auto text-xs text-muted-foreground">Ctrl+V</span>
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem
					onClick={contextMenuHandlers.selectAll}
					className="cursor-pointer"
					aria-label="Select all text"
					aria-keyshortcuts="Ctrl+A"
				>
					Select All
					<span className="ml-auto text-xs text-muted-foreground">Ctrl+A</span>
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

export const ConnectedTerminal = memo(ConnectedTerminalComponent);
