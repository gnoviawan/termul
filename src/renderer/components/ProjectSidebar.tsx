import { useState, useCallback, useRef, useEffect, memo, KeyboardEvent, useMemo } from "react";
import type { ChangeEvent, MouseEvent } from "react";
import { Reorder, AnimatePresence, motion } from "framer-motion";
import {
	Plus,
	Archive,
	Terminal,
	Edit2,
	Palette,
	Trash2,
	RotateCcw,
	ChevronDown,
	ChevronRight,
	Search,
	Loader2,
	AlertTriangle,
	Settings,
	Folder,
	FolderOpen,
	X,
	GitBranch,
	Copy,
	Home,
	CheckCircle2,
	AlertCircle,
	ArrowUpCircle,
	ArrowDownCircle,
	XCircle,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { Project, ProjectColor, Worktree } from "@/types/project";
import type { DetectedShells } from "@shared/types/ipc.types";
import { isWorktreeTermulManaged } from "@/types/project";
import { getColorClasses, availableColors } from "@/lib/colors";
import { cn } from "@/lib/utils";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuItem, ContextMenuSubItem } from "./ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { RemoveWorktreeDialog } from "./RemoveWorktreeDialog";
import { NewWorktreeModal } from "./NewWorktreeModal";
import { ColorPickerPopover } from "./ColorPickerPopover";
import { Skeleton } from "@/components/ui/skeleton";
import { shellApi, dialogApi, worktreeApi, clipboardApi } from "@/lib/api";
import { useProjectsWithActivity, useProjectsWithErrors } from "@/stores/terminal-store";
import { useProjectStore, useProjectActions } from "@/stores/project-store";
import { toast } from "@/hooks/use-toast";
import { activateAndOpenTerminal } from "@/lib/terminal-spawn";
import type { WorktreeHealthStatus } from "@/types/worktree-status";
import { getWorktreeStatusFromCache } from "@/hooks/use-worktree-status";
import { useWorktreeStatus } from "@/hooks/use-worktree-status";
import { useWorktreeReconciler } from "@/hooks/use-worktree-reconciler";
import { groupWorktrees, type WorktreeGroup } from "@/lib/worktree-grouping";
import { filterWorktrees } from "@/lib/worktree-filter";
import { filterProjects, shouldShowProjectSearch } from "@/lib/project-filter";

function getFirstLetter(name: string): string {
	if (!name) return "?";
	const match = name.match(/[a-zA-Z]/);
	const first = Array.from(name)[0];
	return match ? match[0].toUpperCase() : first ? first.toUpperCase() : "?";
}

interface ContextMenuState {
	isOpen: boolean;
	x: number;
	y: number;
	projectId: string;
}

interface ColorPickerState {
	isOpen: boolean;
	x: number;
	y: number;
	projectId: string;
}

interface DeleteConfirmState {
	isOpen: boolean;
	projectId: string;
	projectName: string;
}

interface SettingsDialogState {
	isOpen: boolean;
	projectId: string;
}

interface NewWorktreeModalState {
	isOpen: boolean;
	projectId: string;
}

interface WorktreeContextMenuState {
	isOpen: boolean;
	x: number;
	y: number;
	worktree: Worktree | null;
	projectId: string;
}

interface WorktreeDeleteConfirmState {
	isOpen: boolean;
	projectId: string;
	worktree: Worktree | null;
}

interface ProjectSidebarProps {
	projects: Project[];
	activeProjectId: string;
	onSelectProject: (id: string) => void;
	onNewProject: () => void;
	onUpdateProject: (id: string, updates: Partial<Project>) => void;
	onDeleteProject: (id: string) => void;
	onArchiveProject: (id: string) => void;
	onRestoreProject: (id: string) => void;
	onReorderProjects: (projectIds: string[]) => void;
}

