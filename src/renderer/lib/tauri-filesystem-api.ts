import {
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
import type {
	IpcResult,
	FilesystemApi,
	FileChangeCallback,
	DirectoryEntry,
	FileContent,
	FileInfo,
	FileChangeEvent,
} from "@shared/types/ipc.types";

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

function getExtension(filename: string): string | null {
	const idx = filename.lastIndexOf(".");
	return idx >= 0 ? filename.slice(idx) : null;
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
				const content = await readTextFile(filePath).catch(() => "");

				return {
					success: true,
					data: {
						path: filePath,
						size: info.size,
						modifiedAt: info.mtime?.getTime() ?? Date.now(),
						isReadOnly: false, // Tauri plugin-fs doesn't expose readonly
						isBinary: isBinaryFile(content),
					},
				};
			} catch (err) {
				return { success: false, error: String(err), code: "STAT_ERROR" };
			}
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
