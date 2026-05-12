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

const shouldUseWebglRenderer = (
	rendererPreference: "auto" | "webgl" | "canvas",
): boolean => rendererPreference !== "canvas";

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
	const onCommandRef = useRef(onCommand);
	onCommandRef.current = onCommand;
	const onBoundToStoreTerminalRef = useRef(onBoundToStoreTerminal);
	onBoundToStoreTerminalRef.current = onBoundToStoreTerminal;
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

	// 4. STATE
	const [terminalInstance, setTerminalInstance] = useState<Terminal | null>(null);

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

	const { copySelection, pasteFromClipboard, hasSelection } = useTerminalClipboard({ terminal: terminalInstance });

	useEffect(() => { if (externalTerminalId) ptyIdRef.current = externalTerminalId; }, [externalTerminalId]);

	useEffect(() => { if (continuityProjectIdRef.current) continuityProjectIdRef.current = getInstrumentationProjectId(spawnOptions); }, [spawnOptions]);

	useEffect(() => {
		if (!externalTerminalId || isTerminalPendingPtyAssignment(externalTerminalId)) return;
		useTerminalStore.getState().setRendererAttached(externalTerminalId, true);
		return () => { useTerminalStore.getState().setRendererAttached(externalTerminalId, false); };
	}, [externalTerminalId]);

	const memoizedSpawnOptions = useMemo(() => spawnOptions, [spawnOptions?.shell, spawnOptions?.cwd, spawnOptions?.cols, spawnOptions?.rows, spawnOptions?.env]);

	const handleTerminalData = useCallback(async (data: string): Promise<void> => {
		const ptyId = ptyIdRef.current;
		if (!ptyId) return;
		if (data === "\r" || data === "\n") {
			const command = currentLineRef.current;
			currentLineRef.current = "";
			if (command && onCommandRef.current) onCommandRef.current(command);
		} else if (data === "\x7f" || data === "\b") {
			currentLineRef.current = currentLineRef.current.slice(0, -1);
		} else if (data === "\x03") {
			currentLineRef.current = "";
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			currentLineRef.current += data;
		} else if (data.length > 1) {
			currentLineRef.current += data;
		}
		try {
			const result = await terminalApi.write(ptyId, data);
			if (!result.success && onError) onError(result.error);
		} catch (err) {
			if (onError) onError(err instanceof Error ? err.message : "Write failed");
		}
	}, [onError]);

	const handleResize = useCallback(async (cols: number, rows: number): Promise<void> => {
		const ptyId = ptyIdRef.current;
		if (!ptyId) return;
		if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
		resizeTimeoutRef.current = setTimeout(async () => {
			const currentPtyId = ptyIdRef.current;
			if (!currentPtyId) return;
			try { await terminalApi.resize(currentPtyId, cols, rows); } catch { }
		}, RESIZE_DEBOUNCE_MS);
	}, []);

	const handleContainerClick = useCallback((): void => {
		terminalRef.current?.focus();
	}, []);

	const handleSelectAll = useCallback((): void => {
		terminalRef.current?.selectAll();
	}, []);

	const searchDecorations = {
		matchBackground: "#444444",
		activeMatchBackground: "#FFFF00",
		matchOverviewRuler: "#444444",
		activeMatchColorOverviewRuler: "#FFFF00",
	};

	useImperativeHandle(searchRef, () => ({
		findNext: (term: string) => searchAddonRef.current?.findNext(term, { decorations: searchDecorations }) ?? false,
		findPrevious: (term: string) => searchAddonRef.current?.findPrevious(term, { decorations: searchDecorations }) ?? false,
		clearDecorations: () => searchAddonRef.current?.clearDecorations(),
		writeText: (text: string) => { if (ptyIdRef.current) terminalApi.write(ptyIdRef.current, text); }
	}), []);

	const shouldDebugLog = import.meta.env.DEV;
	const devLog = (...args: unknown[]): void => { if (shouldDebugLog) console.log(...args); };

	useEffect(() => {
		const debugId = `${instanceId}-${Date.now().toString().slice(-6)}`;
		const terminalKey = `${targetId}-${ptyId ? "active" : "restarting"}`;
		if (!containerRef.current || !targetId) return;
		if (didInitRef.current && initializedTerminalIdRef.current === terminalKey) return;
		didInitRef.current = true;
		initializedTerminalIdRef.current = terminalKey;
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
					case "c": if (terminal.hasSelection()) { event.preventDefault(); lastClipboardOpRef.current = now; void copySelection(); return false; } return true;
					case "v": event.preventDefault(); lastClipboardOpRef.current = now; void pasteFromClipboard(); return false;
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
		const resizeDisposable = terminal.onResize(({ cols, rows }) => handleResize(cols, rows));
		cleanupDataListenerRef.current = terminalApi.onData((id: string, data: string) => {
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
					const result = await terminalApi.spawn({ ...memoizedSpawnOptions, shell: memoizedSpawnOptions?.shell || undefined, cols: terminal.cols || 80, rows: terminal.rows || 24 });
					if (result.success) {
						ptyIdRef.current = result.data.id;
						useTerminalStore.getState().setRendererAttached(result.data.id, true);
						void addRendererRef(result.data.id, instanceIdRef.current);
						registerTerminal(result.data.id, terminal);
						const transcript = useTerminalStore.getState().peekTranscript(result.data.id);
						if (transcript) { terminal.write(transcript); useTerminalStore.getState().consumeTranscript(result.data.id); }
						else if (initialScrollback?.length) restoreScrollback(terminal, initialScrollback);
						if (onSpawned) onSpawned(result.data.id);
						if (onBoundToStoreTerminalRef.current) onBoundToStoreTerminalRef.current(result.data.id);
					} else if (onError) onError(result.error);
				} catch (err) { if (onError) onError(err instanceof Error ? err.message : "Spawn failed"); } finally { spawnInFlightRef.current = false; }
			} else {
				void addRendererRef(externalTerminalId, instanceIdRef.current);
				registerTerminal(externalTerminalId, terminal);
				const transcript = useTerminalStore.getState().peekTranscript(externalTerminalId);
				if (transcript) { terminal.write(transcript); useTerminalStore.getState().consumeTranscript(externalTerminalId); }
				else if (initialScrollback?.length) restoreScrollback(terminal, initialScrollback);
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
			if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
			if (activityTimeoutRef.current) clearTimeout(activityTimeoutRef.current);
			disposeWebglAddon(); terminal.dispose(); terminalRef.current = null; setTerminalInstance(null);
			didInitRef.current = false; initializedTerminalIdRef.current = undefined;
		};
	}, [targetId, ptyId, autoSpawn, rendererPreference, memoizedSpawnOptions, fontFamily, fontSize, bufferSize, instanceId, externalTerminalId, autoFocus, initialScrollback, handleTerminalData, handleResize, copySelection, pasteFromClipboard, setTerminalHealthStatus]);

	const isCrashed = healthStatus === "disconnected" || healthStatus === "crashed";

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div className="relative w-full h-full group overflow-hidden">
					<div ref={containerRef} className={`w-full h-full bg-[#1e1e1e] px-4 py-0.5 pb-1 ${className}`} onClick={handleContainerClick} onMouseDown={(e) => { e.stopPropagation(); terminalRef.current?.focus(); }} />
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