export function ProjectSidebar({
	projects,
	activeProjectId,
	onSelectProject,
	onNewProject,
	onUpdateProject,
	onDeleteProject,
	onArchiveProject,
	onRestoreProject,
	onReorderProjects,
}: ProjectSidebarProps): React.JSX.Element {
	const navigate = useNavigate();
	const { selectProject, setActiveWorktree, setWorktreeOperationLock } = useProjectActions();
	const isWorktreeOperationLocked = useProjectStore((state) => state.isWorktreeOperationLocked);

	// Poll worktree status for the active project (populates shared cache for sidebar badges)
	useWorktreeStatus(activeProjectId);

	// Reconcile stored worktrees against actual git state (detects orphaned entries)
	useWorktreeReconciler(activeProjectId);

	// Show archived toggle state
	const [showArchived, setShowArchived] = useState(false);

	// Project search/filter query
	const [searchQuery, setSearchQuery] = useState("");
	const searchInputRef = useRef<HTMLInputElement>(null);

	// Expanded worktree projects — active project auto-expands
	const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => {
		const set = new Set<string>();
		if (activeProjectId) set.add(activeProjectId);
		return set;
	});

	// Auto-expand/contract active project
	useEffect(() => {
		setExpandedProjects((prev) => {
			const next = new Set(prev);
			next.add(activeProjectId);
			return next;
		});
	}, [activeProjectId]);

	// Context menu state
	const [contextMenu, setContextMenu] = useState<ContextMenuState>({
		isOpen: false,
		x: 0,
		y: 0,
		projectId: "",
	});

	// Worktree context menu state
	const [worktreeContextMenu, setWorktreeContextMenu] = useState<WorktreeContextMenuState>({
		isOpen: false,
		x: 0,
		y: 0,
		worktree: null,
		projectId: "",
	});

	// Worktree delete confirmation state
	const [worktreeDeleteConfirm, setWorktreeDeleteConfirm] = useState<WorktreeDeleteConfirmState>({
		isOpen: false,
		projectId: "",
		worktree: null,
	});

	// Inline editing state
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editName, setEditName] = useState("");

	// Color picker state
	const [colorPicker, setColorPicker] = useState<ColorPickerState>({
		isOpen: false,
		x: 0,
		y: 0,
		projectId: "",
	});

	// Delete confirmation state
	const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({
		isOpen: false,
		projectId: "",
		projectName: "",
	});

	// Settings dialog state
	const [settingsDialog, setSettingsDialog] = useState<SettingsDialogState>({
		isOpen: false,
		projectId: "",
	});

	// New worktree modal state
	const [newWorktreeModal, setNewWorktreeModal] = useState<NewWorktreeModalState>({
		isOpen: false,
		projectId: "",
	});

	// Settings form state
	const [settingsName, setSettingsName] = useState("");
	const [settingsPath, setSettingsPath] = useState("");
	const [settingsShell, setSettingsShell] = useState("");
	const [settingsColor, setSettingsColor] = useState<ProjectColor>("blue");
	const [settingsPathLoading, setSettingsPathLoading] = useState(false);

	// Available shells state
	const [availableShells, setAvailableShells] = useState<DetectedShells | null>(
		null,
	);

	// Fetch available shells on mount
	useEffect(() => {
		const fetchShells = async () => {
			try {
				const result = await shellApi.getAvailableShells();
				if (result.success) {
					setAvailableShells(result.data);
				}
			} catch {
				// Ignore errors
			}
		};
		void fetchShells();
	}, []);

	// Optimized subscription: only re-render sidebar if which projects have activity changes.
	// This prevents re-renders when terminal text output changes.
	const [projectActivityIds, projectErrorIds] = [useProjectsWithActivity(), useProjectsWithErrors()];

	const toggleProjectExpanded = useCallback((projectId: string): void => {
		setExpandedProjects((prev) => {
			const next = new Set(prev);
			if (next.has(projectId)) {
				next.delete(projectId);
			} else {
				next.add(projectId);
			}
			return next;
		});
	}, []);

	const handleWorktreeSelect = useCallback(
		(projectId: string, worktreeId: string | null): void => {
			setActiveWorktree(projectId, worktreeId);
			if (worktreeId) {
				const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
				const worktree = project?.worktrees?.find((w) => w.id === worktreeId);
				toast({
					title: "Switched worktree",
					description: `Active worktree switched to "${worktree?.name}". New terminals will open here. Existing terminals remain where they are.`,
				});
			} else {
				toast({
					title: "Switched to project root",
					description: "Switched to project root. New terminals will open here.",
				});
			}
		},
		[setActiveWorktree],
	);

	// Activate a worktree AND open a terminal in it, in one action.
	// Shared by the row hover terminal button and the "Open Terminal Here" context menu.
	const handleOpenTerminalInWorktree = useCallback(
		async (projectId: string, worktreeId: string | null, worktreePath: string, worktreeName: string): Promise<void> => {
			const outcome = await activateAndOpenTerminal(projectId, worktreeId, worktreePath);
			if (outcome.status === "opened") {
				toast({ title: "Terminal opened", description: `Terminal opened in "${worktreeName}"` });
			} else if (outcome.status === "no-pane") {
				toast({ title: "No active pane", description: "Cannot open terminal without an active workspace pane." });
			} else {
				toast({ title: "Failed to open terminal", description: outcome.error || "Could not create a terminal in this worktree." });
			}
		},
		[],
	);

	const handleWorktreeContextMenu = useCallback(
		(e: React.MouseEvent, projectId: string, worktree: Worktree): void => {
			e.preventDefault();
			e.stopPropagation();
			setWorktreeContextMenu({
				isOpen: true,
				x: e.clientX,
				y: e.clientY,
				worktree,
				projectId,
			});
		},
		[],
	);

	const closeWorktreeContextMenu = useCallback((): void => {
		setWorktreeContextMenu((prev) => ({ ...prev, isOpen: false }));
	}, []);

	const handleCopyWorktreePath = useCallback(async (path: string): Promise<void> => {
		try {
			await clipboardApi.writeText(path);
			toast({ title: "Path copied", description: path });
		} catch {
			// Fallback: try navigator.clipboard
			try {
				await navigator.clipboard.writeText(path);
				toast({ title: "Path copied", description: path });
			} catch {
				toast({ title: "Failed to copy path", description: "Could not copy to clipboard" });
			}
		}
	}, []);

	const handleOpenInFileExplorer = useCallback(
		async (worktreePath: string): Promise<void> => {
			// Use the filesystem API to open the directory in the OS file manager
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				await (window as any).__TAURI_INTERNALS__?.invoke('open_path_in_file_manager', { path: worktreePath });
			} catch {
				// Fallback — just copy the path
				handleCopyWorktreePath(worktreePath);
			}
		},
		[handleCopyWorktreePath],
	);

	const handleRemoveWorktree = useCallback(
		async (projectId: string, worktree: Worktree): Promise<void> => {
			if (!isWorktreeTermulManaged(worktree)) return; // Only remove Termul-managed worktrees

			const projectPath = useProjectStore.getState().projects.find((p) => p.id === projectId)?.path;
			if (!projectPath) {
				toast({ title: "Failed to remove worktree", description: "Project path not found" });
				return;
			}

			setWorktreeOperationLock(true);
			try {
				const result = await worktreeApi.remove(projectPath, worktree.path, false);
				if (result.success) {
					useProjectStore.getState().removeWorktree(projectId, worktree.id);
					toast({ title: "Worktree removed", description: `"${worktree.name}" has been removed.` });
					// Reconcile worktrees after removal
					const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
					if (project?.path) {
						const listResult = await worktreeApi.list(project.path);
						if (listResult.success && listResult.data) {
							// Preserve existing IDs for stable references (activeWorktreeId, status cache)
							const existingWorktrees = useProjectStore.getState().projects
								.find((p) => p.id === projectId)?.worktrees ?? []
							const existingByPath = new Map(existingWorktrees.map((w) => [w.path, w]))

							const updatedWorktrees: Worktree[] = listResult.data.map((wt) => {
								const existing = existingByPath.get(wt.path)
								return existing ?? {
									id: crypto.randomUUID(),
									name: wt.name,
									branch: wt.branch,
									path: wt.path,
									createdAt: new Date().toISOString(),
								}
							});
							useProjectStore.getState().updateProject(projectId, { worktrees: updatedWorktrees });
						}
					}
				} else {
					toast({ title: "Failed to remove worktree", description: result.error ?? "Unknown error" });
				}
			} catch (err) {
				toast({ title: "Error removing worktree", description: String(err) });
			} finally {
				setWorktreeOperationLock(false);
			}
		},
		[setWorktreeOperationLock],
	);

	const handleContextMenu = useCallback(
		(e: React.MouseEvent, projectId: string): void => {
			e.preventDefault();
			setContextMenu({
				isOpen: true,
				x: e.clientX,
				y: e.clientY,
				projectId,
			});
		},
		[],
	);

	const closeContextMenu = useCallback((): void => {
		setContextMenu((prev) => ({ ...prev, isOpen: false }));
	}, []);

	const handleStartRename = useCallback(
		(projectId: string): void => {
			const project = projects.find((p) => p.id === projectId);
			if (project) {
				setEditingId(projectId);
				setEditName(project.name);
			}
		},
		[projects],
	);

	const handleSaveRename = useCallback(
		(projectId: string): void => {
			if (editName.trim()) {
				onUpdateProject(projectId, { name: editName.trim() });
			}
			setEditingId(null);
			setEditName("");
		},
		[editName, onUpdateProject],
	);

	const handleCancelRename = useCallback((): void => {
		setEditingId(null);
		setEditName("");
	}, []);

	const handleOpenColorPicker = useCallback(
		(projectId: string, x: number, y: number): void => {
			setColorPicker({
				isOpen: true,
				x,
				y,
				projectId,
			});
		},
		[],
	);

	const closeColorPicker = useCallback((): void => {
		setColorPicker((prev) => ({ ...prev, isOpen: false }));
	}, []);

	const handleColorChange = useCallback(
		(color: ProjectColor): void => {
			if (colorPicker.projectId) {
				onUpdateProject(colorPicker.projectId, { color });
			}
		},
		[colorPicker.projectId, onUpdateProject],
	);

	const handleConfirmDelete = useCallback(
		(projectId: string): void => {
			const project = projects.find((p) => p.id === projectId);
			if (project) {
				setDeleteConfirm({
					isOpen: true,
					projectId,
					projectName: project.name,
				});
			}
		},
		[projects],
	);

	const handleDelete = useCallback((): void => {
		if (deleteConfirm.projectId) {
			onDeleteProject(deleteConfirm.projectId);
		}
		setDeleteConfirm({ isOpen: false, projectId: "", projectName: "" });
	}, [deleteConfirm.projectId, onDeleteProject]);

	const handleCancelDelete = useCallback((): void => {
		setDeleteConfirm({ isOpen: false, projectId: "", projectName: "" });
	}, []);

	const handleOpenSettings = useCallback((projectId: string): void => {
		setSettingsDialog({ isOpen: true, projectId });
	}, []);

	const handleCloseSettings = useCallback((): void => {
		setSettingsDialog({ isOpen: false, projectId: "" });
	}, []);

	// Populate form when dialog opens
	useEffect(() => {
		if (settingsDialog.isOpen && settingsDialog.projectId) {
			const project = projects.find((p) => p.id === settingsDialog.projectId);
			if (project) {
				setSettingsName(project.name);
				setSettingsPath(project.path || "");
				setSettingsShell(project.defaultShell || "");
				setSettingsColor(project.color || "blue");
			}
		}
	}, [settingsDialog.isOpen, settingsDialog.projectId, projects]);

	const handleSaveSettings = useCallback(() => {
		const name = settingsName.trim();
		if (!name || !settingsDialog.projectId) {
			return;
		}

		onUpdateProject(settingsDialog.projectId, {
			name,
			path: settingsPath.trim() || undefined,
			defaultShell: settingsShell || undefined,
			color: settingsColor,
			});
		handleCloseSettings();
	}, [settingsDialog.projectId, settingsName, settingsPath, settingsShell, settingsColor, onUpdateProject, handleCloseSettings]);

	const handleBrowsePath = useCallback(async (): Promise<void> => {
		try {
			setSettingsPathLoading(true);
			const result = await dialogApi.selectDirectory();
			if (result.success && result.data) {
				setSettingsPath(result.data);
			}
		} catch (err) {
			console.error("Failed to select directory:", err);
		} finally {
			setSettingsPathLoading(false);
		}
	}, []);

	const getContextMenuItems = useCallback(
		(projectId: string): ContextMenuItem[] => {
			const project = projects.find((p) => p.id === projectId);
			const isGitRepo = project?.isGitRepo ?? false;
			const shellSubmenu: ContextMenuSubItem[] =
				availableShells?.available.map((shell) => ({
					label: shell.displayName,
					value: shell.path,
					isSelected: (() => {
						const projectShell = project?.defaultShell;
						if (!projectShell) return false;
						if (projectShell === shell.path) return true;
						if (projectShell === shell.name) return true;
						const pathBasename = shell.path.split(/[\\/]/).pop();
						return projectShell === pathBasename;
					})(),
				})) || [];

			const items: ContextMenuItem[] = [
				{
					label: "Settings",
					icon: <Settings size={14} />,
					onClick: () => {
						selectProject(projectId);
						navigate("/settings");
					},
				},
				{
					label: "Rename",
					icon: <Edit2 size={14} />,
					onClick: () => handleStartRename(projectId),
				},
				{
					label: "Project Settings",
					icon: <Settings size={14} />,
					onClick: () => handleOpenSettings(projectId),
				},
				{
					label: "Change Color",
					icon: <Palette size={14} />,
					onClick: () =>
						handleOpenColorPicker(projectId, contextMenu.x, contextMenu.y),
				},
			];

			if (shellSubmenu.length > 0) {
				items.push({
					label: "Default Shell",
					icon: <Terminal size={14} />,
					submenu: shellSubmenu,
					onSubmenuSelect: (shellPath: string) => {
						onUpdateProject(projectId, { defaultShell: shellPath });
					},
				});
			}

			items.push(
				{
					label: isGitRepo ? "New Worktree" : "New Worktree (no git repo)",
					icon: <GitBranch size={14} />,
					onClick: () => {
						if (isGitRepo) setNewWorktreeModal({ isOpen: true, projectId });
					},
					disabled: !isGitRepo,
				},
				{
					label: "Archive",
					icon: <Archive size={14} />,
					onClick: () => onArchiveProject(projectId),
				},
				{
					label: "Delete",
					icon: <Trash2 size={14} />,
					onClick: () => handleConfirmDelete(projectId),
					variant: "danger" as const,
				},
			);

			return items;
		},
		[
			projects,
			availableShells,
			contextMenu.x,
			contextMenu.y,
			handleStartRename,
			handleOpenSettings,
			handleOpenColorPicker,
			onUpdateProject,
			onArchiveProject,
			handleConfirmDelete,
			selectProject,
			navigate,
		],
	);

	const getArchivedContextMenuItems = useCallback(
		(projectId: string): ContextMenuItem[] => {
			return [
				{
					label: "Restore",
					icon: <RotateCcw size={14} />,
					onClick: () => onRestoreProject(projectId),
				},
				{
					label: "Delete",
					icon: <Trash2 size={14} />,
					onClick: () => handleConfirmDelete(projectId),
					variant: "danger" as const,
				},
			];
		},
		[onRestoreProject, handleConfirmDelete],
	);

	const getWorktreeContextMenuItems = useCallback(
		(projectId: string, worktree: Worktree): ContextMenuItem[] => {
			const canRemove = isWorktreeTermulManaged(worktree);
			return [
				{
					label: "Open Terminal Here",
					icon: <Terminal size={14} />,
					onClick: () => void handleOpenTerminalInWorktree(projectId, worktree.id, worktree.path, worktree.name),
				},
				{
					label: "Open in File Explorer",
					icon: <FolderOpen size={14} />,
					onClick: () => void handleOpenInFileExplorer(worktree.path),
				},
				{
					label: "Copy Path",
					icon: <Copy size={14} />,
					onClick: () => void handleCopyWorktreePath(worktree.path),
				},
				{ type: "separator" as const },
				{
					label: "Remove Worktree",
					icon: <Trash2 size={14} />,
					onClick: () => {
						const projectPath = useProjectStore.getState().projects.find((p) => p.id === projectId)?.path;
						if (!projectPath) {
							toast({
								title: "Failed to remove worktree",
								description: "Project path not found",
								variant: "destructive",
							});
							return;
						}
						setWorktreeDeleteConfirm({ isOpen: true, projectId, worktree });
					},
					variant: "danger" as const,
					disabled: !canRemove || isWorktreeOperationLocked,
				},
			];
		},
		[handleOpenTerminalInWorktree, handleOpenInFileExplorer, handleCopyWorktreePath, isWorktreeOperationLocked],
	);

	const colorPickerProject = projects.find(
		(p) => p.id === colorPicker.projectId,
	);

	// Split active and archived projects
	const activeProjects = useMemo(() => projects.filter((p) => !p.isArchived), [projects]);
	const archivedProjects = useMemo(() => projects.filter((p) => p.isArchived), [projects]);

	// The search box only renders once the list is long enough to be worth filtering.
	const showSearch = shouldShowProjectSearch(projects.length);

	// Apply the search query to each group. Filtering is gated on `showSearch` so a
	// lingering query can never keep the list filtered after the search box unmounts
	// (e.g. project count drops below the threshold). The unfiltered `activeProjects`
	// is kept for shortcut-index math below.
	const trimmedQuery = showSearch ? searchQuery.trim() : "";
	const isSearching = trimmedQuery.length > 0;
	const filteredActiveProjects = useMemo(
		() => filterProjects(activeProjects, { searchQuery: trimmedQuery }),
		[activeProjects, trimmedQuery],
	);
	const filteredArchivedProjects = useMemo(
		() => filterProjects(archivedProjects, { searchQuery: trimmedQuery }),
		[archivedProjects, trimmedQuery],
	);

	// Map each active project id to its position in the UNFILTERED active list.
	// The badge reflects this position (not the filtered render index) so the
	// number a user sees doesn't shift around as they type a search query.
	const activeIndexById = useMemo(() => {
		const map = new Map<string, number>();
		activeProjects.forEach((p, i) => map.set(p.id, i));
		return map;
	}, [activeProjects]);

	// Reset a lingering query if the search box is no longer shown.
	useEffect(() => {
		if (!showSearch && searchQuery) setSearchQuery("");
	}, [showSearch, searchQuery]);

	// When the active project CHANGES to one that the current query hides (e.g. a
	// project was just created, or a Ctrl+1..9 shortcut selected a hidden project),
	// clear the search so the now-active project becomes visible instead of silently
	// vanishing. Keyed on a change of `activeProjectId` only — searching for OTHER
	// projects while the active one stays put must NOT wipe the query.
	const prevActiveProjectId = useRef(activeProjectId);
	useEffect(() => {
		const changed = prevActiveProjectId.current !== activeProjectId;
		prevActiveProjectId.current = activeProjectId;
		if (!changed || !isSearching || !activeProjectId) return;
		const visible =
			filteredActiveProjects.some((p) => p.id === activeProjectId) ||
			filteredArchivedProjects.some((p) => p.id === activeProjectId);
		if (!visible) setSearchQuery("");
	}, [activeProjectId, isSearching, filteredActiveProjects, filteredArchivedProjects]);
	const hasNoSearchResults =
		isSearching && filteredActiveProjects.length === 0 && filteredArchivedProjects.length === 0;

	// Determine which menu items to show based on project archived status
	const getMenuItems = useCallback(
		(projectId: string): ContextMenuItem[] => {
			const project = projects.find((p) => p.id === projectId);
			if (project?.isArchived) {
				return getArchivedContextMenuItems(projectId);
			}
			return getContextMenuItems(projectId);
		},
		[projects, getContextMenuItems, getArchivedContextMenuItems],
	);

	return (
		<aside className="w-64 bg-sidebar flex flex-col flex-shrink-0 rounded-xl h-full">
			{/* Header with inline + button */}
			<div className="h-9 flex items-center justify-between px-3 border-b border-sidebar-border rounded-t-xl">
				<span className="text-xs tracking-wider text-sidebar-foreground uppercase">
					Projects
				</span>
				<button
					onClick={onNewProject}
					className="group h-6 w-6 inline-flex items-center justify-center rounded-md hover:bg-sidebar-accent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
					title="New Project"
					aria-label="Create new project from header"
					data-testid="header-new-project"
				>
					<Plus
						size={14}
						className="text-muted-foreground group-hover:text-foreground"
					/>
				</button>
			</div>

			{/* Project search — flat style matching the file explorer search */}
			{showSearch && (
				<div className="px-3 py-1.5 border-b border-sidebar-border">
					<div className="relative">
						<Search
							size={13}
							className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
							aria-hidden="true"
						/>
						<input
							ref={searchInputRef}
							type="search"
							placeholder="Search projects…"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape" && searchQuery) {
									e.preventDefault();
									e.stopPropagation();
									setSearchQuery("");
								}
							}}
							className="w-full rounded-none border-0 bg-transparent py-1 pl-7 pr-7 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:ring-0 [&::-webkit-search-cancel-button]:hidden"
							aria-label="Search projects"
							data-testid="project-search-input"
						/>
						{searchQuery && (
							<button
								onClick={() => {
									setSearchQuery("");
									// Clearing unmounts this button; return focus to the input.
									searchInputRef.current?.focus();
								}}
								className="absolute right-0 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
								title="Clear search"
								aria-label="Clear project search"
								data-testid="project-search-clear"
							>
								<X size={11} />
							</button>
						)}
					</div>
				</div>
			)}

			{/* Project List */}
			<div className="flex-1 overflow-y-auto py-1">
				{projects.length === 0 ? (
					<div className="flex flex-col items-center justify-center p-6 text-center opacity-60">
						<p className="text-sm text-muted-foreground">No projects yet</p>
						<p className="text-xs text-muted-foreground mt-1">
							Create your first project to get started
						</p>
					</div>
				) : hasNoSearchResults ? (
					<div
						className="flex flex-col items-center justify-center p-6 text-center opacity-60"
						data-testid="project-search-empty"
						role="status"
						aria-live="polite"
					>
						<p className="text-sm text-muted-foreground">No projects found</p>
						<p className="text-xs text-muted-foreground mt-1 break-words">
							Nothing matches “{trimmedQuery}”
						</p>
					</div>
				) : (
					<>
						<Reorder.Group
							axis="y"
							values={filteredActiveProjects}
							onReorder={(reordered) => {
								// Reordering a filtered subset would drop the hidden projects,
								// so only persist a new order when the full list is visible.
								if (isSearching) return;
								onReorderProjects(reordered.map((p) => p.id));
							}}
							className="flex flex-col"
							data-testid="active-projects-container"
						>
							{filteredActiveProjects.map((project) => {
								const hasActivity = projectActivityIds.includes(project.id);
								// Shortcut badge reflects the project's position in the UNFILTERED
								// active list to stay in sync with the global Ctrl+1..9 handler.
								const shortcutIndex = activeIndexById.get(project.id) ?? -1;
								return (
									<Reorder.Item
										key={project.id}
										value={project}
										drag={isSearching ? false : undefined}
										className="list-none"
										whileDrag={{
											scale: 1.02,
											boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
										}}
									>
										<ProjectItem
											project={project}
											isActive={project.id === activeProjectId}
											isExpanded={expandedProjects.has(project.id)}
											onToggleExpand={() => toggleProjectExpanded(project.id)}
											isEditing={editingId === project.id}
											editName={editName}
											shortcut={shortcutIndex >= 0 && shortcutIndex < 9 ? `Ctrl+${shortcutIndex + 1}` : undefined}
											hasActivity={hasActivity}
											hasError={projectErrorIds.has(project.id)}
											onClick={() => {
												onSelectProject(project.id);
												navigate("/");
											}}
											onContextMenu={(e) => handleContextMenu(e, project.id)}
											onEditNameChange={setEditName}
											onSaveRename={() => handleSaveRename(project.id)}
											onCancelRename={handleCancelRename}
											onSettingsClick={() => {
												selectProject(project.id);
												navigate("/settings");
											}}
											onWorktreeSelect={(worktreeId) => handleWorktreeSelect(project.id, worktreeId)}
											onWorktreeContextMenu={(e, worktree) => handleWorktreeContextMenu(e, project.id, worktree)}
											onOpenTerminalInWorktree={(worktreeId, worktreePath, worktreeName) =>
												void handleOpenTerminalInWorktree(project.id, worktreeId, worktreePath, worktreeName)
											}
											isWorktreeOperationLocked={isWorktreeOperationLocked}
											onNewWorktree={(pId) => setNewWorktreeModal({ isOpen: true, projectId: pId })}
										/>
									</Reorder.Item>
								);
							})}
						</Reorder.Group>

						{/* Archived Projects Section */}
						{filteredArchivedProjects.length > 0 && (
							<div className="mt-2">
								<button
									onClick={() => setShowArchived(!showArchived)}
									disabled={isSearching}
									className="w-full flex items-center px-3 py-1.5 text-xs tracking-wider text-sidebar-foreground uppercase hover:bg-sidebar-accent/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default disabled:hover:bg-transparent"
									aria-expanded={showArchived || isSearching}
									aria-label={`Archived projects (${filteredArchivedProjects.length})`}
								>
									{showArchived || isSearching ? (
										<ChevronDown size={14} className="mr-2" />
									) : (
										<ChevronRight size={14} className="mr-2" />
									)}
									Archived ({filteredArchivedProjects.length})
								</button>
								{(showArchived || isSearching) &&
									filteredArchivedProjects.map((project) => {
										const hasActivity = projectActivityIds.includes(project.id);
										return (
											<ArchivedProjectItem
												key={project.id}
												project={project}
												hasActivity={hasActivity}
												hasError={projectErrorIds.has(project.id)}
												onClick={() => {
													onSelectProject(project.id);
													navigate("/");
												}}
												onContextMenu={(e) => handleContextMenu(e, project.id)}
											/>
										);
									})}
							</div>
						)}
					</>
				)}
			</div>

			{/* Bottom toolbar - Version */}
			<div className="p-2 rounded-b-xl">
				<div className="w-full h-6 inline-flex items-center justify-center">
					<span className="text-xs text-muted-foreground">Termul v0.3.8</span>
				</div>
			</div>

			{/* Context Menu */}
			{contextMenu.isOpen && (
				<ContextMenu
					items={getMenuItems(contextMenu.projectId)}
					x={contextMenu.x}
					y={contextMenu.y}
					onClose={closeContextMenu}
				/>
			)}

			{/* Worktree Context Menu */}
			{worktreeContextMenu.isOpen && worktreeContextMenu.worktree && (
				<ContextMenu
					items={getWorktreeContextMenuItems(worktreeContextMenu.projectId, worktreeContextMenu.worktree)}
					x={worktreeContextMenu.x}
					y={worktreeContextMenu.y}
					onClose={closeWorktreeContextMenu}
				/>
			)}

			{/* Color Picker Popover */}
			{colorPicker.isOpen && colorPickerProject && (
				<ColorPickerPopover
					x={colorPicker.x}
					y={colorPicker.y}
					currentColor={colorPickerProject.color}
					onSelectColor={handleColorChange}
					onClose={closeColorPicker}
				/>
			)}

			{/* Project Settings Dialog */}
			{settingsDialog.isOpen && (
				<motion.div
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
					onClick={handleCloseSettings}
				>
					<motion.div
						initial={{ opacity: 0, scale: 0.95, y: 10 }}
						animate={{ opacity: 1, scale: 1, y: 0 }}
						exit={{ opacity: 0, scale: 0.95, y: 10 }}
						transition={{ duration: 0.15 }}
						className="bg-card rounded-lg shadow-2xl w-[500px] border border-border overflow-hidden"
						onClick={(e) => e.stopPropagation()}
					>
						{/* Header */}
						<div className="px-4 py-3 border-b border-border flex justify-between items-center bg-secondary/50">
							<h3 className="text-sm font-semibold text-foreground">Project Settings</h3>
							<button
								onClick={handleCloseSettings}
								className="text-muted-foreground hover:text-foreground transition-colors"
							>
								<X size={14} />
							</button>
						</div>

						{/* Form */}
						<div className="p-6 space-y-4">
							{/* Name Field */}
							<div className="space-y-2">
								<label className="text-xs font-medium text-muted-foreground">Project Name</label>
								<input
									type="text"
									value={settingsName}
									onChange={(e) => setSettingsName(e.target.value)}
										className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none placeholder-muted-foreground"
									placeholder="My Project"
								/>
							</div>

							{/* Path Field */}
							<div className="space-y-2">
								<label className="text-xs font-medium text-muted-foreground">Project Path</label>
								<div className="flex gap-2">
									<input
										type="text"
										value={settingsPath}
										onChange={(e) => setSettingsPath(e.target.value)}
										className="flex-1 bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none placeholder-muted-foreground"
										placeholder="No directory selected"
									/>
									<button
										onClick={handleBrowsePath}
										disabled={settingsPathLoading}
										className="bg-secondary hover:bg-muted text-foreground text-xs px-3 rounded border border-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
									>
										Browse
								</button>
								</div>
								<p className="text-xs text-muted-foreground">Optional: leave empty to use default project directory</p>
							</div>

							{/* Color Picker */}
							<div className="space-y-2 mt-4">
								<label className="block text-xs font-medium text-muted-foreground mb-1">Color</label>
								<div className="flex gap-2">
									{availableColors.map((color) => {
										const colors = getColorClasses(color)
										return (
											<button
												key={color}
												type="button"
												onClick={() => setSettingsColor(color)}
												className={cn(
													"w-6 h-6 rounded-full transition-all",
													colors.bg,
													settingsColor === color
														? "ring-2 ring-offset-2 ring-offset-card ring-current"
														: "hover:opacity-80",
												)}
											/>
										)
									})}
									</div>
							</div>

							{/* Shell Field */}
							<div className="space-y-2">
								<label className="block text-xs font-medium text-muted-foreground mb-1">Default Terminal</label>
								{availableShells ? (
									<div className="relative">
										<select
											value={settingsShell}
											onChange={(e) => setSettingsShell(e.target.value)}
											className="w-full appearance-none bg-secondary border border-border rounded px-3 py-1.5 pr-8 text-sm text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none cursor-pointer"
										>
											{availableShells.available.map((shell) => (
												<option key={shell.path} value={shell.path}>
													{shell.displayName}
												</option>
											))}
										</select>
										<div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-muted-foreground">
											<ChevronDown size={14} />
										</div>
								</div>
							) : (
									<Skeleton className="w-full h-9 rounded" />
								)}
							</div>

						</div>

						{/* Footer */}
						<div className="px-6 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border">
							<button
								onClick={handleCloseSettings}
								className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
							>
								Cancel
							</button>
							<button
								onClick={handleSaveSettings}
								className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90 shadow-md shadow-primary/20 transition-colors"
							>
								Save Changes
							</button>
						</div>
					</motion.div>
				</motion.div>
			)}

			{/* Delete Confirmation Dialog */}
			<ConfirmDialog
				isOpen={deleteConfirm.isOpen}
				title="Delete Project"
				message={`Are you sure you want to delete "${deleteConfirm.projectName}"? This action cannot be undone.`}
				confirmLabel="Delete"
				cancelLabel="Cancel"
				variant="danger"
				onConfirm={handleDelete}
				onCancel={handleCancelDelete}
			/>

			{/* Worktree Removal Dialog */}
			<RemoveWorktreeDialog
				isOpen={worktreeDeleteConfirm.isOpen}
				onClose={() => setWorktreeDeleteConfirm({ isOpen: false, projectId: "", worktree: null })}
				projectId={worktreeDeleteConfirm.projectId}
				worktree={worktreeDeleteConfirm.worktree}
				projectPath={projects.find(p => p.id === worktreeDeleteConfirm.projectId)?.path ?? ""}
				gitBranch={projects.find(p => p.id === worktreeDeleteConfirm.projectId)?.gitBranch}
			/>

			{/* New Worktree Modal */}
			<NewWorktreeModal
				isOpen={newWorktreeModal.isOpen}
				onClose={() => setNewWorktreeModal({ isOpen: false, projectId: "" })}
				projectId={newWorktreeModal.projectId}
			/>
		</aside>
	);
}

