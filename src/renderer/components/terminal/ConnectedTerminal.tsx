import {
	useEffect,
	useRef,
	memo,
	useCallback,
	useMemo,
	useImperativeHandle,
	useState,
} from "react";
import {
	RefreshCcw,
	AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { Terminal } from "@xterm/xterm";
import type { IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
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
import { WebLinksAddon } from "@xterm/addon-web-links";
import { takeCachedTerminal, cacheTerminal } from "./terminal-cache";
import {
	useTerminalFontFamily,
	useTerminalFontSize,
	useTerminalBufferSize,
	useTerminalRenderer,
} from "@/stores/app-settings-store";
import {
	useKeyboardShortcutsStore,
	matchesShortcut,
} from "@/stores/keyboard-shortcuts-store";
import { isMac, isPlatformModifier } from "@/lib/platform";
import { useTerminalStore } from "@/stores/terminal-store";
import { useShallow } from "zustand/shallow";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useTerminalClipboard } from "@/hooks/use-terminal-clipboard";
import { terminalApi, systemApi } from "@/lib/api";
import {
	buildTerminalPathLinks,
	openFilePathFromTerminal,
} from "@/lib/file-path-links";
import {
	buildTerminalUrlLinks,
	isSupportedTerminalUrl,
} from "@/lib/terminal-url-links";
import { openTerminalUrl } from "@/lib/browser/terminal-url-navigation";
import { addRendererRef, removeRendererRef } from "@/lib/tauri-terminal-api";
import { isTerminalPendingPtyAssignment } from "@/hooks/use-terminal-restore";
import {
	getOrCreateProjectContinuityCorrelation,
	recordTerminalContinuityEvent,
} from "@/lib/terminal-continuity-instrumentation";
import { useActiveProject } from "@/stores/project-store";

// Common readline/shell Ctrl sequences that should always pass through to the
// PTY regardless of platform. On macOS these are already protected by the
// isMac guard, but on Windows/Linux they would otherwise be swallowed when a
// matching app shortcut exists (e.g. commandPalette=ctrl+k, commandHistory=ctrl+r).
const READLINE_PASSTHROUGH_KEYS = new Set([
	"a", // Ctrl+A  move to beginning of line
	"e", // Ctrl+E  move to end of line
	"k", // Ctrl+K  kill to end of line
	"r", // Ctrl+R  reverse-i-search
	"f", // Ctrl+F  move forward one char
	"b", // Ctrl+B  move back one char
	"w", // Ctrl+W  delete previous word
	"u", // Ctrl+U  delete to beginning of line
	"p", // Ctrl+P  previous history entry
	"n", // Ctrl+N  next history entry
	"l", // Ctrl+L  clear screen
	"d", // Ctrl+D  EOF / delete char
]);

function isReadlinePassthrough(event: KeyboardEvent): boolean {
	return (
		event.ctrlKey &&
		!event.metaKey &&
		!event.shiftKey &&
		!event.altKey &&
		READLINE_PASSTHROUGH_KEYS.has(event.key.toLowerCase())
	);
}

function isAppOwnedTerminalShortcut(
	event: KeyboardEvent,
	shortcuts: ReturnType<typeof useKeyboardShortcutsStore.getState>["shortcuts"],
): boolean {
	if (!isMac && isReadlinePassthrough(event)) {
		return false;
	}

	for (const shortcut of Object.values(shortcuts)) {
		const activeKey = shortcut.customKey ?? shortcut.defaultKey;
		if (matchesShortcut(event, activeKey)) {
			return true;
		}
	}

	return false;
}

const MAX_WEBGL_RECOVERY_ATTEMPTS = 3;
const WEBGL_CONTEXT_LOSS_RECOVERY_DELAY_MS = 100;
const VISIBILITY_RECOVERY_DELAY_MS = 150;
const POWER_RESUME_RECOVERY_DELAY_MS = 300;
const ACTIVITY_DEBOUNCE_MS = 1000;
const CLIPBOARD_RATE_LIMIT_MS = 100;
const WRITE_BUFFER_FLUSH_MS = 16; // ~60fps - batch rapid writes into single render frame
const RESIZE_DEBOUNCE_OBSERVER_MS = 100; // debounce ResizeObserver to prevent rapid re-renders

const shouldUseWebglRenderer = (
	rendererPreference: "auto" | "webgl" | "dom",
): boolean => rendererPreference !== "dom";

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
	initialScrollback?: string[];
	searchRef?: React.Ref<TerminalSearchHandle>;
	isVisible?: boolean;
}

