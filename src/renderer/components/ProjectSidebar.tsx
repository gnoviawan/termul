import { useState, useCallback, useRef, useEffect, memo, KeyboardEvent } from "react";
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
	Settings,
	GitBranch,
	FolderOpen,
	Copy,
	Home,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { Project, ProjectColor, Worktree } from "@/types/project";
import type { DetectedShells } from "@shared/types/ipc.types";
import { isWorktreeTermulManaged } from "@/types/project";
import { getColorClasses } from "@/lib/colors";
import { cn } from "@/lib/utils";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuItem, ContextMenuSubItem } from "./ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { RemoveWorktreeDialog } from "./RemoveWorktreeDialog";
import { NewWorktreeModal } from "./NewWorktreeModal";
import { ColorPickerPopover } from "./ColorPickerPopover";
import { shellApi, worktreeApi, clipboardApi } from "@/lib/api";
import { useProjectStore, useProjectActions } from "@/stores/project-store";
import { toast } from "@/hooks/use-toast";

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

	// Show archived toggle state
	const [showArchived, setShowArchived] = useState(false);

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

	// New worktree modal state
	const [newWorktreeModal, setNewWorktreeModal] = useState<NewWorktreeModalState>({
		isOpen: false,
		projectId: "",
	});

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

			setWorktreeOperationLock(true);
			try {
				const result = await worktreeApi.remove(worktree.path, false);
				if (result.success) {
					useProjectStore.getState().removeWorktree(projectId, worktree.id);
					toast({ title: "Worktree removed", description: `"${worktree.name}" has been removed.` });
					// Reconcile worktrees after removal
					const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
					if (project?.path) {
						const listResult = await worktreeApi.list(project.path);
						if (listResult.success && listResult.data) {
							const updatedWorktrees: Worktree[] = listResult.data.map((wt) => ({
								id: crypto.randomUUID(),
								name: wt.name,
								branch: wt.branch,
								path: wt.path,
								createdAt: new Date().toISOString(),
							}));
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
					onClick: () => {
						// This terminal spawn is handled by the app's terminal spawning logic
						// which reads the active worktree's path for new terminals
						handleWorktreeSelect(projectId, worktree.id);
						navigate("/");
					},
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
					onClick: () =>
						setWorktreeDeleteConfirm({ isOpen: true, projectId, worktree }),
					variant: "danger" as const,
					disabled: !canRemove || isWorktreeOperationLocked,
				},
			];
		},
		[handleWorktreeSelect, handleOpenInFileExplorer, handleCopyWorktreePath, isWorktreeOperationLocked],
	);

	const colorPickerProject = projects.find(
		(p) => p.id === colorPicker.projectId,
	);

	// Filter active and archived projects
	const activeProjects = projects.filter((p) => !p.isArchived);
	const archivedProjects = projects.filter((p) => p.isArchived);

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

			{/* Project List */}
			<div className="flex-1 overflow-y-auto py-1">
				{activeProjects.length === 0 && archivedProjects.length === 0 ? (
					<div className="flex flex-col items-center justify-center p-6 text-center opacity-60">
						<p className="text-sm text-muted-foreground">No projects yet</p>
						<p className="text-xs text-muted-foreground mt-1">
							Create your first project to get started
						</p>
					</div>
				) : (
					<>
						<Reorder.Group
							axis="y"
							values={activeProjects}
							onReorder={(reordered) =>
								onReorderProjects(reordered.map((p) => p.id))
							}
							className="flex flex-col"
							data-testid="active-projects-container"
						>
							{activeProjects.map((project) => (
								<Reorder.Item
									key={project.id}
									value={project}
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
										isWorktreeOperationLocked={isWorktreeOperationLocked}
										onNewWorktree={(pId) => setNewWorktreeModal({ isOpen: true, projectId: pId })}
									/>
								</Reorder.Item>
							))}
						</Reorder.Group>

						{/* Archived Projects Section */}
						{archivedProjects.length > 0 && (
							<div className="mt-2">
								<button
									onClick={() => setShowArchived(!showArchived)}
									className="w-full flex items-center px-3 py-1.5 text-xs tracking-wider text-sidebar-foreground uppercase hover:bg-sidebar-accent/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
									aria-expanded={showArchived}
									aria-label={`Archived projects (${archivedProjects.length})`}
								>
									{showArchived ? (
										<ChevronDown size={14} className="mr-2" />
									) : (
										<ChevronRight size={14} className="mr-2" />
									)}
									Archived ({archivedProjects.length})
								</button>
								{showArchived &&
									archivedProjects.map((project) => (
										<ArchivedProjectItem
											key={project.id}
											project={project}
											onClick={() => {
												onSelectProject(project.id);
												navigate("/");
											}}
											onContextMenu={(e) => handleContextMenu(e, project.id)}
										/>
									))}
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
	onClick: () => void;
	onContextMenu: (e: React.MouseEvent) => void;
	onEditNameChange: (name: string) => void;
	onSaveRename: () => void;
	onCancelRename: () => void;
	onSettingsClick: () => void;
	onWorktreeSelect: (worktreeId: string | null) => void;
	onWorktreeContextMenu: (e: React.MouseEvent, worktree: Worktree) => void;
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
	onClick,
	onContextMenu,
	onEditNameChange,
	onSaveRename,
	onCancelRename,
	onSettingsClick,
	onWorktreeSelect,
	onWorktreeContextMenu,
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

	return (
		<div data-testid={`project-item-${project.id}`}>
			<button
				onClick={isEditing ? undefined : onClick}
				onContextMenu={onContextMenu}
				className={cn(
					"w-full flex items-center px-0 py-1 transition-colors group text-left border-l-2",
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
						className="flex-1 bg-sidebar-accent border border-border rounded-md px-2 py-0.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary mr-2"
						onClick={(e) => e.stopPropagation()}
					/>
				) : (
					<span
						className={cn(
							"text-sm transition-colors flex-1 mr-2",
							isActive
								? "text-foreground"
								: "text-muted-foreground group-hover:text-foreground",
						)}
					>
						{project.name}
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
			</button>

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
						{/* Root item */}
						<WorktreeItem
							name="Root"
							branch={project.gitBranch ?? "main"}
							path={project.path ?? ""}
							isRoot
							isActive={project.activeWorktreeId === null || project.activeWorktreeId === undefined}
							onClick={() => onWorktreeSelect(null)}
						/>
						{/* Worktree items */}
						{worktrees.map((wt) => (
							<WorktreeItem
								key={wt.id}
								name={wt.name}
								branch={wt.branch}
								path={wt.path}
								isActive={project.activeWorktreeId === wt.id}
								isTermulManaged={isWorktreeTermulManaged(wt)}
								onClick={() => onWorktreeSelect(wt.id)}
								onContextMenu={(e) => onWorktreeContextMenu(e, wt)}
							/>
						))}
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
	onClick: () => void;
	onContextMenu?: (e: React.MouseEvent) => void;
}

const WorktreeItem = memo(function WorktreeItem({
	name,
	branch,
	isRoot,
	isActive,
	isTermulManaged,
	onClick,
	onContextMenu,
}: WorktreeItemProps): React.JSX.Element {
	return (
		<button
			onClick={onClick}
			onContextMenu={onContextMenu}
			className={cn(
				"w-full flex items-center px-2 py-1 text-xs transition-colors text-left",
				isActive
					? "bg-primary/15 text-foreground"
					: "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
			)}
			title={isRoot ? `Project root (${branch})` : `${name} (${branch})`}
		>
			<div className="mr-1.5 flex-shrink-0 inline-flex items-center" aria-hidden="true">
				{isRoot ? <Home size={12} className="text-muted-foreground" /> : <GitBranch size={12} className="text-primary/70" />}
			</div>
			<span className="truncate flex-1">{isRoot ? "Root" : name}</span>
			<span className="text-[10px] text-muted-foreground ml-1 truncate max-w-[60px]">
				{branch}
			</span>
			{!isRoot && isTermulManaged === false && (
				<span className="text-[10px] text-muted-foreground ml-1" title="Not a Termul-managed worktree">
					*
				</span>
			)}
		</button>
	);
});

interface ArchivedProjectItemProps {
	project: Project;
	onClick: () => void;
	onContextMenu: (e: React.MouseEvent) => void;
}

function ArchivedProjectItem({
	project,
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
			<span className="text-sm text-muted-foreground group-hover:text-foreground flex-1">
				{project.name}
			</span>
			<Archive size={12} className="text-muted-foreground mr-3" />
		</button>
	);
}