interface ProjectItemProps {
	project: Project;
	isActive: boolean;
	isExpanded: boolean;
	onToggleExpand: () => void;
	isEditing: boolean;
	editName: string;
	shortcut?: string;
	hasActivity: boolean;
	hasError?: boolean;
	onClick: () => void;
	onContextMenu: (e: React.MouseEvent) => void;
	onEditNameChange: (name: string) => void;
	onSaveRename: () => void;
	onCancelRename: () => void;
	onSettingsClick: () => void;
	onWorktreeSelect: (worktreeId: string | null) => void;
	onWorktreeContextMenu: (e: React.MouseEvent, worktree: Worktree) => void;
	onOpenTerminalInWorktree: (worktreeId: string | null, worktreePath: string, worktreeName: string) => void;
	isWorktreeOperationLocked: boolean;
	onNewWorktree: (projectId: string) => void;
}

const ProjectItem = memo(function ProjectItem({
	project,
	isActive,
	isExpanded,
	onToggleExpand,
	isEditing,
	editName,
	shortcut,
	hasActivity,
	hasError,
	onClick,
	onContextMenu,
	onEditNameChange,
	onSaveRename,
	onCancelRename,
	onSettingsClick,
	onWorktreeSelect,
	onWorktreeContextMenu,
	onOpenTerminalInWorktree,
	isWorktreeOperationLocked,
	onNewWorktree,
}: ProjectItemProps): React.JSX.Element {
	const colors = getColorClasses(project.color);
	const inputRef = useRef<HTMLInputElement>(null);

	// Focus input when editing starts
	useEffect(() => {
		if (isEditing && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [isEditing]);

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === "Enter") {
			e.preventDefault();
			onSaveRename();
		} else if (e.key === "Escape") {
			e.preventDefault();
			onCancelRename();
		}
	};

	const firstLetter = getFirstLetter(project.name);
	const hasWorktrees = (project.worktrees?.length ?? 0) > 0 || project.isGitRepo;
	const worktrees = project.worktrees ?? [];

	// Worktree search and group collapse state
	const [worktreeSearchQuery, setWorktreeSearchQuery] = useState("");
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

	return (
		<div data-testid={`project-item-${project.id}`}>
			<div
				onClick={isEditing ? undefined : onClick}
				onContextMenu={onContextMenu}
				role="button"
				tabIndex={0}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						if (!isEditing) onClick();
					}
				}}
				className={cn(
					"w-full flex items-center px-0 py-1 transition-colors group text-left border-l-2 cursor-pointer",
					isActive
						? `${colors.border} bg-sidebar-accent`
						: `${colors.borderMuted} hover:bg-sidebar-accent/50`,
				)}
				aria-current={isActive ? "page" : undefined}
				aria-label={`Project: ${project.name}${isActive ? " (active)" : ""}`}
			>
				{/* Expand/collapse chevron for projects with worktrees or git */}
				{hasWorktrees ? (
					<button
						onClick={(e) => {
							e.stopPropagation();
							onToggleExpand();
						}}
						className="h-5 w-5 inline-flex items-center justify-center flex-shrink-0 hover:bg-sidebar-accent rounded transition-colors"
						aria-label={isExpanded ? "Collapse worktrees" : "Expand worktrees"}
						aria-expanded={isExpanded}
					>
						{isExpanded ? (
							<ChevronDown size={12} className="text-muted-foreground" />
						) : (
							<ChevronRight size={12} className="text-muted-foreground" />
						)}
					</button>
				) : (
					<div className="w-5 flex-shrink-0" />
				)}

				{/* Circular avatar with first letter */}
				<div
					className={cn(
						"w-4 h-4 rounded-full flex items-center justify-center ml-1 mr-2 flex-shrink-0",
						colors.bg,
					)}
					aria-hidden="true"
				>
					<span
						className="text-[10px] leading-none text-white"
						data-testid="project-avatar-letter"
					>
						{firstLetter}
					</span>
				</div>
				{isEditing ? (
					<input
						ref={inputRef}
						type="text"
						value={editName}
						onChange={(e) => onEditNameChange(e.target.value)}
						onKeyDown={handleKeyDown}
						onBlur={onSaveRename}
						className="flex-1 min-w-0 bg-sidebar-accent border border-border rounded-md px-2 py-0.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary mr-2"
						onClick={(e) => e.stopPropagation()}
					/>
				) : (
					<span
						className={cn(
							"text-sm transition-colors flex-1 min-w-0 truncate mr-2",
							// flex-1 min-w-0 is required for truncate to clip inside a flex row
							isActive
								? "text-foreground"
								: "text-muted-foreground group-hover:text-foreground",
						)}
						title={project.name}
					>
						{project.name}
					</span>
				)}
				{hasError && (
					<span className="flex items-center mr-2 text-yellow-500 animate-pulse" title="Terminal crashed">
						<AlertTriangle size={12} />
					</span>
				)}
				{!isEditing && shortcut && (
					<span
						className={cn(
							"text-xs font-mono text-muted-foreground transition-opacity mr-3",
							isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
						)}
					>
						{shortcut}
					</span>
				)}
				{!isEditing && (
					<button
						onClick={(e) => {
							e.stopPropagation();
							onSettingsClick();
						}}
						className="h-5 w-5 inline-flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-sidebar-accent transition-all mr-2 flex-shrink-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
						title="Project settings"
						aria-label={`Settings for ${project.name}`}
					>
						<Settings size={12} className="text-muted-foreground" />
					</button>
				)}
				{!isEditing && hasActivity && (
					<span className="flex items-center mr-3" title="Terminal activity" style={{ isolation: "isolate" }}>
						<Loader2
							size={12}
							className={"animate-spin text-primary opacity-100"}
						/>
					</span>
				)}
			</div>

			{/* Worktree sub-items */}
			<AnimatePresence initial={false}>
				{isExpanded && hasWorktrees && (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.15, ease: "easeInOut" }}
						className="ml-5 border-l border-sidebar-border overflow-hidden"
					>
						{/* Worktree search bar - visible at 10+ worktrees, flat style matching the file explorer */}
					{worktrees.length >= 10 && (
						<div className="px-2 py-1">
							<div className="relative">
								<Search
									size={12}
									className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
									aria-hidden="true"
								/>
								<input
									type="search"
									placeholder="Search worktrees…"
									value={worktreeSearchQuery}
									onChange={(e) => setWorktreeSearchQuery(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Escape" && worktreeSearchQuery) {
											e.preventDefault();
											e.stopPropagation();
											setWorktreeSearchQuery("");
										}
									}}
									className="w-full rounded-none border-0 bg-transparent py-1 pl-7 pr-7 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:ring-0 [&::-webkit-search-cancel-button]:hidden"
									aria-label="Search worktrees"
								/>
								{worktreeSearchQuery && (
									<button
										onClick={() => setWorktreeSearchQuery("")}
										className="absolute right-0 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
										title="Clear search"
										aria-label="Clear worktree search"
									>
										<X size={11} />
									</button>
								)}
							</div>
						</div>
					)}
					{/* Root item */}
						<WorktreeItem
							name="Root"
							branch={project.gitBranch ?? "main"}
							path={project.path ?? ""}
							isRoot
							isActive={project.activeWorktreeId === null || project.activeWorktreeId === undefined}
							onClick={() => onWorktreeSelect(null)}
							onOpenTerminal={project.path ? () => onOpenTerminalInWorktree(null, project.path as string, "project root") : undefined}
						/>
						{/* Grouped worktree items with search filter */}
						{(() => {
							const filtered = worktreeSearchQuery
								? filterWorktrees(worktrees, { searchQuery: worktreeSearchQuery })
								: worktrees;
							const groups = groupWorktrees(filtered);
							return groups.map((group) => {
								const isCollapsed = collapsedGroups.has(group.id);
								return (
									<div key={group.id} className="mb-1">
										{group.id !== 'other' && group.items.length > 1 && (
											<button
												onClick={() => {
													setCollapsedGroups((prev) => {
														const next = new Set(prev);
														if (next.has(group.id)) {
															next.delete(group.id);
														} else {
															next.add(group.id);
														}
														return next;
													});
												}}
												className="flex items-center w-full px-2 py-0.5 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider hover:text-muted-foreground/80 transition-colors"
											>
												<span>{isCollapsed ? '▶' : '▼'}</span>
												<span className="ml-1">{group.name}</span>
												<span className="ml-auto text-[9px] font-normal text-muted-foreground/40">{group.items.length}</span>
											</button>
										)}
										{(!isCollapsed || group.id === 'other' || group.items.length <= 1) && group.items.map((wt) => (
											<WorktreeItem
												key={wt.id}
												name={wt.name}
												branch={wt.branch}
												path={wt.path}
												worktreeId={wt.id}
												isActive={project.activeWorktreeId === wt.id}
												isTermulManaged={isWorktreeTermulManaged(wt)}
												onClick={() => onWorktreeSelect(wt.id)}
												onContextMenu={(e) => onWorktreeContextMenu(e, wt)}
												onOpenTerminal={() => onOpenTerminalInWorktree(wt.id, wt.path, wt.name)}
											/>
										))}
									</div>
								);
							})
						})()}
						{/* New Worktree button */}
						{project.isGitRepo && (
							<button
								onClick={(e) => {
									e.stopPropagation();
									onNewWorktree(project.id);
								}}
								disabled={isWorktreeOperationLocked}
								className="w-full flex items-center px-2 py-1 text-xs text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground transition-colors"
								title={isWorktreeOperationLocked ? "Another worktree operation in progress" : "Create new worktree"}
							>
								<Plus size={10} className="mr-1.5" />
								New Worktree
							</button>
						)}
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
});

