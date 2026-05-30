import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { ShellInfo } from "@shared/types/ipc.types";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { FolderKanban, Terminal } from "lucide-react";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { SSHWorkspace } from "@/components/ssh/SSHWorkspace";
import { PaneRenderer } from "@/components/workspace/PaneRenderer";
import { PaneDndProvider } from "@/hooks/use-pane-dnd";
import { StatusBar } from "@/components/StatusBar";
import { NewProjectModal } from "@/components/NewProjectModal";
import { CreateSnapshotModal } from "@/components/CreateSnapshotModal";
import { CommandPalette } from "@/components/CommandPalette";
import { CommandHistoryModal } from "@/components/CommandHistoryModal";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FileExplorer } from "@/components/file-explorer/FileExplorer";
import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@/components/ui/resizable";
import {
	useProjects,
	useActiveProject,
	useActiveProjectId,
	useProjectActions,
	useProjectsLoaded,
} from "@/stores/project-store";
import {
	useTerminals,
	useActiveTerminal,
	useActiveTerminalId,
	useTerminalActions,
	useTerminalStore,
} from "@/stores/terminal-store";
import {
	useFileExplorerStore,
	useFileExplorerVisible,
} from "@/stores/file-explorer-store";
import { useSidebarVisible } from "@/stores/sidebar-store";
import { useSSHProfiles, useSSHActions, useActiveSSHProfileId, useActiveSSHProfile, useSSHStore } from "@/stores/ssh-store";
import { useEditorStore } from "@/stores/editor-store";
import { useCommandHistoryStore } from "@/stores/command-history-store";
import {
	useWorkspaceStore,
	useActiveTab,
	usePaneRoot,
	useFullscreenPaneId,
	findPaneById,
	editorTabId,
	getActiveTerminalIdFromTree,
	getActiveFilePathFromTree,
	findPaneContainingTab,
	browserTabId,
} from "@/stores/workspace-store";
import { useBrowserSessionStore } from "@/stores/browser-session-store";
import { useCreateSnapshot, useSnapshotLoader } from "@/hooks/use-snapshots";
import { useRecentCommandsLoader } from "@/hooks/use-recent-commands";
import { usePinnedCommandsLoader } from "@/hooks/use-pinned-commands";
import {
	useCommandHistoryLoader,
	useAddCommand,
	useCommandHistory,
	useAllCommandHistory,
} from "@/hooks/use-command-history";
import { saveTerminalLayout } from "@/hooks/useTerminalAutoSave";
import {
	filesystemApi,
	windowApi,
	keyboardApi,
	terminalApi,
	persistenceApi,
	sshApi,
} from "@/lib/api";
import {
	useKeyboardShortcutsStore,
	matchesShortcut,
} from "@/stores/keyboard-shortcuts-store";
import { isMac } from "@/lib/platform";
import {
	useTerminalFontSize,
	useDefaultShell,
	useMaxTerminalsPerProject,
	useConfirmTerminalClose,
} from "@/stores/app-settings-store";
import {
	useUpdateAppSetting,
	useUpdatePanelVisibility,
	waitForPendingAppSettingsPersistence,
} from "@/hooks/use-app-settings";
import { useFileWatcher } from "@/hooks/use-file-watcher";
import { useWorktreeShortcuts } from "@/hooks/use-worktree-shortcuts";
import { useEditorPersistence } from "@/hooks/use-editor-persistence";
import { useSSHConnection } from "@/hooks/use-ssh-connection";
import { DEFAULT_APP_SETTINGS } from "@/types/settings";
import { toast } from "sonner";
import { TitleBar } from "@/components/TitleBar";
import { ActivityRail } from "@/components/ActivityRail";
import { ResizeEdges } from "@/components/ResizeEdges";
import { resolveEnvForSpawn } from "@/lib/env-parser";
import { getDefaultCwdForProject, getActiveWorktreeForProject } from "@/lib/worktree-context";
import { spawnTerminalInPane } from "@/lib/terminal-spawn";
import { browserTabHide, browserTabShow } from "@/lib/browser-api";
import type { SFTPEntry } from "@shared/types/ssh.types";
import { SSHFileExplorer } from "@/components/ssh/SSHFileExplorer";
import { cn } from "@/lib/utils";

function getShortcutTargetContext(target: EventTarget | null): {
	isInEditor: boolean;
	isInTerminal: boolean;
	isInInput: boolean;
} {
	const element = target instanceof HTMLElement ? target : document.body;
	const isInEditor = !!(
		element.closest(".cm-content") || element.closest(".bn-editor")
	);
	const isInTerminal = !!element.closest(".xterm");
	const isInInput =
		!isInTerminal &&
		(element.tagName === "INPUT" ||
			element.tagName === "TEXTAREA" ||
			element.isContentEditable ||
			!!element.closest('[contenteditable="true"]'));

	return { isInEditor, isInTerminal, isInInput };
}

