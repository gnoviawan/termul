import { useEffect, useRef, memo } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { DEFAULT_TERMINAL_OPTIONS } from "@/components/terminal/terminal-config";
import "@xterm/xterm/css/xterm.css";

export interface XTerminalProps {
	onData?: (data: string) => void;
	onResize?: (cols: number, rows: number) => void;
	onReady?: (terminal: Terminal) => void;
	className?: string;
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
}: XTerminalProps): React.JSX.Element {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const resizeObserverRef = useRef<ResizeObserver | null>(null);

	useEffect(() => {
		if (!containerRef.current) return;

		const terminal = new Terminal(TERMINAL_OPTIONS);
		terminalRef.current = terminal;

		const fitAddon = new FitAddon();
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
				"WebGL addon failed to load, falling back to canvas renderer",
			);
		}

		fitAddon.fit();

		if (onData) {
			terminal.onData(onData);
		}

		if (onResize) {
			terminal.onResize(({ cols, rows }) => {
				onResize(cols, rows);
			});
		}

		if (onReady) {
			onReady(terminal);
		}

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
			terminal.dispose();
			terminalRef.current = null;
			fitAddonRef.current = null;
		};
	}, [onData, onResize, onReady]);

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
