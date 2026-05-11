import {
	open,
	readDir,
	readTextFile,
	writeTextFile,
	mkdir,
	remove,
	rename,
	stat,
	watchImmediate,
	type WatchEvent,
} from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
	IpcResult,
	FilesystemApi,
	FileChangeCallback,
	DirectoryEntry,
	FileContent,
	FileInfo,
	FileChangeEvent,
} from "@shared/types/ipc.types";
import { cleanupTauriListener, isTauriContext } from "./tauri-runtime";

const ALWAYS_IGNORE = [
	"node_modules",
	".git",
	".next",
	".cache",
	".turbo",
	"dist",
	"build",
	".output",
	".nuxt",
	".svelte-kit",
	"__pycache__",
	".pytest_cache",
	"venv",
	".env",
	"coverage",
	".nyc_output",
];

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const SEARCH_MAX_FILES_WITH_MATCHES = 100;
const SEARCH_MAX_MATCHES_PER_FILE = 30;

async function searchWithRipgrep(rootPath: string, query: string): Promise<{
	results: Array<{ filePath: string; matches: Array<{ lineNumber: number; lineText: string }> }>;
	truncated: boolean;
	scannedFiles: number;
	failedFiles: number;
} | null> {
	try {
		const response = await invoke<{
			success: boolean;
			data?: {
				results: Array<{ filePath: string; matches: Array<{ lineNumber: number; lineText: string }> }>;
				truncated: boolean;
				scannedFiles: number;
				failedFiles: number;
			};
		}>('search_content', {
			request: {
				rootPath,
				query,
			},
		});

		if (!response?.success || !response.data) {
			return null;
		}

		return response.data;
	} catch {
		return null;
	}
}

const activeWatchers = new Map<string, () => void>();
const activeCallbacks = new Map<string, Set<FileChangeCallback>>();
const globalCallbacks = new Set<FileChangeCallback>();

function shouldIgnore(name: string): boolean {
	return ALWAYS_IGNORE.includes(name);
}

/**
 * Sort directory entries: directories first (A-Z), then files (A-Z)
 */
function sortDirectoryEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
	return [...entries].sort((a, b) => {
		// Directories come before files
		if (a.type === "directory" && b.type === "file") return -1;
		if (a.type === "file" && b.type === "directory") return 1;

		// Within same type, sort alphabetically by name (case-insensitive)
		const nameA = a.name.toLowerCase();
		const nameB = b.name.toLowerCase();
		return nameA.localeCompare(nameB);
	});
}

function isBinaryFile(content: string): boolean {
	// Check for null bytes in first 512 chars
	const sample = content.slice(0, 512);
	// eslint-disable-next-line no-control-regex
	return /[\x00-\x08]/.test(sample);
}

async function readBinarySample(filePath: string, byteCount: number): Promise<string> {
	const file = await open(filePath, { read: true });

	try {
		const bytes = new Uint8Array(byteCount);
		const bytesRead = await file.read(bytes);
		if (!bytesRead) {
			return "";
		}

		return new TextDecoder().decode(bytes.subarray(0, bytesRead));
	} finally {
		await file.close();
	}
}

function getExtension(filename: string): string | null {
	const idx = filename.lastIndexOf(".");
	return idx >= 0 ? filename.slice(idx) : null;
}

