import { useEffect, useRef, memo } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { DEFAULT_TERMINAL_OPTIONS } from "@/components/terminal/terminal-config";
import type { PoolSlot } from "@/components/terminal/terminal-renderer-pool";
import "@xterm/xterm/css/xterm.css";

export interface XTerminalProps {
	onData?: (data: string) => void;
	onResize?: (cols: number, rows: number) => void;
	onReady?: (terminal: Terminal) => void;
	className?: string;
	/** Optional pool slot to use instead of creating a new Terminal instance. */
	poolSlot?: PoolSlot;
}

const TERMINAL_OPTIONS = {
	...DEFAULT_TERMINAL_OPTIONS,
	// Deliberate overrides: XTerminal always converts EOL to LF for compatibility
	convertEol: true,
};

function XTerminalComponent({
	onData,
	onResize,
	onReady,
	className = "",
	poolSlot,
}: XTerminalProps): React.JSX.Element {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const resizeObserverRef = useRef<ResizeObserver | null>(null);

	useEffect(() => {
		if (!containerRef.current) return;

		let terminal: Terminal;
		let fitAddon: FitAddon;

		if (poolSlot) {
			// Use the pool slot's pre-configured terminal
			terminal = poolSlot.term;
			fitAddon = poolSlot.fitAddon;
			terminalRef.current = terminal;
			fitAddonRef.current = fitAddon;

			// Move the slot's host div into this container
			containerRef.current.appendChild(poolSlot.host);
		} else {
			// Create a new terminal as before
			terminal = new Terminal(TERMINAL_OPTIONS);
			terminalRef.current = terminal;

			fitAddon = new FitAddon();
			fitAddonRef.current = fitAddon;
			terminal.loadAddon(fitAddon);

			const webLinksAddon = new WebLinksAddon();
			terminal.loadAddon(webLinksAddon);

			terminal.open(containerRef.current);

			try {
				const webglAddon = new WebglAddon();
				webglAddon.onContextLoss(() => {
					webglAddon.dispose();
				});
				terminal.loadAddon(webglAddon);
			} catch {
				console.warn(
					"WebGL addon failed to load, falling back to DOM renderer",
				);
			}
		}

		// Fit the terminal to its container
		try {
			fitAddon.fit();
		} catch {
			// Ignore fit errors during initialization
		}

		let onDataDisposable: { dispose: () => void } | undefined;
		let onResizeDisposable: { dispose: () => void } | undefined;

		if (onData) {
			onDataDisposable = terminal.onData(onData);
		}

		if (onResize) {
			onResizeDisposable = terminal.onResize(({ cols, rows }) => {
				onResize(cols, rows);
			});
		}

		if (onReady) {
			onReady(terminal);
		}

		// Set up ResizeObserver for terminal fitting
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
		resizeObserverRef.current = resizeObserver;

		return () => {
			resizeObserver.disconnect();

			// Dispose event subscriptions
			onDataDisposable?.dispose();
			onResizeDisposable?.dispose();

			// Only dispose the terminal if we created it (not a pool slot)
			if (!poolSlot) {
				terminal.dispose();
				terminalRef.current = null;
				fitAddonRef.current = null;
			}
			// If poolSlot was provided, the pool owns the lifecycle
		};
	}, [onData, onResize, onReady, poolSlot]);

	return (
		<div
			ref={containerRef}
			className={`w-full h-full bg-[#1e1e1e] px-4 py-0.5 pb-1 ${className}`}
		/>
	);
}

export const XTerminal = memo(XTerminalComponent);

// eslint-disable-next-line react-refresh/only-export-components
export function useTerminalRef(): {
	terminalRef: React.RefObject<Terminal | null>;
	write: (data: string) => void;
	clear: () => void;
	focus: () => void;
	fit: () => void;
} {
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);

	const write = (data: string): void => {
		terminalRef.current?.write(data);
	};

	const clear = (): void => {
		terminalRef.current?.clear();
	};

	const focus = (): void => {
		terminalRef.current?.focus();
	};

	const fit = (): void => {
		try {
			fitAddonRef.current?.fit();
		} catch {
			// Ignore fit errors
		}
	};

	return { terminalRef, write, clear, focus, fit };
}