interface WorktreeItemProps {
	name: string;
	branch: string;
	path: string;
	isRoot?: boolean;
	isActive: boolean;
	isTermulManaged?: boolean;
	worktreeId?: string;
	onClick: () => void;
	onContextMenu?: (e: React.MouseEvent) => void;
	onOpenTerminal?: () => void;
}

/** Icon + color for worktree health status */
function HealthBadge({ status }: { status: WorktreeHealthStatus | undefined }) {
	if (!status || status === 'clean') return null

	const config: Record<WorktreeHealthStatus, { icon: typeof CheckCircle2; className: string }> = {
		clean: { icon: CheckCircle2, className: 'text-green-500' },
		dirty: { icon: AlertCircle, className: 'text-yellow-500' },
		ahead: { icon: ArrowUpCircle, className: 'text-blue-500' },
		behind: { icon: ArrowDownCircle, className: 'text-orange-500' },
		conflicted: { icon: XCircle, className: 'text-red-500' },
	}

	const { icon: Icon, className } = config[status]
	return <Icon size={10} className={cn('flex-shrink-0', className)} />
}

const WorktreeItem = memo(function WorktreeItem({
	name,
	branch,
	path,
	isRoot,
	isActive,
	isTermulManaged,
	worktreeId,
	onClick,
	onContextMenu,
	onOpenTerminal,
}: WorktreeItemProps): React.JSX.Element {
	// Read health status from cache (updated by useWorktreeStatus polling in ProjectSidebar)
	// This reads a shared Map — no hook subscription needed; the parent sidebar
	// re-renders on status changes, which causes this item to re-render too.
	const healthStatus: WorktreeHealthStatus | undefined = worktreeId
		? getWorktreeStatusFromCache(worktreeId)?.health
		: undefined

	const tooltip = isRoot
		? `Project root (${branch})`
		: `${name} on ${branch}${path ? ` — ${path}` : ''}${isTermulManaged === false ? ' — External worktree' : ''}`

	return (
		<div
			onClick={onClick}
			onContextMenu={onContextMenu}
			role="button"
			tabIndex={0}
			onKeyDown={(e) => {
				// Only activate row-select for keys on the row itself, not on nested
				// controls (e.g. the terminal button), which handle their own keys.
				if (e.target !== e.currentTarget) return;
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onClick();
				}
			}}
			className={cn(
				"group w-full flex items-center px-2 py-1 text-xs transition-colors text-left cursor-pointer",
				isActive
					? "bg-primary/15 text-foreground"
					: "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
			)}
			title={tooltip}
			aria-current={isActive ? "page" : undefined}
			aria-label={isRoot ? `Project root on ${branch}` : `Worktree ${name} on ${branch}`}
		>
			<div className="mr-1.5 flex-shrink-0 inline-flex items-center" aria-hidden="true">
				{isRoot ? <Home size={12} className="text-muted-foreground" /> : <GitBranch size={12} className="text-primary/70" />}
			</div>
			<span className="truncate flex-1">{isRoot ? "Root" : name}</span>
			{!isRoot && <HealthBadge status={healthStatus} />}
			{!isRoot && isTermulManaged === false && (
				<span className="text-[10px] text-amber-500/70 ml-1" title="External worktree (not created by Termul)">
					ext
				</span>
			)}
			{onOpenTerminal && (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onOpenTerminal();
					}}
					onKeyDown={(e) => e.stopPropagation()}
					className="h-5 w-5 inline-flex items-center justify-center rounded opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:bg-sidebar-accent transition-all ml-1 flex-shrink-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
					title={`Open terminal in ${isRoot ? "project root" : name}`}
					aria-label={`Open terminal in ${isRoot ? "project root" : name}`}
				>
					<Terminal size={12} className="text-muted-foreground" aria-hidden="true" />
				</button>
			)}
		</div>
	);
});