function includesCaseInsensitive(haystack: string, needle: string): boolean {
	return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

async function collectFilesRecursively(rootPath: string): Promise<string[]> {
	const files: string[] = [];
	const queue: string[] = [rootPath.replace(/\\/g, "/")];

	while (queue.length > 0) {
		const dir = queue.shift();
		if (!dir) continue;

		let entries: Awaited<ReturnType<typeof readDir>>;
		try {
			entries = await readDir(dir);
		} catch {
			continue;
		}

		for (const entry of entries) {
			const name = entry.name;
			if (shouldIgnore(name)) continue;
			const fullPath = `${dir}/${name}`.replace(/\/+/g, "/");
			if (entry.isDirectory) {
				queue.push(fullPath);
			} else {
				files.push(fullPath);
			}
		}
	}

	return files;
}

/**
 * Create a FilesystemApi implementation using Tauri's plugin-fs
 *
 * This adapter uses Tauri's filesystem plugin for direct file operations.
 * It maintains the same interface as the Electron preload script for easy migration.
 */
export function createTauriFilesystemApi(): FilesystemApi {
	return {
		async readDirectory(dirPath: string): Promise<IpcResult<DirectoryEntry[]>> {
			try {
				const normalizedDirPath = dirPath.replace(/\\/g, "/");
				const entries = await readDir(dirPath);

				const filtered: DirectoryEntry[] = [];
				for (const entry of entries) {
					const name = entry.name;
					if (shouldIgnore(name)) continue;

					const fullPath = `${normalizedDirPath}/${name}`.replace(/\/+/g, "/");
					let size = 0;
					let modified = Date.now();
					try {
						const info = await stat(fullPath);
						size = info.size;
						modified = info.mtime?.getTime() ?? Date.now();
					} catch {
						// Ignore stat errors, use defaults
					}

					const isDir = entry.isDirectory ?? false;
					filtered.push({
						name,
						path: fullPath,
						type: isDir ? "directory" : "file",
						extension: isDir ? null : getExtension(name),
						size,
						modifiedAt: modified,
					});
				}

				// Sort: directories first, then files, both A-Z
				const sorted = sortDirectoryEntries(filtered);
				return { success: true, data: sorted };
			} catch (err) {
				return { success: false, error: String(err), code: "READ_DIR_ERROR" };
			}
		},

		async readFile(filePath: string): Promise<IpcResult<FileContent>> {
			try {
				const info = await stat(filePath);
				if (info.size > MAX_FILE_SIZE) {
					return {
						success: false,
						error: `File too large (${info.size} bytes, max ${MAX_FILE_SIZE})`,
						code: "FILE_TOO_LARGE",
					};
				}

				const content = await readTextFile(filePath);
				const isBinary = isBinaryFile(content);

				return {
					success: true,
					data: {
						content,
						encoding: "utf-8",
						size: info.size,
						modifiedAt: info.mtime?.getTime() ?? Date.now(),
					},
				};
			} catch (err) {
				return { success: false, error: String(err), code: "READ_ERROR" };
			}
		},

		async getFileInfo(filePath: string): Promise<IpcResult<FileInfo>> {
			try {
				const info = await stat(filePath);
				const modifiedAt = info.mtime?.getTime() ?? Date.now();

				if (info.isDirectory) {
					return {
						success: true,
						data: {
							path: filePath,
							size: info.size,
							modifiedAt,
							type: "directory",
							isReadOnly: false,
							isBinary: false,
						},
					};
				}

				const content = await readBinarySample(filePath, 512).catch(() => "");

				return {
					success: true,
					data: {
						path: filePath,
						size: info.size,
						modifiedAt,
						type: "file",
						isReadOnly: false, // Tauri plugin-fs doesn't expose readonly
						isBinary: isBinaryFile(content),
					},
				};
			} catch (err) {
				return { success: false, error: String(err), code: "STAT_ERROR" };
			}
		},

		async searchContent(rootPath: string, query: string) {
			const normalizedRootPath = rootPath.replace(/\\/g, "/");
			const trimmedQuery = query.trim();
			if (!trimmedQuery) {
				return {
					success: true,
					data: {
						results: [],
						truncated: false,
						scannedFiles: 0,
						failedFiles: 0,
					},
				};
			}

			const ripgrepResult = await searchWithRipgrep(normalizedRootPath, trimmedQuery);
			if (ripgrepResult) {
				return {
					success: true,
					data: ripgrepResult,
				};
			}

			return {
				success: false,
				error: "Search backend unavailable (ripgrep command failed)",
				code: "SEARCH_BACKEND_UNAVAILABLE",
			};

			/* fallback disabled intentionally to preserve VSCode-like performance guarantees
			try {
				const allFiles = await collectFilesRecursively(normalizedRootPath);
				const results: Array<{ filePath: string; matches: Array<{ lineNumber: number; lineText: string }> }> = [];
				let truncated = false;
				let scannedFiles = 0;
				let failedFiles = 0;

				for (const filePath of allFiles) {
					if (results.length >= SEARCH_MAX_FILES_WITH_MATCHES) {
						truncated = true;
						break;
					}

					let info;
					try {
						info = await stat(filePath);
					} catch {
						failedFiles += 1;
						continue;
					}

					if (info.isDirectory || info.size > MAX_FILE_SIZE) {
						continue;
					}

					scannedFiles += 1;

					let content = "";
					try {
						content = await readTextFile(filePath);
					} catch {
						failedFiles += 1;
						continue;
					}

					if (isBinaryFile(content)) {
						continue;
					}

					const lines = content.split(/\r?\n/);
					const matches: Array<{ lineNumber: number; lineText: string }> = [];

					for (let i = 0; i < lines.length; i += 1) {
						if (includesCaseInsensitive(lines[i], trimmedQuery)) {
							matches.push({ lineNumber: i + 1, lineText: lines[i] });
							if (matches.length >= SEARCH_MAX_MATCHES_PER_FILE) {
								truncated = true;
								break;
							}
						}
					}

					if (matches.length > 0) {
						results.push({ filePath, matches });
					}
				}

				return {
					success: true,
					data: {
						results,
						truncated,
						scannedFiles,
						failedFiles,
					},
				};
			} catch (err) {
				return {
					success: false,
					error: String(err),
					code: "SEARCH_ERROR",
				};
			}
			*/
		},

		async searchContentStreamStart(searchId: string, rootPath: string, query: string) {
			try {
				const response = await invoke<{ success: boolean; error?: string; code?: string }>(
					"search_content_stream",
					{ request: { searchId, rootPath, query } },
				);
				if (!response?.success) {
					return {
						success: false as const,
						error: response?.error ?? "Failed to start search stream",
						code: response?.code ?? "SEARCH_STREAM_ERROR",
					};
				}
				return { success: true as const, data: undefined };
			} catch (err) {
				return { success: false as const, error: String(err), code: "SEARCH_STREAM_ERROR" };
			}
		},

		async searchContentStreamCancel(searchId: string) {
			try {
				const response = await invoke<{ success: boolean; error?: string; code?: string }>(
					"search_content_cancel",
					{ request: { searchId } },
				);
				if (!response?.success) {
					return {
						success: false as const,
						error: response?.error ?? "Failed to cancel search stream",
						code: response?.code ?? "SEARCH_STREAM_CANCEL_ERROR",
					};
				}
				return { success: true as const, data: undefined };
			} catch (err) {
				return {
					success: false as const,
					error: String(err),
					code: "SEARCH_STREAM_CANCEL_ERROR",
				};
			}
		},

		onSearchContentBatch(callback) {
			if (!isTauriContext()) return () => {};
			let unlisten: Promise<UnlistenFn> | undefined;
			try {
				unlisten = listen<{
					searchId: string;
					results: Array<{ filePath: string; matches: Array<{ lineNumber: number; lineText: string }> }>;
					truncated: boolean;
				}>("search-content-batch", ({ payload }) => callback(payload));
			} catch {
				return () => {};
			}
			return () => cleanupTauriListener(unlisten);
		},

		async searchFileNames(rootPath: string, query: string) {
			try {
				const response = await invoke<{
					success: boolean;
					data?: { files: string[]; truncated: boolean };
					error?: string;
					code?: string;
				}>("search_file_names", {
					request: { rootPath, query }
				});
				if (!response?.success || !response.data) {
					return {
						success: false as const,
						error: response?.error ?? "Failed to search file names",
						code: response?.code ?? "SEARCH_FILENAME_ERROR"
					};
				}
				return { success: true as const, data: response.data };
			} catch (err) {
				return {
					success: false as const,
					error: String(err),
					code: "SEARCH_FILENAME_ERROR"
				};
			}
		},

		onSearchContentDone(callback) {
			if (!isTauriContext()) return () => {};
			let unlisten: Promise<UnlistenFn> | undefined;
			try {
				unlisten = listen<{
					searchId: string;
					truncated: boolean;
					scannedFiles: number;
					failedFiles: number;
					error?: string;
				}>("search-content-done", ({ payload }) => callback(payload));
			} catch {
				return () => {};
			}
			return () => cleanupTauriListener(unlisten);
		},

		async writeFile(
			filePath: string,
			content: string,
		): Promise<IpcResult<void>> {
			try {
				await writeTextFile(filePath, content);
				return { success: true, data: undefined };
			} catch (err) {
				return { success: false, error: String(err), code: "WRITE_ERROR" };
			}
		},

		async createFile(filePath: string, content = ""): Promise<IpcResult<void>> {
			try {
				await writeTextFile(filePath, content);
				return { success: true, data: undefined };
			} catch (err) {
				return { success: false, error: String(err), code: "CREATE_ERROR" };
			}
		},

		async createDirectory(dirPath: string): Promise<IpcResult<void>> {
			try {
				await mkdir(dirPath, { recursive: true });
				return { success: true, data: undefined };
			} catch (err) {
				return { success: false, error: String(err), code: "MKDIR_ERROR" };
			}
		},

		async deletePath(
			path: string,
			options?: { recursive?: boolean },
		): Promise<IpcResult<void>> {
			try {
				await remove(path, { recursive: options?.recursive ?? false });
				return { success: true, data: undefined };
			} catch (err) {
				return { success: false, error: String(err), code: "DELETE_ERROR" };
			}
		},

		async renameFile(
			oldPath: string,
			newPath: string,
		): Promise<IpcResult<void>> {
			try {
				await rename(oldPath, newPath);
				return { success: true, data: undefined };
			} catch (err) {
				return { success: false, error: String(err), code: "RENAME_ERROR" };
			}
		},

		async watchDirectory(dirPath: string): Promise<IpcResult<void>> {
			try {
				const normalizedDirPath = dirPath.replace(/\\/g, "/");

				if (activeWatchers.has(normalizedDirPath)) {
					return { success: true, data: undefined }; // Already watching
				}

				const unlisten = await watchImmediate(
					[dirPath], // Use original OS-native path for the watcher
					// Callback receives single WatchEvent, not array
					(event: WatchEvent) => {
						const callbacks = activeCallbacks.get(normalizedDirPath);
						if (!callbacks) return;

						// WatchEventKind is a complex type - check the type property
						// The kind object has a 'type' property: 'create' | 'modify' | 'remove' | 'access' | 'other' | 'any'
						const kindType = (event.type as { type?: string })?.type ?? "other";

						let changeType: FileChangeEvent["type"] = "change";
						if (kindType === "create") changeType = "add";
						else if (kindType === "remove") changeType = "unlink";

						// paths is an array - use first element
						const changedPath = (event.paths?.[0] ?? normalizedDirPath).replace(
							/\\/g,
							"/",
						);
						const changeEvent: FileChangeEvent = {
							type: changeType,
							path: changedPath,
						};

						callbacks.forEach((cb) => cb(changeEvent));
						globalCallbacks.forEach((cb) => cb(changeEvent));
					},
				);

				activeWatchers.set(normalizedDirPath, unlisten);
				if (!activeCallbacks.has(normalizedDirPath)) {
					activeCallbacks.set(normalizedDirPath, new Set());
				}
				return { success: true, data: undefined };
			} catch (err) {
				return { success: false, error: String(err), code: "WATCH_ERROR" };
			}
		},

		async unwatchDirectory(dirPath: string): Promise<IpcResult<void>> {
			try {
				const normalizedDirPath = dirPath.replace(/\\/g, "/");
				const unlisten = activeWatchers.get(normalizedDirPath);
				if (unlisten) {
					unlisten();
					activeWatchers.delete(normalizedDirPath);
					activeCallbacks.delete(normalizedDirPath);
				}
				return { success: true, data: undefined };
			} catch (err) {
				return { success: false, error: String(err), code: "UNWATCH_ERROR" };
			}
		},

		onFileChanged(callback: FileChangeCallback): () => void {
			globalCallbacks.add(callback);

			// Return cleanup function
			return () => {
				globalCallbacks.delete(callback);
				for (const callbacks of activeCallbacks.values()) {
					callbacks.delete(callback);
				}
			};
		},

		onFileCreated(callback: FileChangeCallback): () => void {
			// Same implementation as onFileChanged for plugin-fs
			return this.onFileChanged(callback);
		},

		onFileDeleted(callback: FileChangeCallback): () => void {
			// Same implementation as onFileChanged for plugin-fs
			return this.onFileChanged(callback);
		},
	};
}

/**
 * Direct export singleton for convenience (matches api-bridge pattern)
 */
export const tauriFilesystemApi = createTauriFilesystemApi();

/**
 * @internal Testing only - reset module state
 */
export function _resetFilesystemStateForTesting() {
	activeWatchers.clear();
	activeCallbacks.clear();
	globalCallbacks.clear();
}