const PARTIAL_RESTORE_NOTE =
	"\x1b[33m\r\n[Restore mode: transcript replay. Alternate-screen or redraw-heavy output may be partial]\x1b[0m\r\n";

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
	// 1. STABLE ID DERIVATION
	const targetId = storeTerminalId || externalTerminalId;

	// 2. STORE HOOKS (Must be at the top)
	const { healthStatus, ptyId, restartTerminal, setTerminalHealthStatus } = useTerminalStore(
		useShallow((state) => {
			const term = state.terminals.find((t) => t.id === targetId);
			return {
				healthStatus: term?.healthStatus || "running",
				ptyId: term?.ptyId,
				restartTerminal: state.restartTerminal,
				setTerminalHealthStatus: state.setTerminalHealthStatus,
			};
		}),
	);

	const fontFamily = useTerminalFontFamily();
	const fontSize = useTerminalFontSize();
	const bufferSize = useTerminalBufferSize();
	const rendererPreference = useTerminalRenderer();
	const activeProject = useActiveProject();
	const shortcuts = useKeyboardShortcutsStore((state) => state.shortcuts);

	// 3. REFS
	const instanceIdRef = useRef<string>(`conn-${Math.random().toString(36).slice(2, 9)}`);
	const instanceId = instanceIdRef.current;
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const searchAddonRef = useRef<SearchAddon | null>(null);
	const webglAddonRef = useRef<WebglAddon | null>(null);
	const fileLinkProviderDisposableRef = useRef<IDisposable | null>(null);
	const webglRecoveryAttemptsRef = useRef<number>(0);
	const webglRecoveryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const loadWebglAddonRef = useRef<((term: Terminal, isRecovery?: boolean) => void) | null>(null);
	const webglContextLostRef = useRef<boolean>(false);
	const rendererPreferenceRef = useRef(rendererPreference);
	rendererPreferenceRef.current = rendererPreference;
	const activeProjectPathRef = useRef<string | undefined>(activeProject?.path);
	activeProjectPathRef.current = activeProject?.path;
	const shortcutsRef = useRef(shortcuts);
	shortcutsRef.current = shortcuts;
	const cleanupDataListenerRef = useRef<(() => void) | null>(null);
	const cleanupExitListenerRef = useRef<(() => void) | null>(null);
	const ptyIdRef = useRef<string | null>(null);
	const spawnInFlightRef = useRef(false);
	const didInitRef = useRef(false);
	const initializedTerminalIdRef = useRef<string | undefined>(undefined);
	const onExitRef = useRef(onExit);
	onExitRef.current = onExit;
	const onErrorRef = useRef(onError);
	onErrorRef.current = onError;
	const onSpawnedRef = useRef(onSpawned);
	onSpawnedRef.current = onSpawned;
	const onCommandRef = useRef(onCommand);
	onCommandRef.current = onCommand;
	const onBoundToStoreTerminalRef = useRef(onBoundToStoreTerminal);
	onBoundToStoreTerminalRef.current = onBoundToStoreTerminal;
	const spawnOptionsRef = useRef(spawnOptions);
	spawnOptionsRef.current = spawnOptions;
	const initialScrollbackRef = useRef(initialScrollback);
	initialScrollbackRef.current = initialScrollback;
	const currentLineRef = useRef<string>("");
	const continuityProjectIdRef = useRef<string | undefined>(getInstrumentationProjectId(spawnOptions));
	const needsResizeOnReadyRef = useRef<boolean>(false);
	const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastContainerWidthRef = useRef<number>(0);
	const lastContainerHeightRef = useRef<number>(0);
	const activityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastActivityUpdateRef = useRef<number>(0);
	const pendingActivityUpdateRef = useRef<{ id: string } | null>(null);
	const lastClipboardOpRef = useRef<number>(0);
	// Write buffer: batch rapid PTY data into single write per frame to prevent flicker
	const writeBufferRef = useRef<string>("");
	const writeBufferFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const writeBufferRafRef = useRef<number | null>(0);
	const pendingResizeRef = useRef<(() => void) | null>(null);

	// 4. STATE
	const [terminalInstance, setTerminalInstance] = useState<Terminal | null>(null);
	const [isSuspended, setIsSuspended] = useState(false);
	const isSuspendedRef = useRef(isSuspended);
	isSuspendedRef.current = isSuspended;
	const isOwnerRef = useRef(false); // tracks if this Tauri window currently owns the terminal

	// 5. CALLBACKS & EFFECTS
	const disposeWebglAddon = useCallback((): void => {
		if (webglRecoveryTimeoutRef.current) {
			clearTimeout(webglRecoveryTimeoutRef.current);
			webglRecoveryTimeoutRef.current = null;
		}
		if (webglAddonRef.current) {
			webglAddonRef.current.dispose();
			webglAddonRef.current = null;
		}
		webglContextLostRef.current = false;
	}, []);

	// Flush write buffer to terminal in a single call per frame
	const flushWriteBuffer = useCallback((): void => {
		const term = terminalRef.current;
		const buf = writeBufferRef.current;
		if (term && buf.length > 0) {
			writeBufferRef.current = "";
			if (writeBufferFlushRef.current) {
				clearTimeout(writeBufferFlushRef.current);
				writeBufferFlushRef.current = null;
			}
			if (writeBufferRafRef.current !== null) {
				cancelAnimationFrame(writeBufferRafRef.current);
				writeBufferRafRef.current = null;
			}
			term.write(buf);
		}
	}, []);

	// Buffer incoming PTY data to prevent flicker from rapid small writes
	const bufferWrite = useCallback((data: string): void => {
		writeBufferRef.current += data;
		// Schedule flush if not already scheduled
		if (writeBufferRafRef.current === null && writeBufferFlushRef.current === null) {
			writeBufferRafRef.current = requestAnimationFrame(() => {
				writeBufferRafRef.current = null;
				flushWriteBuffer();
			});
			// Safety fallback: force flush after max delay even if rAF doesn't fire
			writeBufferFlushRef.current = setTimeout(() => {
				writeBufferFlushRef.current = null;
				if (writeBufferRafRef.current !== null) {
					cancelAnimationFrame(writeBufferRafRef.current);
					writeBufferRafRef.current = null;
				}
				flushWriteBuffer();
			}, WRITE_BUFFER_FLUSH_MS);
		}
	}, [flushWriteBuffer]);

	const performFit = (force = false): boolean => {
		if (!fitAddonRef.current || !terminalRef.current || !containerRef.current) return false;
		const rect = containerRef.current.getBoundingClientRect();
		const width = Math.round(rect.width);
		const height = Math.round(rect.height);
		
		// CRITICAL FIX: Never attempt to fit if container is hidden (0 width/height).
		// Doing so causes xterm to calculate a 1-character wide column, 
		// breaking the layout completely when it becomes visible again.
		if (width <= 0 || height <= 0) {
			return false;
		}

		if (!force && width === lastContainerWidthRef.current && height === lastContainerHeightRef.current) {
			return false;
		}
		try {
			fitAddonRef.current.fit();
			if (width > 0 && height > 0) {
				lastContainerWidthRef.current = width;
				lastContainerHeightRef.current = height;
			}
			return true;
		} catch {
			return false;
		}
	};

	const { copySelection, pasteFromClipboard, hasSelection } = useTerminalClipboard({ terminal: terminalInstance });
	const copySelectionRef = useRef(copySelection);
	copySelectionRef.current = copySelection;
	const pasteFromClipboardRef = useRef(pasteFromClipboard);
	pasteFromClipboardRef.current = pasteFromClipboard;

	const handleResume = useCallback(async (): Promise<void> => {
		const ptyId = ptyIdRef.current || externalTerminalId;
		if (!ptyId) return;

		try {
			isOwnerRef.current = true; // claim before invoke so keypress guard is set
			const { invoke } = await import("@tauri-apps/api/core");
			await invoke("terminal_takeover", { terminalId: ptyId, clientType: "tauri" });
			
			setIsSuspended(false);
			
			requestAnimationFrame(() => {
				performFit(true);
				terminalRef.current?.focus();
				
				terminalRef.current?.clear();
				void terminalApi.write(ptyId, "\x0C");
			});
		} catch (err) {
			isOwnerRef.current = false;
			console.error("Resume takeover failed", err);
		}
	}, [externalTerminalId]);

	useEffect(() => { if (externalTerminalId) ptyIdRef.current = externalTerminalId; }, [externalTerminalId]);

	useEffect(() => { if (continuityProjectIdRef.current) continuityProjectIdRef.current = getInstrumentationProjectId(spawnOptionsRef.current); }, [spawnOptions]);

	useEffect(() => {
		if (!externalTerminalId || isTerminalPendingPtyAssignment(externalTerminalId)) return;
		useTerminalStore.getState().setRendererAttached(externalTerminalId, true);
		return () => { useTerminalStore.getState().setRendererAttached(externalTerminalId, false); };
	}, [externalTerminalId]);

	const instrumentationProjectId = getInstrumentationProjectId(spawnOptions);

	useEffect(() => {
		if (instrumentationProjectId) {
			continuityProjectIdRef.current = instrumentationProjectId;
		}
	}, [instrumentationProjectId]);

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
			if (isSuspendedRef.current) return;
			const ptyId = ptyIdRef.current;
			if (!ptyId) return;

			// Auto-claim ownership on first keystroke — locks web side immediately
			if (!isOwnerRef.current) {
				isOwnerRef.current = true;
				void (async () => {
					try {
						const { invoke } = await import("@tauri-apps/api/core");
						await invoke("terminal_takeover", { terminalId: ptyId, clientType: "tauri" });
					} catch (e) {
						console.error("Auto-takeover failed:", e);
					}
				})();
			}

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
				if (!result.success && onErrorRef.current) {
					onErrorRef.current(result.error);
				}
			} catch (err) {
				if (onErrorRef.current) {
					onErrorRef.current(err instanceof Error ? err.message : "Write failed");
				}
			}
		},
		[],
	);

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

		// Check for a cached terminal preserved across project switches.
		// If found, reuse it (preserves scrollback, alt buffer, cursor, etc.)
		// and skip both terminal.open() and transcript replay.
		const cacheKey = externalTerminalId || undefined;
		const cachedTerminal = cacheKey ? takeCachedTerminal(cacheKey) : undefined;

		let terminal: Terminal;
		if (cachedTerminal) {
			devLog(`[ConnectedTerminal] RESTORED cached terminal`, {
				cacheKey,
			});
			terminal = cachedTerminal;
		} else {
			terminal = new Terminal(terminalOptions);
		}
		terminalRef.current = terminal;
		setTerminalInstance(terminal);

		const fitAddon = new FitAddon();
		fitAddonRef.current = fitAddon;
		terminal.loadAddon(fitAddon);

		const handleFilePathActivate = async (
			event: MouseEvent,
			uri: string,
		): Promise<void> => {
			if (!event.ctrlKey && !event.metaKey) {
				return;
			}

			event.preventDefault();

			try {
				const result = await openFilePathFromTerminal(uri, {
					cwd:
						useTerminalStore.getState().findTerminalByPtyId(ptyIdRef.current || "")
							?.cwd,
					projectRoot: activeProjectPathRef.current,
				});

				if (!result.ok) {
					toast.error(result.message);
				}
			} catch (error) {
				console.error("[Terminal File Link Open Failed]", error);
				toast.error("Failed to open file from terminal output.");
			}
		};

		const handleUrlActivate = async (
			event: MouseEvent,
			url: string,
		): Promise<void> => {
			if (!event.ctrlKey && !event.metaKey) {
				return;
			}

			event.preventDefault();

			if (!isSupportedTerminalUrl(url)) {
				toast.error("Only http/https URLs are supported from terminal output.");
				return;
			}

			try {
				await openTerminalUrl(url);
			} catch (error) {
				console.error("[Terminal URL Link Open Failed]", error);
				toast.error("Failed to open URL from terminal output.");
			}
		};

		fileLinkProviderDisposableRef.current = terminal.registerLinkProvider({
			provideLinks(y, callback) {
				const line = terminal.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
				const pathLinks = buildTerminalPathLinks(line, y, handleFilePathActivate);
				const urlLinks = buildTerminalUrlLinks(line, y, handleUrlActivate);
				callback([...urlLinks, ...pathLinks]);
			},
		});

		// Load search addon
		const searchAddon = new SearchAddon();
		searchAddonRef.current = searchAddon;
		terminal.loadAddon(searchAddon);

		if (cachedTerminal) {
			// Reattach the preserved xterm element to the new container.
			// This avoids losing scrollback, alt-buffer, and cursor state.
			if (containerRef.current && terminal.element) {
				containerRef.current.appendChild(terminal.element);
			}
			// Force a full refresh so the renderer repaints after DOM reattachment.
			terminal.refresh(0, terminal.rows - 1);
		} else {
			terminal.open(containerRef.current);
		}

		// Intercept keyboard shortcuts before xterm processes them
		// Return false to prevent xterm from handling, true to let xterm handle
		terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
			if (event.type !== "keydown") return true;

			const shortcuts = shortcutsRef.current;

			// Check if this key matches any app shortcut
			// On macOS: Ctrl+key shortcuts should pass through to the shell (not intercepted by app)
			// Only ⌘+key shortcuts are intercepted by the app on macOS
			if (isAppOwnedTerminalShortcut(event, shortcuts)) {
				// On macOS inside a terminal, don't intercept ctrl+... shortcuts from the app config.
				// These are ctrl-key combos that should go to the shell (e.g., ctrl+r = reverse-i-search).
				// The ⌘ equivalent is handled by the clipboardModifier block above.
				if (isMac && event.ctrlKey && !event.metaKey) {
					// Passthrough: let xterm send the raw ctrl sequence to the shell
					return true;
				}

				// Don't call stopPropagation() - let event bubble to window handler
				// Return false to prevent xterm from handling the event
				return false;
			}

			// Handle copy/paste/select all keyboard shortcuts
			// macOS convention: ⌘+C/V/A for clipboard operations, Ctrl+C = SIGINT
			// Windows/Linux convention: Ctrl+C/V/A for everything
			const clipboardModifier = isPlatformModifier(event);

			if (clipboardModifier) {
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
			if (!shouldUseWebglRenderer(rendererPreferenceRef.current)) {
				webglAddonRef.current = null;
				return;
			}
			if (webglAddonRef.current) {
				return;
			}
			if (webglRecoveryAttemptsRef.current >= MAX_WEBGL_RECOVERY_ATTEMPTS) {
				console.warn(
					"WebGL recovery attempts exhausted, falling back to DOM renderer",
				);
				recordTerminalContinuityEvent({
					name: "renderer-recovery-exhausted",
					ptyId: ptyIdRef.current ?? undefined,
					details: {
						attempts: webglRecoveryAttemptsRef.current,
						maxAttempts: MAX_WEBGL_RECOVERY_ATTEMPTS,
						isRecovery,
					},
				});
				return;
			}
			try {
				recordTerminalContinuityEvent({
					name: "renderer-recovery-attempted",
					ptyId: ptyIdRef.current ?? undefined,
					details: {
						attempt: webglRecoveryAttemptsRef.current + 1,
						maxAttempts: MAX_WEBGL_RECOVERY_ATTEMPTS,
						isRecovery,
						renderer: "webgl",
					},
				});
				const webglAddon = new WebglAddon();
				webglAddon.onContextLoss(() => {
					webglAddon.dispose();
					webglAddonRef.current = null;
					// Mark context as lost for recovery decisions
					webglContextLostRef.current = true;
					if (!shouldUseWebglRenderer(rendererPreferenceRef.current)) {
						webglContextLostRef.current = false;
						return;
					}
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
				if (!isRecovery) {
					webglRecoveryAttemptsRef.current = 0;
				}
				recordTerminalContinuityEvent({
					name: "renderer-recovery-succeeded",
					ptyId: ptyIdRef.current ?? undefined,
					details: {
						attempt: webglRecoveryAttemptsRef.current + 1,
						isRecovery,
						renderer: "webgl",
					},
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.warn(
					"WebGL addon failed to load, falling back to DOM renderer:",
					error,
				);
				webglAddonRef.current = null;
				webglRecoveryAttemptsRef.current++;
				recordTerminalContinuityEvent({
					name: "renderer-recovery-failed",
					ptyId: ptyIdRef.current ?? undefined,
					details: {
						error: message,
						attempt: webglRecoveryAttemptsRef.current,
						isRecovery,
						renderer: "webgl",
					},
				});
			}
		};

		if (shouldUseWebglRenderer(rendererPreferenceRef.current)) {
			loadWebglAddon(terminal);
		}
		// Store reference for recovery handlers to use
		loadWebglAddonRef.current = loadWebglAddon;

		// Defer initial fit to next animation frame so the WebGL renderer has time
		// to fully initialize its internal _renderer.value before we call dimensions.
		// Calling fit() synchronously after loadWebglAddon() causes an uncaught
		// "Cannot read properties of undefined (reading 'dimensions')" from xterm.
		requestAnimationFrame(() => {
			performFit(true);
		});

		if (autoFocus) {
			terminal.focus();
		}

		// Set up resize observer
		const resizeObserver = new ResizeObserver(() => {
			requestAnimationFrame(() => {
				performFit();
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
			performFit(true);
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
							performFit(true);
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
								if (transcriptLooksPartial) {
									if (!transcript.startsWith("\u001b[?1049h")) {
										terminal.write("\u001b[?1049h");
									}
									terminal.write(transcript);
									terminal.write(PARTIAL_RESTORE_NOTE);
								} else {
									terminal.write(transcript);
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
				// Set ptyIdRef so that resize/recovery operations (performFit, terminalApi.resize)
				// work for external terminals just like spawned ones. Without this, the TUI app
				// never receives SIGWINCH on project-switch restore and can't redraw.
				ptyIdRef.current = externalTerminalId;
				// Renderer-attached tracking is handled by the externalTerminalId effect
				// above (with proper lifecycle cleanup). The effect also calls
				// setRendererAttached, so we avoid duplicating it here. The backend ref
				// (addRendererRef) is still registered here since it is async and not
				// managed by the effect's lifecycle.
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
					if (cachedTerminal) {
						// Cached terminal already has full state — skip transcript/scrollback replay.
						// Still consume the transcript to prevent unbounded growth.
						if (transcript) {
							terminalStoreState.consumeTranscript(externalTerminalId);
						}
						recordReplayEvent(
							"restore-replay-skipped",
							{
								reason: "cached-terminal",
								source: "external-terminal",
							},
							storeTerminalId,
							externalTerminalId,
						);
					} else if (transcript) {
						if (transcriptLooksPartial) {
							if (!transcript.startsWith("\u001b[?1049h")) {
								terminal.write("\u001b[?1049h");
							}
							terminal.write(transcript);
							terminal.write(PARTIAL_RESTORE_NOTE);
						} else {
							terminal.write(transcript);
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
				useTerminalStore.getState().setRendererAttached(terminalId, false);
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
			// Cursor cleanup: Disable cursor blink before WebGL disposal to prevent ghost cursors
			if (terminalRef.current) {
				terminalRef.current.options.cursorBlink = false;
			}

			// Dispose WebGL addon BEFORE terminal disposal for proper cursor layer cleanup
			disposeWebglAddon();
			if (fileLinkProviderDisposableRef.current) {
				fileLinkProviderDisposableRef.current.dispose();
				fileLinkProviderDisposableRef.current = null;
			}

			// Cache the terminal for reuse on project-switch-back instead of
			// disposing it. This preserves all xterm internal state (scrollback,
			// alt buffer, cursor position). Only cache if the terminal is still
			// alive in the store (not closed/exited) — otherwise dispose.
			const cacheKey = terminalId;
			const terminalStillInStore = cacheKey &&
				useTerminalStore.getState().findTerminalByPtyId(cacheKey);
			if (terminalStillInStore) {
				cacheTerminal(cacheKey, terminal);
			} else {
				terminal.dispose();
			}
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
			performFit(true);
		}
	}, [fontFamily, fontSize]);

	useEffect(() => {
		if (!shouldUseWebglRenderer(rendererPreference)) {
			disposeWebglAddon();
			webglRecoveryAttemptsRef.current = 0;
			return;
		}

		if (
			terminalRef.current &&
			loadWebglAddonRef.current &&
			!webglAddonRef.current
		) {
			webglRecoveryAttemptsRef.current = 0;
			loadWebglAddonRef.current(terminalRef.current);
		}
	}, [disposeWebglAddon, rendererPreference]);

	// Trigger fit + PTY resize when terminal becomes visible
	// Uses double requestAnimationFrame for proper timing after pane transitions
	const runVisibilityRestore = useCallback((): void => {
		if (!fitAddonRef.current || !terminalRef.current) return;
		// Double RAF ensures DOM is fully rendered after pane transition
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				performFit();

				const terminal = terminalRef.current;
				if (!terminal) return;

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

				const ptyId = ptyIdRef.current;
				if (ptyId) {
					const resizePromise = terminalApi.resize(ptyId, terminal.cols, terminal.rows);
					if (resizePromise && typeof resizePromise.catch === "function") {
						resizePromise.catch(() => {});
					}
					restoreScrollPosition(ptyId, terminal);
				} else {
					needsResizeOnReadyRef.current = true;
				}
			});
		});
	}, []);

	useEffect(() => {
		if (isVisible) {
			runVisibilityRestore();
		}
	}, [isVisible, runVisibilityRestore]);

	useEffect(() => {
		const handleRestorePulse = (): void => {
			if (isVisible) {
				runVisibilityRestore();
			}
		};
		window.addEventListener("termul:terminal-restore-visibility-pulse", handleRestorePulse as EventListener);
		return () => {
			window.removeEventListener("termul:terminal-restore-visibility-pulse", handleRestorePulse as EventListener);
		};
	}, [isVisible, runVisibilityRestore]);

	// Shared terminal recovery logic - re-fit and check WebGL health
	const performTerminalRecovery = useCallback((): void => {
		if (!fitAddonRef.current || !terminalRef.current) return;

		// Only recreate WebGL addon if context was actually lost, the current preference still
		// allows WebGL, and we're not already recovering.
		if (
			shouldUseWebglRenderer(rendererPreferenceRef.current) &&
			webglContextLostRef.current &&
			!webglAddonRef.current
		) {
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
		performFit(true);
	}, []);

	const handleResize = useCallback(async (cols: number, rows: number): Promise<void> => {
		if (isSuspendedRef.current) return;
		const ptyId = ptyIdRef.current;
		if (!ptyId) return;
		if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
		resizeTimeoutRef.current = setTimeout(async () => {
			const currentPtyId = ptyIdRef.current;
			if (!currentPtyId) return;
			try {
				await terminalApi.resize(currentPtyId, cols, rows);
			} catch (error) {
				if (import.meta.env.DEV) console.error("Failed to resize terminal", error);
			}
		}, RESIZE_DEBOUNCE_MS);
	}, []);

	const handleContainerClick = useCallback((): void => {
		if (isSuspendedRef.current) {
			void handleResume();
		} else {
			terminalRef.current?.focus();
		}
	}, [handleResume]);

	const handleSelectAll = useCallback((): void => {
		terminalRef.current?.selectAll();
	}, []);

	useImperativeHandle(searchRef, () => {
		const searchDecorations = {
			matchBackground: "#444444",
			activeMatchBackground: "#FFFF00",
			matchOverviewRuler: "#444444",
			activeMatchColorOverviewRuler: "#FFFF00",
		};

		return {
			findNext: (term: string) => searchAddonRef.current?.findNext(term, { decorations: searchDecorations }) ?? false,
			findPrevious: (term: string) => searchAddonRef.current?.findPrevious(term, { decorations: searchDecorations }) ?? false,
			clearDecorations: () => searchAddonRef.current?.clearDecorations(),
			writeText: (text: string) => { if (ptyIdRef.current) terminalApi.write(ptyIdRef.current, text); }
		};
	}, []);

	const shouldDebugLog = import.meta.env.DEV;
	const devLog = (...args: unknown[]): void => { if (shouldDebugLog) console.log(...args); };

	useEffect(() => {
		const debugId = `${instanceId}-${Date.now().toString().slice(-6)}`;
		if (!containerRef.current || !targetId) return;
		if (didInitRef.current) return;
		didInitRef.current = true;
		initializedTerminalIdRef.current = targetId;
		const terminalOptions = { ...getTerminalOptions(navigator.platform), fontFamily, fontSize, scrollback: bufferSize };
		const terminal = new Terminal(terminalOptions);
		terminalRef.current = terminal;
		setTerminalInstance(terminal);
		const fitAddon = new FitAddon();
		fitAddonRef.current = fitAddon;
		terminal.loadAddon(fitAddon);
		terminal.loadAddon(new WebLinksAddon());
		const searchAddon = new SearchAddon();
		searchAddonRef.current = searchAddon;
		terminal.loadAddon(searchAddon);
		terminal.open(containerRef.current);
		terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
			if (event.type !== "keydown") return true;
			if (isAppOwnedTerminalShortcut(event, shortcutsRef.current)) return isMac && event.ctrlKey && !event.metaKey;
			if (isPlatformModifier(event)) {
				const now = Date.now();
				if (now - lastClipboardOpRef.current < CLIPBOARD_RATE_LIMIT_MS) return false;
				switch (event.key.toLowerCase()) {
					case "c": if (terminal.hasSelection()) { event.preventDefault(); lastClipboardOpRef.current = now; void copySelectionRef.current(); return false; } return true;
					case "v": event.preventDefault(); lastClipboardOpRef.current = now; void pasteFromClipboardRef.current(); return false;
					case "a": terminal.selectAll(); return false;
				}
			}
			return true;
		});
		const loadWebglAddon = (term: Terminal, isRecovery: boolean = false): void => {
			if (!shouldUseWebglRenderer(rendererPreferenceRef.current) || webglAddonRef.current || webglRecoveryAttemptsRef.current >= MAX_WEBGL_RECOVERY_ATTEMPTS) return;
			try {
				const webglAddon = new WebglAddon();
				webglAddon.onContextLoss(() => {
					webglAddon.dispose(); webglAddonRef.current = null; webglContextLostRef.current = true;
					webglRecoveryAttemptsRef.current++;
					if (webglRecoveryTimeoutRef.current) clearTimeout(webglRecoveryTimeoutRef.current);
					webglRecoveryTimeoutRef.current = setTimeout(() => { webglRecoveryTimeoutRef.current = null; loadWebglAddon(term, true); }, WEBGL_CONTEXT_LOSS_RECOVERY_DELAY_MS);
				});
				term.loadAddon(webglAddon);
				webglAddonRef.current = webglAddon;
				webglContextLostRef.current = false;
			} catch { webglRecoveryAttemptsRef.current++; }
		};
		if (shouldUseWebglRenderer(rendererPreferenceRef.current)) loadWebglAddon(terminal);
		loadWebglAddonRef.current = loadWebglAddon;
		// Only fit/focus when visible — prevents layout flash on hidden tabs
		if (isVisible) {
			requestAnimationFrame(() => performFit(true));
			if (autoFocus) terminal.focus();
		} else {
			needsResizeOnReadyRef.current = true;
		}
		const resizeObserver = new ResizeObserver(() => {
			if (isVisible && pendingResizeRef.current === null) {
				pendingResizeRef.current = () => {
					pendingResizeRef.current = null;
					performFit();
				};
				requestAnimationFrame(pendingResizeRef.current as () => void);
			} else if (!isVisible) {
				needsResizeOnReadyRef.current = true;
			}
		});
		resizeObserver.observe(containerRef.current);
		const dataDisposable = terminal.onData(handleTerminalData);
		const resizeDisposable = terminal.onResize(({ cols, rows }) => handleResize(cols, rows));
		cleanupDataListenerRef.current = terminalApi.onData((id: string, data: string) => {
			if (id === ptyIdRef.current && terminalRef.current) {
				bufferWrite(data);
				const now = Date.now();
				const terminalRecord = useTerminalStore.getState().findTerminalByPtyId(id);
				if (terminalRecord) {
					if (now - lastActivityUpdateRef.current >= ACTIVITY_DEBOUNCE_MS) {
						useTerminalStore.getState().updateTerminalActivityBatch(terminalRecord.id, true, now);
						lastActivityUpdateRef.current = now;
					} else { pendingActivityUpdateRef.current = { id: terminalRecord.id }; }
					if (activityTimeoutRef.current) clearTimeout(activityTimeoutRef.current);
					const termId = terminalRecord.id;
					activityTimeoutRef.current = setTimeout(() => {
						if (pendingActivityUpdateRef.current) {
							useTerminalStore.getState().updateTerminalActivityBatch(pendingActivityUpdateRef.current.id, false, Date.now());
							pendingActivityUpdateRef.current = null;
						} else { useTerminalStore.getState().updateTerminalActivityBatch(termId, false, Date.now()); }
						activityTimeoutRef.current = null; lastActivityUpdateRef.current = 0;
					}, 2000);
				}
			}
		});
		cleanupExitListenerRef.current = terminalApi.onExit((pId: string, exitCode: number, signal?: number) => {
			if (pId === ptyIdRef.current) {
				if (targetId) useTerminalStore.getState().setTerminalHealthStatus(targetId, "disconnected");
				if (onExitRef.current) onExitRef.current(exitCode, signal);
			}
		});
		let unlistenFn: (() => void) | null = null;
		const unsubPromise = (async () => {
			try {
				const { listen } = await import("@tauri-apps/api/event");
				return await listen<{ terminalId: string; clientType: string }>(
					"terminal-takeover",
					(event) => {
						const currentId = ptyIdRef.current || externalTerminalId;
						if (currentId && event.payload.terminalId === currentId) {
							if (event.payload.clientType === "web") {
								// Web typed first — lock this Tauri window
								isOwnerRef.current = false;
								setIsSuspended(true);
							} else if (event.payload.clientType === "tauri") {
								// Tauri reclaimed — this fires from our own claim too, so just ensure correct state
								isOwnerRef.current = true;
								setIsSuspended(false);
							}
						}
					}
				);
			} catch (err) {
				console.error("Failed to setup takeover listener", err);
				return null;
			}
		})();
		
		unsubPromise.then((unsub) => {
			if (unsub) unlistenFn = unsub;
		});

		const spawnTerminal = async (): Promise<void> => {
			performFit(true);
			if (!externalTerminalId) {
				if (!autoSpawn || spawnInFlightRef.current || ptyIdRef.current) return;
				spawnInFlightRef.current = true;
				try {
					const currentSpawnOptions = spawnOptionsRef.current;
					const result = await terminalApi.spawn({ ...currentSpawnOptions, shell: currentSpawnOptions?.shell || undefined, cols: terminal.cols || 80, rows: terminal.rows || 24 });
					if (result.success) {
						ptyIdRef.current = result.data.id;
						useTerminalStore.getState().setRendererAttached(result.data.id, true);
						void addRendererRef(result.data.id, instanceIdRef.current);
						registerTerminal(result.data.id, terminal);
						
						const transcript = useTerminalStore.getState().peekTranscript(result.data.id);
						if (transcript) { terminal.write(transcript); useTerminalStore.getState().consumeTranscript(result.data.id); }
						else if (initialScrollbackRef.current?.length) restoreScrollback(terminal, initialScrollbackRef.current);
						if (onSpawnedRef.current) onSpawnedRef.current(result.data.id);
						if (onBoundToStoreTerminalRef.current) onBoundToStoreTerminalRef.current(result.data.id);
					} else if (onErrorRef.current) onErrorRef.current(result.error);
				} catch (err) { if (onErrorRef.current) onErrorRef.current(err instanceof Error ? err.message : "Spawn failed"); } finally { spawnInFlightRef.current = false; }
			} else {
				void addRendererRef(externalTerminalId, instanceIdRef.current);
				registerTerminal(externalTerminalId, terminal);
				
				const transcript = useTerminalStore.getState().peekTranscript(externalTerminalId);
				if (transcript) { terminal.write(transcript); useTerminalStore.getState().consumeTranscript(externalTerminalId); }
				else if (initialScrollbackRef.current?.length) restoreScrollback(terminal, initialScrollbackRef.current);
				if (onBoundToStoreTerminalRef.current) onBoundToStoreTerminalRef.current(externalTerminalId);
			}
		};
		spawnTerminal();
		return () => {
			if (unlistenFn) unlistenFn();
			else unsubPromise.then((unsub) => unsub?.());

			const tId = ptyIdRef.current || externalTerminalId;
			if (tId && terminalRef.current) { captureScrollPosition(tId); if (!externalTerminalId) useTerminalStore.getState().setRendererAttached(tId, false); void removeRendererRef(tId, instanceId); }
			if (ptyIdRef.current) unregisterTerminal(ptyIdRef.current);
			else if (externalTerminalId) unregisterTerminal(externalTerminalId);
			resizeObserver.disconnect(); dataDisposable.dispose(); resizeDisposable.dispose();
			if (cleanupDataListenerRef.current) cleanupDataListenerRef.current();
			if (cleanupExitListenerRef.current) cleanupExitListenerRef.current();
			if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
			if (activityTimeoutRef.current) clearTimeout(activityTimeoutRef.current);
			// Flush any pending write buffer before disposal
			if (writeBufferFlushRef.current) { clearTimeout(writeBufferFlushRef.current); writeBufferFlushRef.current = null; }
			if (writeBufferRafRef.current !== null) { cancelAnimationFrame(writeBufferRafRef.current); writeBufferRafRef.current = null; }
			writeBufferRef.current = "";
			disposeWebglAddon(); terminal.dispose(); terminalRef.current = null; setTerminalInstance(null);
			didInitRef.current = false; initializedTerminalIdRef.current = undefined;
		};
	}, [targetId, ptyId, autoSpawn, rendererPreference, memoizedSpawnOptions, fontFamily, fontSize, bufferSize, instanceId, externalTerminalId, autoFocus, initialScrollback, handleTerminalData, handleResize, copySelection, pasteFromClipboard, setTerminalHealthStatus, disposeWebglAddon, onError, onSpawned, bufferWrite, isVisible]);

	const isVisibleRef = useRef(isVisible);
	isVisibleRef.current = isVisible;

	// When tab becomes visible, perform deferred fit and focus
	// Track isVisible via ref to avoid stale closure in rAF callback
	const onVisible = useRef<(() => void) | null>(null);
	onVisible.current = () => {
		if (needsResizeOnReadyRef.current && terminalRef.current) {
			needsResizeOnReadyRef.current = false;
			requestAnimationFrame(() => {
				performFit(true);
				if (autoFocus) terminalRef.current?.focus();
			});
		}
	};
	useEffect(() => {
		if (isVisible) onVisible.current?.();
	}, [isVisible, autoFocus]);

	const isCrashed = healthStatus === "disconnected" || healthStatus === "crashed";

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div className="relative w-full h-full group overflow-hidden">
					<div ref={containerRef} className={`w-full h-full bg-[#1e1e1e] px-4 py-0.5 pb-1 ${className}`} onClick={handleContainerClick} onMouseDown={(e) => { e.stopPropagation(); terminalRef.current?.focus(); }} />
					{isSuspended && (
						<div className="absolute inset-0 bg-[#0c0c0ced]/90 backdrop-blur-md flex items-center justify-center z-50 p-4 md:p-8 animate-in fade-in zoom-in-95 duration-300 text-foreground">
							<div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-6 bg-card/95 border border-border/50 p-8 rounded-2xl shadow-2xl max-w-2xl w-full border-t-4 border-t-blue-500">
								<div className="flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-border/50 pb-6 md:pb-0 md:pr-6">
									<div className="w-20 h-20 rounded-2xl bg-blue-500/10 flex items-center justify-center mb-3 shadow-inner">
										<AlertTriangle className="text-blue-500 animate-pulse" size={40} />
									</div>
									<span className="text-[10px] uppercase tracking-[0.2em] font-black text-blue-500 text-center">SUSPENDED</span>
								</div>
								<div className="flex flex-col justify-center text-center md:text-left">
									<div className="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wider opacity-70">Terminal Shared Session</div>
									<h3 className="text-2xl md:text-3xl font-bold tracking-tighter mb-3">Session Suspended</h3>
									<p className="text-muted-foreground leading-relaxed text-sm md:text-base mb-8">This terminal is active in the <strong>Web Browser</strong> client. Take over to restore rendering in this window.</p>
									<div className="flex flex-col sm:flex-row items-center gap-4">
										<button onClick={(e) => { e.stopPropagation(); void handleResume(); }} className="w-full sm:w-auto inline-flex items-center justify-center gap-3 px-8 py-3.5 bg-blue-600 text-white rounded-xl hover:bg-blue-500 hover:shadow-xl hover:shadow-blue-500/20 active:scale-95 transition-all font-bold shadow-md">
											<RefreshCcw size={20} /> Take Over Session
										</button>
									</div>
								</div>
							</div>
						</div>
					)}
					{isCrashed && (
						<div className="absolute inset-0 bg-background/40 backdrop-blur-md flex items-center justify-center z-50 p-4 md:p-8 animate-in fade-in zoom-in-95 duration-300 text-foreground">
							<div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-6 bg-card/95 border border-border/50 p-8 rounded-2xl shadow-2xl max-w-2xl w-full border-t-4 border-t-destructive">
								<div className="flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-border/50 pb-6 md:pb-0 md:pr-6">
									<div className="w-20 h-20 rounded-2xl bg-destructive/10 flex items-center justify-center mb-3 shadow-inner group-hover:scale-110 transition-transform duration-500">
										<AlertTriangle className="text-destructive" size={40} />
									</div>
									<span className="text-[10px] uppercase tracking-[0.2em] font-black text-destructive/80 text-center">CRITICAL ERROR</span>
								</div>
								<div className="flex flex-col justify-center text-center md:text-left">
									<div className="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wider opacity-70">Terminal Pane Exception</div>
									<h3 className="text-2xl md:text-3xl font-bold tracking-tighter mb-3">Session Interrupted</h3>
									<p className="text-muted-foreground leading-relaxed text-sm md:text-base mb-8">The terminal process exited unexpectedly. This usually happens if the shell crashes or the PTY is killed by the OS.</p>
									<div className="flex flex-col sm:flex-row items-center gap-4">
										<button onClick={(e) => { e.stopPropagation(); if (targetId) restartTerminal(targetId); }} className="w-full sm:w-auto inline-flex items-center justify-center gap-3 px-8 py-3.5 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 hover:shadow-xl hover:shadow-primary/20 active:scale-95 transition-all font-bold shadow-md">
											<RefreshCcw size={20} /> Reconnect Session
										</button>
										<div className="hidden sm:block h-8 w-px bg-border/50 mx-2" />
										<div className="text-[10px] text-muted-foreground/60 font-mono">REF::{targetId?.slice(0, 8)}</div>
									</div>
								</div>
							</div>
						</div>
					)}
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent className="w-40">
				<ContextMenuItem onClick={copySelection} disabled={!hasSelection} className="cursor-pointer">Copy <span className="ml-auto text-xs text-muted-foreground">Ctrl+C</span></ContextMenuItem>
				<ContextMenuItem onClick={pasteFromClipboard} className="cursor-pointer">Paste <span className="ml-auto text-xs text-muted-foreground">Ctrl+V</span></ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem onClick={handleSelectAll} className="cursor-pointer">Select All <span className="ml-auto text-xs text-muted-foreground">Ctrl+A</span></ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem onClick={() => { if (targetId) restartTerminal(targetId); }} className="cursor-pointer text-primary focus:text-primary"><RefreshCcw size={14} className="mr-2" /> Restart Terminal</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

export const ConnectedTerminal = memo(ConnectedTerminalComponent);