interface ArchivedProjectItemProps {
	hasActivity: boolean;
	hasError?: boolean;
	project: Project;
	onClick: () => void;
	onContextMenu: (e: React.MouseEvent) => void;
}

function ArchivedProjectItem({
	project,
	hasActivity,
	hasError,
	onClick,
	onContextMenu,
}: ArchivedProjectItemProps): React.JSX.Element {
	const colors = getColorClasses(project.color);
	const firstLetter = getFirstLetter(project.name);

	return (
		<button
			onClick={onClick}
			onContextMenu={onContextMenu}
			className={cn(
				"w-full flex items-center px-0 py-1 transition-colors group text-left border-l-2 opacity-60 hover:opacity-100",
				colors.borderMuted,
			)}
			aria-label={`Archived project: ${project.name}`}
			data-testid={`archived-project-item-${project.id}`}
		>
			{/* Circular avatar with first letter */}
			<div
				className={cn(
					"w-4 h-4 rounded-full flex items-center justify-center ml-2 mr-2 flex-shrink-0",
					colors.bg,
				)}
				aria-hidden="true"
			>
				<span
					className="text-[10px] leading-none text-white"
					data-testid="project-avatar-letter"
				>
					{firstLetter}
				</span>
			</div>
			<span
				className="text-sm text-muted-foreground group-hover:text-foreground flex-1 min-w-0 truncate mr-2"
				title={project.name}
			>
				{project.name}
			</span>
			{hasActivity && (
				<span className="flex items-center mr-2" title="Terminal activity" style={{ isolation: "isolate" }}>
					<Loader2 size={10} className="animate-spin text-primary opacity-60" />
				</span>
			)}
			{hasError && (
				<span className="flex items-center mr-2 text-yellow-500 animate-pulse" title="Terminal crashed">
					<AlertTriangle size={10} />
				</span>
			)}
			<Archive size={12} className="text-muted-foreground mr-3" />
		</button>
	);
}