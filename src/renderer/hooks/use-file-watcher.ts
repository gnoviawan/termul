import { useEffect } from "react";
import { toast } from "sonner";
import { filesystemApi } from "@/lib/api";
import { useFileExplorerStore } from "@/stores/file-explorer-store";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore, editorTabId } from "@/stores/workspace-store";
import type { FileChangeEvent } from "@shared/types/filesystem.types";

function getDirname(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	const lastSlash = normalized.lastIndexOf("/");
	if (lastSlash < 0) return normalized;
	if (lastSlash === 0) return "/";
	return normalized.slice(0, lastSlash);
}

export function useFileWatcher(): void {
	useEffect(() => {
		const pendingRefreshDirs = new Set<string>();
		let flushTimer: ReturnType<typeof setTimeout> | null = null;

		function scheduleRefresh(dir: string): void {
			const explorerState = useFileExplorerStore.getState();
			if (!explorerState.expandedDirs.has(dir)) return;

			pendingRefreshDirs.add(dir);

			if (flushTimer) clearTimeout(flushTimer);
			flushTimer = setTimeout(() => {
				const explorerState = useFileExplorerStore.getState();
				for (const dirPath of pendingRefreshDirs) {
					if (explorerState.expandedDirs.has(dirPath)) {
						explorerState.refreshDirectory(dirPath);
					}
				}
				pendingRefreshDirs.clear();
				flushTimer = null;
			}, 300);
		}

		const handleFileChanged = (event: FileChangeEvent): void => {
			const { path } = event;

			// Debounced refresh for file explorer
			const parentDir = getDirname(path);
			scheduleRefresh(parentDir);

			// Handle open editor files (immediate — not debounced)
			const editorState = useEditorStore.getState();
			const fileState = editorState.openFiles.get(path);
			if (fileState) {
				// Skip self-save watcher noise from the internal editor save flow
				if (Date.now() < fileState.watcherIgnoreUntil) {
					return;
				}

				// Also skip if the file is in a transient save/reload/saved state
				if (
					fileState.operationStatus === "saving" ||
					fileState.operationStatus === "reloading" ||
					fileState.operationStatus === "saved"
				) {
					return;
				}

				const fileName = path.split(/[\\/]/).pop() || path;

				if (!fileState.isDirty) {
					void editorState.reloadFile(path);
				} else {
					toast("File modified externally", {
						description: `${fileName} was changed outside the app. Click reload to discard local changes and refresh from disk.`,
						action: {
							label: "Reload",
							onClick: () => {
								const latestState = useEditorStore.getState();
								const latestFileState = latestState.openFiles.get(path);
								if (!latestFileState) return;

								const nextOpenFiles = new Map(latestState.openFiles);
								nextOpenFiles.set(path, {
									...latestFileState,
									isDirty: false,
									originalContent: latestFileState.content,
								});
								useEditorStore.setState({ openFiles: nextOpenFiles });
								void useEditorStore.getState().reloadFile(path);
							},
						},
					});
				}
			}
		};

		const handleFileCreated = (event: FileChangeEvent): void => {
			const parentDir = getDirname(event.path);
			scheduleRefresh(parentDir);
		};

		const handleFileDeleted = (event: FileChangeEvent): void => {
			const parentDir = getDirname(event.path);
			scheduleRefresh(parentDir);

			// Close editor tab immediately if the deleted file is open
			const editorState = useEditorStore.getState();
			if (editorState.openFiles.has(event.path)) {
				editorState.closeFile(event.path);
				useWorkspaceStore.getState().removeTab(editorTabId(event.path));
			}
		};

		try {
			const unsubChanged = filesystemApi.onFileChanged(handleFileChanged);
			const unsubCreated = filesystemApi.onFileCreated(handleFileCreated);
			const unsubDeleted = filesystemApi.onFileDeleted(handleFileDeleted);

			return () => {
				if (flushTimer) clearTimeout(flushTimer);
				pendingRefreshDirs.clear();
				unsubChanged();
				unsubCreated();
				unsubDeleted();
			};
		} catch (error) {
			console.error(
				"[useFileWatcher] Failed to subscribe to file watcher events",
				error,
			);
			return () => {
				if (flushTimer) clearTimeout(flushTimer);
				pendingRefreshDirs.clear();
			};
		}
	}, []);
}
