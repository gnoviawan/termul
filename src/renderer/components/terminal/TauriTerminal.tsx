import { useRef, useEffect, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";
import { spawn } from "tauri-pty";
import type { ShellInfo } from "@/lib/tauri-types";
import {
	getTerminalOptions,
	RESIZE_DEBOUNCE_MS,
} from "@/components/terminal/terminal-config";
import "@xterm/xterm/css/xterm.css";

const MAX_WEBGL_RETRIES = 3;

type TerminalStatus = "loading" | "ready" | "exited" | "error";

export function TauriTerminal(): React.JSX.Element {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const ptyRef = useRef<ReturnType<typeof spawn> | null>(null);
	const webglAddonRef = useRef<WebglAddon | null>(null);
	const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cleanupFnsRef = useRef<Array<{ dispose?: () => void } | (() => void)>>(
		[],
	);
	const disposedRef = useRef(false);
	const [status, setStatus] = useState<TerminalStatus>("loading");
	const [errorMsg, setErrorMsg] = useState<string>("");

	const initTerminal = useCallback(async () => {
		if (!containerRef.current) return;

		try {
			// Detect platform for ConPTY settings
			const os = platform();
			const isWindows = os === "windows";

			// Create terminal with platform-aware options
			const termOptions = getTerminalOptions(os === "windows" ? "Win32" : os);

			const term = new Terminal(termOptions);
			termRef.current = term;

			// FitAddon
			const fitAddon = new FitAddon();
			fitAddonRef.current = fitAddon;
			term.loadAddon(fitAddon);

			// Open terminal in container
			term.open(containerRef.current);
			fitAddon.fit();

			// WebGL addon with fallback
			let webglAttempts = 0;
			const loadWebgl = (): void => {
				if (disposedRef.current || webglAttempts >= MAX_WEBGL_RETRIES) {
					if (webglAttempts >= MAX_WEBGL_RETRIES) {
						console.warn(
							"[TauriTerminal] WebGL failed after max retries, using canvas renderer",
						);
					}
					return;
				}
				try {
					const webglAddon = new WebglAddon();
					webglAddonRef.current = webglAddon;
					webglAddon.onContextLoss(() => {
						webglAddon.dispose();
						webglAddonRef.current = null;
						webglAttempts++;
						loadWebgl();
					});
					term.loadAddon(webglAddon);
				} catch {
					webglAttempts++;
					console.warn(`[TauriTerminal] WebGL attempt ${webglAttempts} failed`);
					loadWebgl();
				}
			};
			loadWebgl();

			// Shell detection
			let shellInfo: ShellInfo;
			try {
				shellInfo = await invoke<ShellInfo>("get_default_shell");
			} catch (err) {
				if (disposedRef.current) return;
				const msg = `Shell detection gagal: ${err}`;
				setErrorMsg(msg);
				setStatus("error");
				term.writeln(`\r\n\x1b[31m[Error] ${msg}\x1b[0m`);
				return;
			}

			// Check if disposed after shell detection
			if (disposedRef.current) return;

			// Get home directory for initial CWD
			let cwd: string;
			try {
				cwd = await invoke<string>("get_home_directory");
			} catch {
				cwd = isWindows ? "C:\\" : "/tmp";
			}

			// Check if disposed after getting home directory
			if (disposedRef.current) return;

			// Spawn PTY
			const { cols, rows } = fitAddon.proposeDimensions() ?? {
				cols: 80,
				rows: 24,
			};

			// Check if disposed after fitAddon.proposeDimensions
			if (disposedRef.current) return;

			const pty = spawn(shellInfo.path, shellInfo.args ?? [], {
				cols,
				rows,
				cwd,
			});
			ptyRef.current = pty;

			// If disposed immediately after spawn, clean up the PTY
			if (disposedRef.current) {
				try {
					pty.kill();
				} catch {
					/* ignore */
				}
				ptyRef.current = null;
				return;
			}

			// Data I/O: PTY → Terminal
			const unlistenData = pty.onData((data) => {
				if (!disposedRef.current) term.write(data);
			});
			cleanupFnsRef.current.push(unlistenData);

			// Data I/O: Terminal → PTY
			const termDataDisposable = term.onData((data: string) => {
				pty.write(data);
			});
			cleanupFnsRef.current.push(() => termDataDisposable.dispose());

			// PTY exit handler
			const unlistenExit = pty.onExit(({ exitCode }: { exitCode: number }) => {
				if (disposedRef.current) return;
				console.log(`[TauriTerminal] PTY exited with code ${exitCode}`);
				term.writeln(
					`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m`,
				);
				term.options.disableStdin = true;
				if (!disposedRef.current) setStatus("exited");
			});
			cleanupFnsRef.current.push(unlistenExit);

			const container = containerRef.current as
				| (HTMLDivElement & { _resizeObserver?: ResizeObserver })
				| null;
			if (!container) {
				return;
			}

			// ResizeObserver for auto-fit
			const resizeObserver = new ResizeObserver(() => {
				if (disposedRef.current) return;
				if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
				resizeTimerRef.current = setTimeout(() => {
					if (
						disposedRef.current ||
						!fitAddonRef.current ||
						!ptyRef.current ||
						!termRef.current
					)
						return;
					try {
						fitAddonRef.current.fit();
						const dims = fitAddonRef.current.proposeDimensions();
						if (dims) {
							ptyRef.current.resize(dims.cols, dims.rows);
						}
					} catch {
						// Ignore resize errors during teardown
					}
				}, RESIZE_DEBOUNCE_MS);
			});
			resizeObserver.observe(container);

			if (!disposedRef.current) setStatus("ready");

			// Store observer for cleanup
			container._resizeObserver = resizeObserver;
		} catch (err) {
			if (!disposedRef.current) {
				const msg = `Terminal initialization gagal: ${err}`;
				setErrorMsg(msg);
				setStatus("error");
				console.error("[TauriTerminal]", msg);
			}
		}
	}, []);

	useEffect(() => {
		initTerminal();
		const container = containerRef.current as
			| (HTMLDivElement & { _resizeObserver?: ResizeObserver })
			| null;

		return () => {
			// Mark as disposed first to prevent callbacks from firing
			disposedRef.current = true;

			// Disconnect observer first to prevent new resize events
			if (container?._resizeObserver) {
				container._resizeObserver.disconnect();
			}

			if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);

			// Unlisten PTY and terminal event handlers
			for (const fn of cleanupFnsRef.current) {
				try {
					if (typeof fn === "function") fn();
					else if (fn && typeof fn.dispose === "function") fn.dispose();
				} catch {
					/* ignore */
				}
			}
			cleanupFnsRef.current = [];

			// Dispose WebGL addon explicitly
			try {
				webglAddonRef.current?.dispose();
			} catch {
				/* ignore */
			}
			webglAddonRef.current = null;

			try {
				ptyRef.current?.kill();
			} catch {
				// PTY may already be dead
			}

			termRef.current?.dispose();
			ptyRef.current = null;
			termRef.current = null;
			fitAddonRef.current = null;
		};
	}, [initTerminal]);

	if (status === "error") {
		return (
			<div className="flex-1 flex items-center justify-center bg-[#1e1e1e] text-red-400 p-4">
				<div className="text-center">
					<p className="text-lg font-semibold mb-2">Terminal Error</p>
					<p className="text-sm text-red-300">{errorMsg}</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex-1 relative bg-[#1e1e1e]">
			{status === "loading" && (
				<div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-sm z-10">
					Loading terminal...
				</div>
			)}
			<div
				ref={containerRef}
				className="absolute inset-0 px-4 py-0.5 pb-1 bg-[#1e1e1e]"
			/>
		</div>
	);
}
