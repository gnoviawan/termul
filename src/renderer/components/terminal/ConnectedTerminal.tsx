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
import { getTerminalOptions } from "./terminal-config";
import { useTerminalResizeV2 } from "@/hooks/use-terminal-resize-v2";
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
	// 1. App shortcuts take priority over readline passthrough.
	// This ensures commandPalette, commandHistory, etc. work from terminal
	// focus even though their Ctrl+key also matches a readline binding.
	for (const shortcut of Object.values(shortcuts)) {
		const activeKey = shortcut.customKey ?? shortcut.defaultKey;
		if (matchesShortcut(event, activeKey)) {
			return true;
		}
	}

	// 2. No app shortcut matched — check readline passthrough.
	// Ctrl+letter readline bindings must reach the PTY on every platform.
	// On macOS the isMac guard in matchesShortcut already prevents Ctrl+key
	// from matching app shortcuts, so the readline behavior is preserved.
	if (isReadlinePassthrough(event)) {
		return false;
	}

	return false;
}

const MAX_WEBGL_RECOVERY_ATTEMPTS = 3;
const WEBGL_CONTEXT_LOSS_RECOVERY_DELAY_MS = 100;
const VISIBILITY_RECOVERY_DELAY_MS = 150;
const POWER_RESUME_RECOVERY_DELAY_MS = 300;
const ACTIVITY_DEBOUNCE_MS = 1000;
const CLIPBOARD_RATE_LIMIT_MS = 100;

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
	// Single-flight guard for performTerminalRecovery. On a window restore both
	// the visibilitychange and focus handlers (and sometimes power-resume) can
	// fire close together; without this guard each would start its own
	// layout-wait RAF loop and overlapping fit + visibility-flip cycles.
	const recoveryInProgressRef = useRef<boolean>(false);
	// Track visibility prop for recovery path guards (tab-active, not window-visible).
	// Ref avoids stale closures in event listeners referencing isVisible directly.
	const isVisibleRef = useRef(isVisible);
	isVisibleRef.current = isVisible;
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
	// Track last fitted container dimensions to avoid redundant fit() calls
	const lastContainerWidthRef = useRef<number>(0);
	const lastContainerHeightRef = useRef<number>(0);
	const activityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastActivityUpdateRef = useRef<number>(0);
	const pendingActivityUpdateRef = useRef<{ id: string } | null>(null);
	const lastClipboardOpRef = useRef<number>(0);

	// Two-stage resize pipeline: 8ms fit debounce + 256ms PTY resize debounce
	const handlePtyResize = useCallback(
		async (cols: number, rows: number): Promise<void> => {
			const ptyId = ptyIdRef.current;
			if (!ptyId) return;
			try {
				await terminalApi.resize(ptyId, cols, rows);
			} catch {
				// Ignore resize errors during rapid resize
			}
		},
		[],
	);

	const { forceFit: forceResizeFit } = useTerminalResizeV2({
		onPtyResize: handlePtyResize,
		terminalRef,
		fitAddonRef,
		containerRef,
		isVisible,
	});

	const [terminalInstance, setTerminalInstance] = useState<Terminal | null>(
		null,
	);

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

	const performFit = (force = false): boolean => {
		if (!fitAddonRef.current || !terminalRef.current || !containerRef.current) return false;
		const rect = containerRef.current.getBoundingClientRect();
		const width = Math.round(rect.width);
		const height = Math.round(rect.height);
		if (!force && width > 0 && height > 0 && width === lastContainerWidthRef.current && height === lastContainerHeightRef.current) {
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

	const { copySelection, pasteFromClipboard, hasSelection } = useTerminalClipboard({
		terminal: terminalInstance,
		onImagePaste: async () => {
			const ptyId = ptyIdRef.current;
			if (!ptyId) return;
			// Send Ctrl+V byte to PTY - CLI apps like OpenCode read the OS clipboard directly
			await terminalApi.write(ptyId, '\x16');
		},
	});
	const copySelectionRef = useRef(copySelection);
	copySelectionRef.current = copySelection;
	const pasteFromClipboardRef = useRef(pasteFromClipboard);
	pasteFromClipboardRef.current = pasteFromClipboard;

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

			// Note: the actual fix for "frozen terminal after rapid project
			// switches" lives in terminal-cache.ts (cacheTerminal disposes any
			// stale prior occupant before storing a new one). The fresh
			// component instance always arrives here with webglAddonRef.current
			// === null (the previous instance disposed its addon during cleanup),
			// so a guarded dispose here would be a no-op. We just reset the
			// context-lost flag so the WebGL addon load further down treats this
			// as a clean mount.
			webglContextLostRef.current = false;

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


		// Listen for input from xterm
		const dataDisposable = terminal.onData(handleTerminalData);

		// Set up IPC listeners BEFORE spawning to avoid missing data
		// Cache ptyId -> terminalId mapping to avoid repeated store lookups
		let cachedTerminalId: string | null = null;
		cleanupDataListenerRef.current = terminalApi.onData(
			(id: string, data: Uint8Array) => {
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
							if (onErrorRef.current) onErrorRef.current(replayError);
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
						if (onSpawnedRef.current) {
							onSpawnedRef.current(result.data.id);
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
						if (onErrorRef.current) onErrorRef.current(errorMsg);
					}
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : "Spawn failed";
					console.error("[Terminal Spawn Exception]", errorMsg);
					terminal.write(
						`\x1b[31m\r\nTerminal spawn exception:\r\n${errorMsg}\x1b[0m\r\n`,
					);
						if (onErrorRef.current) onErrorRef.current(errorMsg);
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
						if (onErrorRef.current) onErrorRef.current(replayError);
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
			dataDisposable.dispose();
			if (cleanupDataListenerRef.current) {
				cleanupDataListenerRef.current();
				cleanupDataListenerRef.current = null;
			}
			if (cleanupExitListenerRef.current) {
				cleanupExitListenerRef.current();
				cleanupExitListenerRef.current = null;
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
	// Uses the two-stage resize pipeline via forceResizeFit,
	// which skips both debounces for immediate responsiveness.
	useEffect(() => {
		if (isVisible && fitAddonRef.current && terminalRef.current) {
			// Double RAF ensures DOM is fully rendered after pane transition
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					// Use forceResizeFit for immediate fit + PTY resize
					// This bypasses both debounce stages for visibility changes
					forceResizeFit();

					const terminal = terminalRef.current;
					if (!terminal) return;

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

					const ptyId = ptyIdRef.current;
					if (ptyId) {
						// Restore scroll position after fit (in case of pane transition)
						restoreScrollPosition(ptyId, terminal);
					} else {
						// PTY not ready yet — defer resize until spawn completes
						needsResizeOnReadyRef.current = true;
					}
				});
			});
		}
	}, [isVisible, forceResizeFit]);

	// Shared terminal recovery logic - re-fit once layout is stable, then nudge
	// the compositor to re-present the canvas layer.
	const performTerminalRecovery = useCallback((): void => {
		if (!fitAddonRef.current || !terminalRef.current) return;

		// Single-flight: if a recovery is already running (layout-wait poll or the
		// trailing visibility-flip RAF), skip duplicate triggers. On a window
		// restore both visibilitychange and focus typically fire close together.
		if (recoveryInProgressRef.current) return;
		recoveryInProgressRef.current = true;

		// Cancel any pending WebGL auto-recovery timeout to avoid double-creation
		// race with the genuine onContextLoss path.
		if (webglRecoveryTimeoutRef.current) {
			clearTimeout(webglRecoveryTimeoutRef.current);
			webglRecoveryTimeoutRef.current = null;
		}

		// Root cause (verified via live forensics + xterm.js #4841 / #5357):
		//
		// After minimize→restore on Windows the webview reflows over several
		// frames. If fit() runs while the container height is still collapsed,
		// the terminal grid shrinks to 1-2 rows (PTY redraws tiny → "1-2 lines"
		// of text) until a later resize corrects it. The fit pipeline now guards
		// against collapsed dimensions (use-terminal-resize-v2), so an early fit
		// is a safe no-op rather than a destructive shrink.
		//
		// Additionally, the WebView2 compositor may not re-present the WebGL
		// canvas layer after restore (xterm 6.x has no DOM-row fallback; the
		// context itself stays healthy). A CSS visibility flip forces a
		// re-composite — the same mechanism that makes tab-switching work.
		//
		// Strategy: wait for the container to report a usable size (poll across a
		// few RAFs), then forceResizeFit + refresh, then flip visibility to
		// guarantee the layer re-composites.
		const termEl = terminalRef.current.element as HTMLElement | undefined;
		const container = containerRef.current;

		const MIN_USABLE = 40;
		const MAX_LAYOUT_WAIT_FRAMES = 30; // ~0.5s at 60fps

		const runRecovery = (): void => {
			const terminal = terminalRef.current;
			if (!terminal) {
				recoveryInProgressRef.current = false;
				return;
			}
			// Re-fit (guarded against collapsed dims) + redraw the buffer.
			forceResizeFit();
			terminal.refresh(0, terminal.rows - 1);

			// Nudge the compositor to re-present the canvas layer. Clear the
			// single-flight guard only after the trailing refresh completes.
			if (termEl) {
				termEl.style.visibility = "hidden";
				requestAnimationFrame(() => {
					termEl.style.visibility = "";
					const t = terminalRef.current;
					if (t) t.refresh(0, t.rows - 1);
					recoveryInProgressRef.current = false;
				});
			} else {
				recoveryInProgressRef.current = false;
			}
		};

		// Wait until the container has reflowed to a usable size before fitting,
		// so we never collapse the grid. Bail out after MAX_LAYOUT_WAIT_FRAMES.
		let frames = 0;
		const waitForStableLayout = (): void => {
			const rect = container?.getBoundingClientRect();
			const ready =
				!!rect && rect.width >= MIN_USABLE && rect.height >= MIN_USABLE;
			if (ready || frames >= MAX_LAYOUT_WAIT_FRAMES) {
				runRecovery();
				return;
			}
			frames += 1;
			requestAnimationFrame(waitForStableLayout);
		};
		waitForStableLayout();
	}, [forceResizeFit]);

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

	// Recovery handler for window focus — critical for Tauri minimize/restore
	// on Windows where document.visibilitychange is unreliable.
	// The window 'focus' event reliably fires when the window is restored from
	// taskbar minimize. performTerminalRecovery re-fits the terminal to its
	// container and syncs PTY dimensions (SIGWINCH to the shell process).
	useEffect(() => {
		const handleWindowFocus = (): void => {
			// Skip recovery for terminals that are not the active tab in their pane
			// (isVisible is tab-active, not window-visible — see PaneContent.tsx).
			// Hidden instances recover via the isVisible-change useEffect instead.
			if (!isVisibleRef.current) return;
			// Fire recovery immediately — the window is already visible when
			// 'focus' fires (unlike visibilitychange which needs DOM reflow time).
			// performTerminalRecovery internally waits for a stable layout before
			// fitting and is single-flight guarded, so this is safe to call eagerly.
			performTerminalRecovery();
		};

		window.addEventListener("focus", handleWindowFocus);
		return () => {
			window.removeEventListener("focus", handleWindowFocus);
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

	const handleContainerClick = useCallback((): void => {
		terminalRef.current?.focus();
	}, []);

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

			const shortcuts = shortcutsRef.current;

			if (isAppOwnedTerminalShortcut(event, shortcuts)) {
				if (isMac && event.ctrlKey && !event.metaKey) {
					return true;
				}
				return false;
			}

			const clipboardModifier = isPlatformModifier(event);

			if (clipboardModifier) {
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
		requestAnimationFrame(() => performFit(true));
		if (autoFocus) terminal.focus();
		const resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => performFit()));
		resizeObserver.observe(containerRef.current);
		const dataDisposable = terminal.onData(handleTerminalData);
		const resizeDisposable = terminal.onResize(({ cols, rows }) => handlePtyResize(cols, rows));
		cleanupDataListenerRef.current = terminalApi.onData((id: string, data: Uint8Array) => {
			if (id === ptyIdRef.current && terminalRef.current) {
				terminalRef.current.write(data);
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
			const tId = ptyIdRef.current || externalTerminalId;
			if (tId && terminalRef.current) { captureScrollPosition(tId); if (!externalTerminalId) useTerminalStore.getState().setRendererAttached(tId, false); void removeRendererRef(tId, instanceId); }
			if (ptyIdRef.current) unregisterTerminal(ptyIdRef.current);
			else if (externalTerminalId) unregisterTerminal(externalTerminalId);
			resizeObserver.disconnect(); dataDisposable.dispose(); resizeDisposable.dispose();
			if (cleanupDataListenerRef.current) cleanupDataListenerRef.current();
			if (cleanupExitListenerRef.current) cleanupExitListenerRef.current();

			if (activityTimeoutRef.current) clearTimeout(activityTimeoutRef.current);
			disposeWebglAddon(); terminal.dispose(); terminalRef.current = null; setTerminalInstance(null);
			didInitRef.current = false; initializedTerminalIdRef.current = undefined;
		};
	}, [targetId, autoSpawn, rendererPreference, fontFamily, fontSize, bufferSize, instanceId, externalTerminalId, autoFocus, handleTerminalData, handlePtyResize, setTerminalHealthStatus, disposeWebglAddon]);

	const isCrashed = healthStatus === "disconnected" || healthStatus === "crashed";

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div className="relative w-full h-full group overflow-hidden">
					<div
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
					>
						<div ref={containerRef} className="w-full h-full" />
					</div>
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