export default function WorkspaceLayout(): React.JSX.Element {
	const location = useLocation();
	const navigate = useNavigate();
	const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false);
	const hiddenBrowserTabForModalRef = useRef<string | null>(null);
	const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
	const [isShortcutMenuOpen, setIsShortcutMenuOpen] = useState(false);
	const [isCreateSnapshotModalOpen, setIsCreateSnapshotModalOpen] =
		useState(false);
	const [closeConfirmTerminal, setCloseConfirmTerminal] = useState<{
		terminalId: string;
		tabId: string;
	} | null>(null);
	const [closeConfirmLoading, setCloseConfirmLoading] = useState(false);
	const [closeConfirmRememberChoice, setCloseConfirmRememberChoice] =
		useState(false);
	const [closingTerminalIds, setClosingTerminalIds] = useState<string[]>([]);
	const [dirtyCloseFilePath, setDirtyCloseFilePath] = useState<string | null>(
		null,
	);
	const [isCommandHistoryOpen, setIsCommandHistoryOpen] = useState(false);
	const [isAppCloseDialogOpen, setIsAppCloseDialogOpen] = useState(false);
	const [appCloseDirtyCount, setAppCloseDirtyCount] = useState(0);

	const isLoaded = useProjectsLoaded();
	const confirmTerminalClose = useConfirmTerminalClose();
	const projects = useProjects();
	const activeProject = useActiveProject();
	const activeProjectId = useActiveProjectId();
	const {
		selectProject,
		addProject,
		updateProject,
		deleteProject,
		archiveProject,
		restoreProject,
		reorderProjects,
	} = useProjectActions();

	const terminals = useTerminals();
	const activeTerminal = useActiveTerminal();
	const activeTerminalId = useActiveTerminalId();
	const { addTerminal, closeTerminal, renameTerminal } = useTerminalActions();

	// File explorer & editor state
	const isExplorerVisible = useFileExplorerVisible();
	const isSidebarVisible = useSidebarVisible();

	// SSH state
	const sshProfiles = useSSHProfiles();
	const { loadProfiles: loadSSHProfiles, selectProfile: selectSSHProfile } = useSSHActions();
	const activeSSHProfileId = useActiveSSHProfileId();
	const activeSSHProfile = useActiveSSHProfile();
	const [sshPasswordPrompt, setSSHPasswordPrompt] = useState<{
		profileId: string;
		profileName: string;
	} | null>(null);
	const [sshPasswordInput, setSSHPasswordInput] = useState('');
	const [sshPromptPasswords, setSSHPromptPasswords] = useState<Record<string, string>>({});

	const sshProfileWithPassword = activeSSHProfile ? {
		...activeSSHProfile,
		password: sshPromptPasswords[activeSSHProfile.id] ?? activeSSHProfile.password,
	} : null;

	const sshConn = useSSHConnection(sshProfileWithPassword);

	const handleSSHMkdir = useCallback(async () => {
		if (!sshConn.connectionId) return;
		const name = prompt('New folder name:');
		if (!name) return;
		const newPath = sshConn.currentPath.endsWith('/') ? `${sshConn.currentPath}${name}` : `${sshConn.currentPath}/${name}`;
		try {
			const r = await sshApi.sftpMkdir(sshConn.connectionId, newPath);
			if (r.success) { toast.success(`Created: ${name}`); sshConn.loadDirectory(sshConn.currentPath); }
			else toast.error(`Failed: ${r.error}`);
		} catch (error) {
			toast.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- specific sshConn fields cover all usage
	}, [sshConn.connectionId, sshConn.currentPath, sshConn.loadDirectory]);

	const handleSSHCreateFile = useCallback(async () => {
		if (!sshConn.connectionId) return;
		const name = prompt('New file name:');
		if (!name) return;
		const newPath = sshConn.currentPath.endsWith('/') ? `${sshConn.currentPath}${name}` : `${sshConn.currentPath}/${name}`;
		try {
			const r = await sshApi.sftpCreateFile(sshConn.connectionId, newPath);
			if (r.success) { toast.success(`Created: ${name}`); sshConn.loadDirectory(sshConn.currentPath); }
			else toast.error(`Failed: ${r.error}`);
		} catch (error) {
			toast.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- specific sshConn fields cover all usage
	}, [sshConn.connectionId, sshConn.currentPath, sshConn.loadDirectory]);

	const handleSSHDelete = useCallback(async (entry: SFTPEntry) => {
		if (!sshConn.connectionId) return;
		if (!confirm(`Delete ${entry.entryType} "${entry.name}"?`)) return;
		try {
			const r = await sshApi.sftpDelete(sshConn.connectionId, entry.path);
			if (r.success) { toast.success(`Deleted: ${entry.name}`); sshConn.loadDirectory(sshConn.currentPath); }
			else toast.error(`Delete failed: ${r.error}`);
		} catch (error) {
			toast.error(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- specific sshConn fields cover all usage
	}, [sshConn.connectionId, sshConn.currentPath, sshConn.loadDirectory]);

	const handleSSHRename = useCallback(async (entry: SFTPEntry) => {
		if (!sshConn.connectionId) return;
		const newName = prompt(`Rename "${entry.name}" to:`, entry.name);
		if (!newName || newName === entry.name) return;
		const pp = entry.path.substring(0, entry.path.lastIndexOf('/'));
		try {
			const r = await sshApi.sftpRename(sshConn.connectionId, entry.path, `${pp}/${newName}`);
			if (r.success) { toast.success(`Renamed: ${entry.name} → ${newName}`); sshConn.loadDirectory(sshConn.currentPath); }
			else toast.error(`Rename failed: ${r.error}`);
		} catch (error) {
			toast.error(`Rename failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- specific sshConn fields cover all usage
	}, [sshConn.connectionId, sshConn.currentPath, sshConn.loadDirectory]);

	// Load SSH profiles on mount
	useEffect(() => {
		loadSSHProfiles();
	}, [loadSSHProfiles]);

	// Reconcile real SSH connection status from the backend (heartbeat,
	// reconnect, failure). Without this the badge can only ever show the
	// optimistic state set at connect time.
	useEffect(() => {
		if (typeof sshApi?.onConnectionStatusChanged !== 'function') return;
		const unlisten = sshApi.onConnectionStatusChanged((connectionId, status, error) => {
			useSSHStore.getState().updateConnectionStatus(connectionId, status, error);
		});
		return () => { unlisten?.(); };
	}, []);

	const handleSelectSSHProfile = useCallback((profileId: string) => {
		selectSSHProfile(profileId);
	}, [selectSSHProfile]);

	const handleSelectProject = useCallback((id: string) => {
		selectProject(id);
		selectSSHProfile(null); // Deselect SSH when switching to project
	}, [selectProject, selectSSHProfile]);
	const activeTab = useActiveTab();
	const paneRoot = usePaneRoot();
	const fullscreenPaneId = useFullscreenPaneId();
	const fullscreenPane = useMemo(() => {
		if (!fullscreenPaneId) return null;
		const pane = findPaneById(paneRoot, fullscreenPaneId);
		return pane?.type === "leaf" ? pane : null;
	}, [fullscreenPaneId, paneRoot]);
	const prevProjectIdRef = useRef<string>("");
	const watchedRootPathRef = useRef<string | null>(null);
	const projectSwitchRequestIdRef = useRef(0);

	// Ref for terminal close handler — used inside keydown effect to avoid
	// declaration-order dependency. The ref is updated each render.
	const handleCloseTerminalRef = useRef<((id: string, tabId: string) => void) | null>(null);

	// File watcher hook
	useFileWatcher();

	useEffect(() => {
		const persistBeforeUnload = () => {
			if (!activeProjectId) return;
			void saveTerminalLayout(activeProjectId).catch((error) => {
				console.warn("Failed to persist terminal layout before reload:", error);
			});
		};

		window.addEventListener("beforeunload", persistBeforeUnload);
		window.addEventListener("pagehide", persistBeforeUnload);

		return () => {
			window.removeEventListener("beforeunload", persistBeforeUnload);
			window.removeEventListener("pagehide", persistBeforeUnload);
		};
	}, [activeProjectId]);

	// Worktree shortcut handlers
	useWorktreeShortcuts();

	// Sync file explorer root path and register project root watcher when project changes
	useEffect(() => {
		const nextRootPathCandidate = activeProject?.path;
		if (
			!activeProject ||
			typeof nextRootPathCandidate !== "string" ||
			nextRootPathCandidate === ""
		) {
			// Project removed or has no path — clear explorer root and unwatch
			useFileExplorerStore.getState().setRootPath("");
			if (watchedRootPathRef.current) {
				filesystemApi.unwatchDirectory(watchedRootPathRef.current);
				watchedRootPathRef.current = null;
			}
			prevProjectIdRef.current = activeProjectId;
			return;
		}
		if (activeProjectId === prevProjectIdRef.current) {
			return;
		}

		const nextRootPath = nextRootPathCandidate;

		const switchRequestId = ++projectSwitchRequestIdRef.current;
		const previousWatchedRoot = watchedRootPathRef.current;

		let cancelled = false;

		async function applyProjectSwitch(): Promise<void> {
			try {
				const watchResult = await filesystemApi.watchDirectory(nextRootPath);

				if (
					cancelled ||
					switchRequestId !== projectSwitchRequestIdRef.current
				) {
					filesystemApi.unwatchDirectory(nextRootPath);
					return;
				}

				if (!watchResult.success) {
					useFileExplorerStore.getState().setRootPath(nextRootPath);
					useFileExplorerStore.getState().setRootLoadError({
						message: watchResult.error,
						code: watchResult.code,
					});
					return;
				}

				useFileExplorerStore.getState().setRootPath(nextRootPath);

				if (previousWatchedRoot && previousWatchedRoot !== nextRootPath) {
					filesystemApi.unwatchDirectory(previousWatchedRoot);
				}

				watchedRootPathRef.current = nextRootPath;
				prevProjectIdRef.current = activeProjectId;
			} catch (error) {
				if (
					cancelled ||
					switchRequestId !== projectSwitchRequestIdRef.current
				) {
					return;
				}

				const message =
					error instanceof Error
						? error.message
						: "Failed to watch project directory";
				useFileExplorerStore.getState().setRootPath(nextRootPath);
				useFileExplorerStore.getState().setRootLoadError({
					message,
					code: "WATCH_FAILED",
				});
			}
		}

		void applyProjectSwitch();

		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- activeProject?.path covers the only property used
	}, [activeProject?.path, activeProjectId]);

	// Editor state persistence
	useEditorPersistence(activeProjectId);

	useEffect(() => {
		return () => {
			if (watchedRootPathRef.current) {
				filesystemApi.unwatchDirectory(watchedRootPathRef.current);
			}
		};
	}, []);

	// Ensure tabs exist for currently visible project terminals.
	// Project workspace loading/removal is owned by persistence + restore flows.
	const ensureCallCountRef = useRef(0);
	const lastEnsuredTerminalIdsRef = useRef<string[]>([]);
	const lastEnsuredProjectIdRef = useRef<string>("");

	useEffect(() => {
		const terminalIds = terminals.map((terminal) => terminal.id);

		// If we switched projects, we should wait for the persistence layer (useEditorPersistence)
		// to finish its job of replacing the entire workspace tree.
		// Forcing a sync on the WRONG tree (the old project's tree) causes "leaking" tabs.
		if (activeProjectId !== lastEnsuredProjectIdRef.current) {
			lastEnsuredTerminalIdsRef.current = terminalIds;
			lastEnsuredProjectIdRef.current = activeProjectId;
			// We skip the sync here because useEditorPersistence will handle the initial layout.
			return;
		}

		const prevIds = lastEnsuredTerminalIdsRef.current;
		if (
			terminalIds.length === prevIds.length &&
			terminalIds.every((id, i) => id === prevIds[i])
		) {
			return;
		}

		const ensureId = `ensure-${ensureCallCountRef.current++}-${Date.now().toString().slice(-6)}`;

		console.log(`[WorkspaceLayout] syncTerminalTabs CALL [${ensureId}]`, {
			projectId: activeProjectId,
			terminalCount: terminalIds.length,
			terminalIds,
			prevCount: prevIds.length,
			callCount: ensureCallCountRef.current,
		});

		lastEnsuredTerminalIdsRef.current = terminalIds;
		const workspaceStore = useWorkspaceStore.getState();
		workspaceStore.syncTerminalTabs(terminalIds);
	}, [terminals, activeProjectId]);

	// Sync legacy stores (activeTerminalId, activeFilePath) from workspace pane tree
	useEffect(() => {
		return useWorkspaceStore.subscribe((state, prevState) => {
			if (
				state.root === prevState.root &&
				state.activePaneId === prevState.activePaneId
			)
				return;

			const terminalId = getActiveTerminalIdFromTree(state);
			if (terminalId !== null) {
				const termStore = useTerminalStore.getState();
				if (termStore.activeTerminalId !== terminalId) {
					termStore.selectTerminal(terminalId);
				}
			}

			const filePath = getActiveFilePathFromTree(state);
			const editorStore = useEditorStore.getState();
			if (editorStore.activeFilePath !== filePath) {
				editorStore.setActiveFilePath(filePath);
			}
		});
	}, []);

	const closeAppWithPersistenceFlush = useCallback(async () => {
		try {
			const [pendingAppSettingsResult, pendingPersistenceResult] =
				await Promise.allSettled([
					waitForPendingAppSettingsPersistence(),
					persistenceApi.flushPendingWrites(),
				]);

			if (pendingAppSettingsResult.status === "rejected") {
				console.error(
					"Failed to wait for app settings persistence before close:",
					pendingAppSettingsResult.reason,
				);
			}

			if (pendingPersistenceResult.status === "fulfilled") {
				if (!pendingPersistenceResult.value.success) {
					console.error(
						"Failed to flush pending persistence writes before close:",
						pendingPersistenceResult.value.error,
					);
				}
			} else {
				console.error(
					"Failed to flush pending persistence writes before close:",
					pendingPersistenceResult.reason,
				);
			}
		} finally {
			windowApi.respondToClose("close");
			setIsAppCloseDialogOpen(false);
		}
	}, []);

	// Intercept app close to check for unsaved files
	useEffect(() => {
		return windowApi.onCloseRequested(() => {
			const dirtyCount = useEditorStore.getState().getDirtyFileCount();
			if (dirtyCount > 0) {
				setAppCloseDirtyCount(dirtyCount);
				setIsAppCloseDialogOpen(true);
			} else {
				void closeAppWithPersistenceFlush();
			}

			return Promise.resolve(false);
		});
	}, [closeAppWithPersistenceFlush]);

	// Load snapshots when project changes
	useSnapshotLoader();
	// Load recent commands for command palette
	useRecentCommandsLoader();
	// Load pinned commands for command palette
	usePinnedCommandsLoader();
	// Load command history for current project
	useCommandHistoryLoader(activeProjectId);
	const addCommand = useAddCommand();
	const commandHistory = useCommandHistory(activeProjectId);
	const allCommandHistory = useAllCommandHistory();
	const createSnapshot = useCreateSnapshot();

	const handleCreateSnapshot = useCallback(
		async (name: string, description?: string) => {
			await createSnapshot(name, description);
		},
		[createSnapshot],
	);

	const handleOpenSnapshotModal = useCallback(() => {
		setIsCommandPaletteOpen(false);
		setIsCreateSnapshotModalOpen(true);
	}, []);

	// Keyboard shortcuts
	const shortcuts = useKeyboardShortcutsStore((state) => state.shortcuts);
	const handleOpenProjectSettings = useCallback(() => {
		setIsCommandPaletteOpen(false);
		navigate("/settings");
	}, [navigate]);

	const handleOpenAppPreferences = useCallback(() => {
		setIsCommandPaletteOpen(false);
		navigate("/preferences");
	}, [navigate]);

	const handleOpenCommandHistory = useCallback(() => {
		setIsCommandPaletteOpen(false);
		setIsCommandHistoryOpen(true);
	}, []);

	const handleOpenShortcutMenu = useCallback(() => {
		setIsCommandPaletteOpen(false);
		setIsShortcutMenuOpen(true);
	}, []);

	// SSH - just select profile (SSH workspace handles its own connect/terminal)
	const handleSSHConnect = useCallback((profileId: string) => {
		const profile = sshProfiles.find((p) => p.id === profileId);
		if (!profile) return;

		if (profile.authMethod === 'password' && !profile.hasStoredPassword) {
			// No password in OS keychain — show password prompt
			setSSHPasswordPrompt({ profileId, profileName: profile.name });
			setSSHPasswordInput('');
		} else {
			// Select profile → SSH workspace handles connect
			selectSSHProfile(profileId);
		}
	}, [sshProfiles, selectSSHProfile]);

	const handleSSHPasswordSubmit = useCallback(() => {
		if (!sshPasswordPrompt) return;
		const password = sshPasswordInput;
		setSSHPromptPasswords((prev) => ({
			...prev,
			[sshPasswordPrompt.profileId]: password,
		}));
		setSSHPasswordPrompt(null);
		setSSHPasswordInput('');
		selectSSHProfile(sshPasswordPrompt.profileId);
	}, [sshPasswordPrompt, sshPasswordInput, selectSSHProfile]);

	const getShortcutLabel = useCallback((id: string): string | undefined => {
		const shortcut = shortcuts[id];
		return shortcut ? shortcut.customKey ?? shortcut.defaultKey : undefined;
	}, [shortcuts]);

	const getProjectShortcutLabel = useCallback((index: number): string | undefined => {
		const shortcut = shortcuts[`project-${index + 1}`];
		return shortcut ? shortcut.customKey ?? shortcut.defaultKey : undefined;
	}, [shortcuts]);
	const fontSize = useTerminalFontSize();
	const appDefaultShell = useDefaultShell();
	const maxTerminals = useMaxTerminalsPerProject();
	const updateAppSetting = useUpdateAppSetting();
	const updatePanelVisibility = useUpdatePanelVisibility();

	// Helper to get active key for a shortcut
	const getActiveKey = useCallback(
		(id: string): string => {
			const shortcut = shortcuts[id];
			return shortcut?.customKey ?? shortcut?.defaultKey ?? "";
		},
		[shortcuts],
	);

	// Determine if we should show the terminal area (only on workspace dashboard)
	const isWorkspaceRoute = location.pathname === "/";

	// Unified tab cycling - cycles through ALL workspace tabs in active pane
	const cycleTab = useCallback(
		(direction: "next" | "prev") => {
			if (!isWorkspaceRoute) return;
			const store = useWorkspaceStore.getState();
			const nextTabId = store.getNextTabId(direction === "next" ? 1 : -1);
			if (nextTabId) {
				store.setActiveTab(store.activePaneId, nextTabId);
			}
		},
		[isWorkspaceRoute],
	);

	// Terminal creation callbacks - defined before keyboard shortcut useEffect
	const handleCreateTerminalInPane = useCallback(
		async (paneId: string, shellName?: string) => {
			const cwd = getDefaultCwdForProject(activeProjectId);

			const result = await spawnTerminalInPane(paneId, activeProjectId, cwd, {
				shell: shellName || activeProject?.defaultShell || appDefaultShell || undefined,
				envVars: activeProject?.envVars,
				maxTerminalsPerProject: maxTerminals,
			});
			if (!result.success) {
				toast.error(result.error || "Failed to create terminal");
			}
		},
		[
			activeProject?.defaultShell,
			activeProject?.envVars,
			activeProjectId,
			appDefaultShell,
			maxTerminals,
		],
	);

	const handleNewTerminal = useCallback(() => {
		const paneId = useWorkspaceStore.getState().activePaneId;
		handleCreateTerminalInPane(paneId);
	}, [handleCreateTerminalInPane]);

	const handleAddTerminal = useCallback((paneId: string | undefined, shell?: ShellInfo) => {
		const targetPaneId = paneId ?? useWorkspaceStore.getState().activePaneId;
		if (!targetPaneId) return;
		if (shell) {
			handleCreateTerminalInPane(targetPaneId, shell.path);
		} else {
			handleCreateTerminalInPane(targetPaneId);
		}
	}, [handleCreateTerminalInPane]);

	const handleNewBrowserTab = useCallback((paneId?: string) => {
		const resolvedPaneId = paneId ?? useWorkspaceStore.getState().activePaneId;
		if (resolvedPaneId) {
			const browserTabId = crypto.randomUUID();
			useBrowserSessionStore.getState().createTab(browserTabId);
			useWorkspaceStore.getState().addBrowserTab(browserTabId, resolvedPaneId);
		}
	}, []);

	const handleAddGitTab = useCallback((paneId?: string) => {
		const resolvedPaneId = paneId ?? useWorkspaceStore.getState().activePaneId;
		if (resolvedPaneId && activeProject?.path) {
			useWorkspaceStore.getState().addTabToPane(resolvedPaneId, {
				type: "git",
				id: `git-${crypto.randomUUID()}`,
				cwd: activeProject.path,
			});
		}
	}, [activeProject?.path]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Safety net: skip workspace handling when an earlier handler has already
			// processed this event by calling preventDefault() — e.g. xterm clipboard
			// ops or ConnectedTerminal's customKeyEventHandler for terminal-owned keys.
			if (e.defaultPrevented) return;

			const { isInEditor, isInTerminal, isInInput } =
				getShortcutTargetContext(e.target);

			// Save File (Ctrl+S / ⌘+S) — should work even in editors
			if (matchesShortcut(e, getActiveKey("saveFile"))) {
				e.preventDefault();
				if (activeTab?.type === "editor") {
					useEditorStore.getState().saveFile(activeTab.filePath);
				}
				return;
			}

			// Close Tab (Ctrl+W / ⌘+W)
			// On macOS: ⌘+W closes tab, Ctrl+W is forwarded to shell (backward-kill-word)
			// On Windows/Linux: Ctrl+W closes tab
			if (matchesShortcut(e, getActiveKey("closeTab"))) {

				e.preventDefault();
				if (activeTab?.type === "editor") {
					const fileState = useEditorStore
						.getState()
						.openFiles.get(activeTab.filePath);
					if (fileState?.isDirty) {
						setDirtyCloseFilePath(activeTab.filePath);
					} else {
						const didClose = useEditorStore.getState().closeFileIfIdle(activeTab.filePath);
						if (didClose) {
							useWorkspaceStore.getState().removeTab(activeTab.id);
						}
					}
				} else if (activeTab?.type === "git") {
					useWorkspaceStore.getState().removeTab(activeTab.id);
				} else if (activeTab?.type === "terminal") {
					handleCloseTerminalRef.current?.(activeTab.terminalId, activeTab.id);
				} else if (activeTab?.type === "browser") {
					useBrowserSessionStore.getState().removeTab(activeTab.browserTabId);
					useWorkspaceStore.getState().removeTab(activeTab.id);
				}
				return;
			}

			// Toggle File Explorer (Ctrl+B / ⌘+B) — skip when in editor/input/terminal
			if (matchesShortcut(e, getActiveKey("toggleFileExplorer"))) {
				if (!isInEditor && !isInInput && !isInTerminal) {
					e.preventDefault();
					void updatePanelVisibility(
						"fileExplorerVisible",
						!isExplorerVisible,
					).catch((error) => {
						toast.error(
							error instanceof Error
								? error.message
								: "Failed to update file explorer visibility",
						);
					});
				}
				return;
			}

			if (matchesShortcut(e, getActiveKey("sidebarToggle"))) {
				if (!isInEditor && !isInInput) {
					e.preventDefault();
					e.stopPropagation();
					void updatePanelVisibility("sidebarVisible", !isSidebarVisible).catch(
						(error) => {
							toast.error(
								error instanceof Error
									? error.message
									: "Failed to update sidebar visibility",
							);
						},
					);
				}
				return;
			}

			// ── Global shortcuts — work from any focus context ────────────────
			// These must be checked before the isInInput/isInEditor guard.
			// They open overlays or perform workspace actions that should be
			// reachable while typing in the editor, browser, or terminal.

			// Command palette (Ctrl+K / Ctrl+Shift+P)
			if (matchesShortcut(e, getActiveKey("commandPalette")) || matchesShortcut(e, getActiveKey("commandPaletteAlt"))) {
				e.preventDefault();
				e.stopPropagation();
				if (document.activeElement instanceof HTMLElement) {
					document.activeElement.blur();
				}
				setIsCommandPaletteOpen(true);
				return;
			}

			// Command history (Ctrl+R)
			if (matchesShortcut(e, getActiveKey("commandHistory"))) {
				e.preventDefault();
				e.stopPropagation();
				if (activeProjectId) {
					if (document.activeElement instanceof HTMLElement) {
						document.activeElement.blur();
					}
					setIsCommandHistoryOpen(true);
				}
				return;
			}

			// New project (Ctrl+N)
			if (matchesShortcut(e, getActiveKey("newProject"))) {
				e.preventDefault();
				e.stopPropagation();
				if (document.activeElement instanceof HTMLElement) {
					document.activeElement.blur();
				}
				setIsNewProjectModalOpen(true);
				return;
			}

			// New terminal (Ctrl+T) - workspace only
			if (matchesShortcut(e, getActiveKey("newTerminal"))) {
				if (!isWorkspaceRoute) return;
				e.preventDefault();
				e.stopPropagation();
				if (terminals.length >= maxTerminals) {
					toast.error(`Maximum ${maxTerminals} terminals per project`);
					return;
				}
				const paneId = useWorkspaceStore.getState().activePaneId;
				handleCreateTerminalInPane(paneId);
				return;
			}

			// New browser tab (Ctrl+Shift+N) - workspace only
			if (matchesShortcut(e, getActiveKey("newBrowserTab"))) {
				if (!isWorkspaceRoute) return;
				e.preventDefault();
				e.stopPropagation();
				handleNewBrowserTab();
				return;
			}

			// Tab cycling (Ctrl+PageDown / Ctrl+PageUp)
			if (matchesShortcut(e, getActiveKey("nextTerminal"))) {
				e.preventDefault();
				e.stopPropagation();
				cycleTab("next");
				return;
			}
			if (matchesShortcut(e, getActiveKey("prevTerminal"))) {
				e.preventDefault();
				e.stopPropagation();
				cycleTab("prev");
				return;
			}

			// Zoom in/out/reset
			if (matchesShortcut(e, getActiveKey("zoomIn"))) {
				e.preventDefault();
				e.stopPropagation();
				const newSize = Math.min(fontSize + 1, 24);
				if (newSize !== fontSize) updateAppSetting("terminalFontSize", newSize);
				return;
			}
			if (matchesShortcut(e, getActiveKey("zoomOut"))) {
				e.preventDefault();
				e.stopPropagation();
				const newSize = Math.max(fontSize - 1, 10);
				if (newSize !== fontSize) updateAppSetting("terminalFontSize", newSize);
				return;
			}
			if (matchesShortcut(e, getActiveKey("zoomReset"))) {
				e.preventDefault();
				e.stopPropagation();
				if (fontSize !== DEFAULT_APP_SETTINGS.terminalFontSize) {
					updateAppSetting("terminalFontSize", DEFAULT_APP_SETTINGS.terminalFontSize);
				}
				return;
			}

			// Cmd/Ctrl + 1-9 for project switching
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
				e.preventDefault();
				const index = parseInt(e.key) - 1;
				if (projects[index]) selectProject(projects[index].id);
				return;
			}

			// ── Below this: only runs when NOT in input/editor ────────────────
			// Terminal search (Ctrl+F) - handled at pane level
			if (matchesShortcut(e, getActiveKey("terminalSearch"))) {
				if (isWorkspaceRoute) {
					e.preventDefault();
					e.stopPropagation();
				}
				return;
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		projects,
		selectProject,
		addTerminal,
		terminals,
		activeProjectId,
		activeProject,
		activeTerminalId,
		activeTerminal,
		getActiveKey,
		fontSize,
		updateAppSetting,
		appDefaultShell,
		maxTerminals,
		isWorkspaceRoute,
		cycleTab,
		activeTab,
		handleCreateTerminalInPane,
		handleNewBrowserTab,
		updatePanelVisibility,
		isExplorerVisible,
		isSidebarVisible,
	]);

	useEffect(() => {
		if (isNewProjectModalOpen) {
			if (activeTab?.type === "browser") {
				hiddenBrowserTabForModalRef.current = activeTab.browserTabId;
				browserTabHide(activeTab.browserTabId).catch(console.error);
			}
			return;
		}

		const hiddenBrowserTabId = hiddenBrowserTabForModalRef.current;
		if (hiddenBrowserTabId) {
			browserTabShow(hiddenBrowserTabId).catch(console.error);
			hiddenBrowserTabForModalRef.current = null;
		}
	}, [isNewProjectModalOpen, activeTab]);

	// Listen for optional backend shortcut callbacks. In current Tauri fallback mode this is effectively a future-compat shim.
	useEffect(() => {
		return keyboardApi.onShortcut((shortcut) => {
			switch (shortcut) {
				case "nextTerminal":
					cycleTab("next");
					break;
				case "prevTerminal":
					cycleTab("prev");
					break;
				case "zoomIn": {
					const newSize = Math.min(fontSize + 1, 24);
					if (newSize !== fontSize) {
						updateAppSetting("terminalFontSize", newSize);
					}
					break;
				}
				case "zoomOut": {
					const newSize = Math.max(fontSize - 1, 10);
					if (newSize !== fontSize) {
						updateAppSetting("terminalFontSize", newSize);
					}
					break;
				}
				case "zoomReset":
					if (fontSize !== DEFAULT_APP_SETTINGS.terminalFontSize) {
						updateAppSetting(
							"terminalFontSize",
							DEFAULT_APP_SETTINGS.terminalFontSize,
						);
					}
					break;
				case "sidebarToggle":
					void updatePanelVisibility("sidebarVisible", !isSidebarVisible).catch(
						(error) => {
							toast.error(
								error instanceof Error
									? error.message
									: "Failed to update sidebar visibility",
							);
						},
					);
					break;
			}
		});
	}, [
		cycleTab,
		fontSize,
		updateAppSetting,
		updatePanelVisibility,
		isSidebarVisible,
	]);

	const closeTerminalByRecordId = useCallback(
		async (terminalRecordId: string): Promise<boolean> => {
			const terminalToClose = useTerminalStore
				.getState()
				.terminals.find((t) => t.id === terminalRecordId);

			if (!terminalToClose) {
				return false;
			}

			if (closingTerminalIds.includes(terminalRecordId)) {
				return false;
			}

			setClosingTerminalIds((current) => [...current, terminalRecordId]);

			try {
				if (terminalToClose.ptyId) {
					const result = await terminalApi.kill(terminalToClose.ptyId);
					if (!result.success) {
						console.error("Failed to close terminal PTY:", result.error);
						toast.error(
							result.error ||
								"Failed to close terminal process. Please try again.",
						);
						return false;
					}
				}

				closeTerminal(terminalRecordId, activeProjectId);
				return true;
			} finally {
				setClosingTerminalIds((current) =>
					current.filter((id) => id !== terminalRecordId),
				);
			}
		},
		[activeProjectId, closeTerminal, closingTerminalIds],
	);

	const closeTerminalTabByTabId = useCallback(
		async (tabId: string): Promise<boolean> => {
			const root = useWorkspaceStore.getState().root;
			const containingPane = findPaneContainingTab(root, tabId);
			if (!containingPane) {
				return false;
			}

			const tab = containingPane.tabs.find((t) => t.id === tabId);
			if (!tab || tab.type !== "terminal") {
				return false;
			}

			const didClose = await closeTerminalByRecordId(tab.terminalId);
			if (!didClose) {
				return false;
			}
			useWorkspaceStore.getState().closeTab(containingPane.id, tabId);
			return true;
		},
		[closeTerminalByRecordId],
	);

	const handleCloseTerminal = useCallback(
		(id: string, tabId: string) => {
			if (closingTerminalIds.includes(id)) {
				return;
			}

			if (!confirmTerminalClose) {
				void closeTerminalTabByTabId(tabId);
				return;
			}

			setCloseConfirmRememberChoice(false);
			setCloseConfirmTerminal({ terminalId: id, tabId });
		},
		[closeTerminalTabByTabId, closingTerminalIds, confirmTerminalClose],
	);

	// Keep ref in sync so the keydown effect can call it without declaration-order issues
	handleCloseTerminalRef.current = handleCloseTerminal;

	const handleConfirmCloseTerminal = useCallback(async () => {
		if (!closeConfirmTerminal) {
			return;
		}

		setCloseConfirmLoading(true);
		try {
			if (closeConfirmRememberChoice) {
				await updateAppSetting("confirmTerminalClose", false);
			}

			const didClose = await closeTerminalTabByTabId(
				closeConfirmTerminal.tabId,
			);
			if (didClose) {
				setCloseConfirmTerminal(null);
				setCloseConfirmRememberChoice(false);
			}
		} finally {
			setCloseConfirmLoading(false);
		}
	}, [
		closeConfirmRememberChoice,
		closeConfirmTerminal,
		closeTerminalTabByTabId,
		updateAppSetting,
	]);

	const handleCancelCloseTerminal = useCallback(() => {
		if (closeConfirmLoading) {
			return;
		}

		setCloseConfirmRememberChoice(false);
		setCloseConfirmTerminal(null);
	}, [closeConfirmLoading]);

	// Dirty file close handlers
	const handleCloseEditorTab = useCallback((filePath: string) => {
		const fileState = useEditorStore.getState().openFiles.get(filePath);
		if (fileState?.operationStatus === "saving" || fileState?.operationStatus === "reloading") {
			return;
		}
		if (fileState?.isDirty) {
			setDirtyCloseFilePath(filePath);
		} else {
			useEditorStore.getState().closeFileIfIdle(filePath);
			useWorkspaceStore.getState().removeTab(editorTabId(filePath));
		}
	}, []);

	const handleSaveThenClose = useCallback(async () => {
		if (dirtyCloseFilePath) {
			const saved = await useEditorStore
				.getState()
				.saveFile(dirtyCloseFilePath);
			if (!saved) {
				toast.error("Failed to save file. Changes were not discarded.");
				setDirtyCloseFilePath(null);
				return;
			}
			useEditorStore.getState().closeFileIfIdle(dirtyCloseFilePath);
			useWorkspaceStore.getState().removeTab(editorTabId(dirtyCloseFilePath));
			setDirtyCloseFilePath(null);
		}
	}, [dirtyCloseFilePath]);

	const handleDiscardAndClose = useCallback(() => {
		if (dirtyCloseFilePath) {
			useEditorStore.getState().closeFileIfIdle(dirtyCloseFilePath);
			useWorkspaceStore.getState().removeTab(editorTabId(dirtyCloseFilePath));
			setDirtyCloseFilePath(null);
		}
	}, [dirtyCloseFilePath]);

	const handleCancelDirtyClose = useCallback(() => {
		setDirtyCloseFilePath(null);
	}, []);

	// App close dialog handlers
	const handleSaveAllAndClose = useCallback(async () => {
		await useEditorStore.getState().saveAllDirty();
		const remaining = useEditorStore.getState().getDirtyFileCount();
		if (remaining > 0) {
			toast.error(
				"Some files failed to save. Please try again or discard changes.",
			);
			return;
		}
		await closeAppWithPersistenceFlush();
	}, [closeAppWithPersistenceFlush]);

	const handleDiscardAllAndClose = useCallback(() => {
		void closeAppWithPersistenceFlush();
	}, [closeAppWithPersistenceFlush]);

	const handleCancelAppClose = useCallback(() => {
		windowApi.respondToClose("cancel");
		setIsAppCloseDialogOpen(false);
	}, []);

	// Command history handlers
	const handleInsertCommand = useCallback(
		(command: string) => {
			// TODO: Route to active terminal pane via context
			if (activeTerminal?.ptyId) {
				terminalApi.write(activeTerminal.ptyId, command);
			}
		},
		[activeTerminal],
	);

	const handleClearCommandHistory = useCallback(async () => {
		if (!activeProjectId) return;
		// Persist empty array first, then clear in-memory on success
		const result = await persistenceApi.write(
			`projects/${activeProjectId}/command-history`,
			[],
		);
		if (!result.success) {
			toast.error(`Failed to clear history: ${result.error}`);
			throw new Error(result.error);
		}
		// Only clear in-memory state after successful persistence
		const { clearHistory } = useCommandHistoryStore.getState();
		clearHistory(activeProjectId);
	}, [activeProjectId]);

	const terminalToClose = terminals.find(
		(t) => t.id === closeConfirmTerminal?.terminalId,
	);

	// Show loading state while projects are being loaded
	if (!isLoaded) {
		return (
			<div className="h-screen flex flex-col overflow-hidden bg-background">
				<ResizeEdges />
				<div className="flex-1 flex overflow-hidden min-h-0 h-full">
					<ActivityRail
						isShortcutsOpen={isShortcutMenuOpen}
						onShortcutsOpenChange={setIsShortcutMenuOpen}
						onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
						canOpenGitChanges={false}
					/>
					<div className="flex-1 flex flex-col min-w-0">
						{/* macOS: draggable band clearing native traffic lights over the content column */}
						{isMac && <div className="h-7 shrink-0" data-tauri-drag-region />}
						<TitleBar />
						<div className="flex-1 flex items-center justify-center">
							<div className="text-muted-foreground text-sm">Loading...</div>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="h-screen flex flex-col overflow-hidden bg-background">
			<ResizeEdges />
			<div className="flex-1 flex overflow-hidden min-h-0 h-full">
				<ActivityRail
					isShortcutsOpen={isShortcutMenuOpen}
					onShortcutsOpenChange={setIsShortcutMenuOpen}
					onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
					onOpenGitChanges={() => handleAddGitTab()}
					canOpenGitChanges={Boolean(activeProject?.path)}
				/>
				<div className="flex-1 flex flex-col min-w-0">
					{/* macOS: draggable band clearing native traffic lights over the content column */}
					{isMac && <div className="h-7 shrink-0" data-tauri-drag-region />}
					<TitleBar />

					<div className="flex-1 flex overflow-hidden min-h-0 h-full p-2 gap-0">
				{/* Sidebar */}
				{isSidebarVisible && (
					<div className="mr-2">
						<ProjectSidebar
							projects={projects}
							activeProjectId={activeProjectId}
							onSelectProject={handleSelectProject}
							onNewProject={() => setIsNewProjectModalOpen(true)}
							onUpdateProject={updateProject}
							onDeleteProject={deleteProject}
							onArchiveProject={archiveProject}
							onRestoreProject={restoreProject}
							onReorderProjects={reorderProjects}
							onSSHConnect={handleSSHConnect}
							onSelectSSHProfile={handleSelectSSHProfile}
							activeSSHProfileId={activeSSHProfileId}
						/>
					</div>
				)}

				{/* Main Content and File Explorer Container */}
				<PaneDndProvider>
					<div className="flex-1 flex min-h-0 h-full gap-0 overflow-hidden min-w-0">
						{/* Main Content Area */}
						<main className="flex-1 flex flex-col min-w-0 rounded-xl bg-card overflow-hidden">
							{activeSSHProfile ? (
								/* SSH Workspace */
								<SSHWorkspace
									profile={sshProfileWithPassword!}
									conn={sshConn}
								/>
							) : projects.length === 0 ? (
								/* No Projects Empty State */
								<div className="flex-1 flex flex-col items-center justify-center bg-background px-6 rounded-xl">
									<motion.div
										initial={{ opacity: 0, scale: 0.9 }}
										animate={{ opacity: 1, scale: 1 }}
										transition={{ duration: 0.4, ease: "easeOut" }}
										className="flex flex-col items-center text-center max-w-md"
									>
										<div className="mb-6">
											<FolderKanban className="w-24 h-24 text-muted-foreground/50" />
										</div>
										<h2 className="text-xl font-semibold text-foreground mb-2">
											No Projects Yet
										</h2>
										<p className="text-muted-foreground text-sm mb-6 leading-relaxed">
											Create your first project to organize your terminals,
											snapshots, and commands
										</p>
										<button
											onClick={() => setIsNewProjectModalOpen(true)}
											className="px-6 py-2.5 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-colors text-sm font-medium shadow-sm hover:shadow"
										>
											Create Your First Project
										</button>
									</motion.div>
								</div>
							) : (
								<>
									{isWorkspaceRoute ? (
										<motion.div
										key={fullscreenPaneId ? "fullscreen" : "normal"}
										initial={{ opacity: 0.85, scale: 0.97 }}
										animate={{ opacity: 1, scale: 1 }}
										transition={{ duration: 0.2, ease: "easeOut" }}
										className="flex-1 min-h-0 h-full overflow-hidden"
									>
											<PaneRenderer
												node={fullscreenPane ?? paneRoot}
												onAddTerminal={handleAddTerminal}
												onAddBrowserTab={handleNewBrowserTab}
												onCloseTerminal={handleCloseTerminal}
												onRenameTerminal={renameTerminal}
												onCloseEditorTab={handleCloseEditorTab}
												closingTerminalIds={closingTerminalIds}
												defaultShell={
													activeProject?.defaultShell || appDefaultShell
												}
											/>
										</motion.div>
									) : (
										<div className="flex-1 overflow-hidden bg-background relative rounded-xl">
											<div className="w-full h-full">
												<Outlet />
											</div>
										</div>
									)}

									{/* Status Bar */}
									<StatusBar project={activeProject} />
								</>
							)}
						</main>

						{/* File Explorer - separate floating panel */}
						{(isExplorerVisible && activeProject?.path) || activeSSHProfile ? (
							<div className="flex-shrink-0 ml-2 flex flex-col gap-2 h-full">
								{isExplorerVisible && activeProject?.path && (
									<div className={activeSSHProfile ? "flex-1 min-h-0" : "h-full"}>
										<FileExplorer side="right" />
									</div>
								)}
								{activeSSHProfile && (
									<div className={cn("flex-1 bg-background rounded-xl overflow-hidden min-h-0 flex flex-col border border-border", !(isExplorerVisible && activeProject?.path) && "w-64")}>
										<SSHFileExplorer
											connectionId={sshConn.connectionId ?? ''}
											isConnected={sshConn.isConnected}
											sftpReady={sshConn.sftpReady}
											entries={sshConn.entries}
											currentPath={sshConn.currentPath}
											expandedDirs={sshConn.expandedDirs}
											childEntries={sshConn.childEntries}
											loadingDirs={sshConn.loadingDirs}
											isLoadingRoot={sshConn.isLoadingRoot}
											profileName={activeSSHProfile.name}
											onConnect={sshConn.handleConnect}
											onBrowseFiles={sshConn.handleBrowseFiles}
											onToggleDir={sshConn.toggleDirectory}
											onLoadDir={sshConn.loadDirectory}
											onMkdir={handleSSHMkdir}
											onCreateFile={handleSSHCreateFile}
											onDelete={handleSSHDelete}
											onRename={handleSSHRename}
										/>
									</div>
								)}
							</div>
						) : null}
					</div>
				</PaneDndProvider>
			</div>
				</div>
			</div>

			{/* Modals */}
			<NewProjectModal
				isOpen={isNewProjectModalOpen}
				onClose={() => setIsNewProjectModalOpen(false)}
				onCreateProject={addProject}
			/>

			<CommandPalette
				isOpen={isCommandPaletteOpen}
				onClose={() => setIsCommandPaletteOpen(false)}
				projects={projects}
				onSwitchProject={selectProject}
				onAddTerminal={() => handleAddTerminal(undefined)}
				onNewBrowserTab={handleNewBrowserTab}
				onSaveSnapshot={handleOpenSnapshotModal}
				onOpenProjectSettings={handleOpenProjectSettings}
				onOpenAppPreferences={handleOpenAppPreferences}
				onOpenCommandHistory={activeProjectId ? handleOpenCommandHistory : undefined}
				onOpenShortcutMenu={handleOpenShortcutMenu}
				onSSHConnect={handleSSHConnect}
				sshProfiles={sshProfiles.map((p) => ({ id: p.id, name: p.name, host: p.host, username: p.username }))}
				getShortcutLabel={getShortcutLabel}
				getProjectShortcutLabel={getProjectShortcutLabel}
			/>

			<CreateSnapshotModal
				isOpen={isCreateSnapshotModalOpen}
				onClose={() => setIsCreateSnapshotModalOpen(false)}
				onCreateSnapshot={handleCreateSnapshot}
			/>

			<CommandHistoryModal
				isOpen={isCommandHistoryOpen}
				onClose={() => setIsCommandHistoryOpen(false)}
				entries={commandHistory}
				allEntries={allCommandHistory}
				onSelectCommand={handleInsertCommand}
				onClearHistory={handleClearCommandHistory}
			/>

			{/* SSH Password Prompt */}
			{sshPasswordPrompt && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
					<div className="bg-background border border-border rounded-lg shadow-lg w-[360px] p-4">
						<h3 className="text-sm font-semibold mb-1">SSH Password</h3>
						<p className="text-xs text-muted-foreground mb-3">
							Enter password for <span className="font-medium">{sshPasswordPrompt.profileName}</span>
						</p>
						<input
							type="password"
							value={sshPasswordInput}
							onChange={(e) => setSSHPasswordInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') handleSSHPasswordSubmit();
								if (e.key === 'Escape') { setSSHPasswordPrompt(null); setSSHPasswordInput(''); }
							}}
							placeholder="Password"
							autoFocus
							className="w-full px-3 py-1.5 text-sm bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
						/>
						<div className="flex justify-end gap-2 mt-3">
							<button
								onClick={() => { setSSHPasswordPrompt(null); setSSHPasswordInput(''); }}
								className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent"
							>
								Cancel
							</button>
							<button
								onClick={handleSSHPasswordSubmit}
								className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
							>
								Connect
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Close Terminal Confirmation */}
			<ConfirmDialog
				isOpen={closeConfirmTerminal !== null}
				title="Close Terminal"
				message={`Are you sure you want to close "${
					terminalToClose?.name || "this terminal"
				}"? Any running processes will be terminated.`}
				confirmLabel="Close"
				cancelLabel="Cancel"
				variant="danger"
				isLoading={closeConfirmLoading}
				onConfirm={handleConfirmCloseTerminal}
				onCancel={handleCancelCloseTerminal}
			>
				<label className="flex items-center gap-2 text-xs text-muted-foreground select-none">
					<input
						type="checkbox"
						checked={closeConfirmRememberChoice}
						onChange={(e) => setCloseConfirmRememberChoice(e.target.checked)}
						disabled={closeConfirmLoading}
						className="rounded border-border bg-background"
					/>
					Don't ask again when closing terminals
				</label>
			</ConfirmDialog>

			{/* Dirty File Close Confirmation */}
			<ConfirmDialog
				isOpen={dirtyCloseFilePath !== null}
				title="Unsaved Changes"
				message={`Save changes to "${dirtyCloseFilePath?.split(/[\\/]/).pop() ?? ""}" before closing?`}
				confirmLabel="Save"
				cancelLabel="Cancel"
				secondaryAction={{ label: "Discard", onClick: handleDiscardAndClose }}
				onConfirm={handleSaveThenClose}
				onCancel={handleCancelDirtyClose}
			/>

			{/* App Close Unsaved Files Confirmation */}
			<ConfirmDialog
				isOpen={isAppCloseDialogOpen}
				title="Unsaved Changes"
				message={`You have ${appCloseDirtyCount} unsaved file${appCloseDirtyCount !== 1 ? "s" : ""}. Save changes before closing?`}
				confirmLabel="Save All"
				cancelLabel="Cancel"
				secondaryAction={{
					label: "Don't Save",
					onClick: handleDiscardAllAndClose,
				}}
				onConfirm={handleSaveAllAndClose}
				onCancel={handleCancelAppClose}
			/>
		</div>
	);
}
