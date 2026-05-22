import { useState, useCallback, useRef, useEffect, KeyboardEvent, useMemo } from "react";
import type { ChangeEvent, MouseEvent } from "react";
import { motion, Reorder } from "framer-motion";
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
	Loader2,
	AlertTriangle,
	Settings,
	Folder,
	FolderOpen,
	X,
	Smartphone,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { Project, ProjectColor } from "@/types/project";
import type { DetectedShells } from "@shared/types/ipc.types";
import { getColorClasses, availableColors } from "@/lib/colors";
import { cn } from "@/lib/utils";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuItem, ContextMenuSubItem } from "./ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { ColorPickerPopover } from "./ColorPickerPopover";
import { Skeleton } from "@/components/ui/skeleton";
import { shellApi, dialogApi } from "@/lib/api";
import { useProjectsWithActivity, useProjectsWithErrors } from "@/stores/terminal-store";

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

	// Show archived toggle state
	const [showArchived, setShowArchived] = useState(false);

	// Context menu state
	const [contextMenu, setContextMenu] = useState<ContextMenuState>({
		isOpen: false,
		x: 0,
		y: 0,
		projectId: "",
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
	if (settingsDialog.projectId) {
		onUpdateProject(settingsDialog.projectId, {
			name: settingsName.trim(),
			path: settingsPath.trim() || undefined,
			defaultShell: settingsShell || undefined,
			color: settingsColor,
		});
	}
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
			const shellSubmenu: ContextMenuSubItem[] =
				availableShells?.available.map((shell) => ({
					label: shell.displayName,
					value: shell.path,
					isSelected: (() => {
						const projectShell = project?.defaultShell;
						if (!projectShell) return false;
						// Match by full path
						if (projectShell === shell.path) return true;
						// Match by name
						if (projectShell === shell.name) return true;
						// Match by basename of path
						const pathBasename = shell.path.split(/[\\/]/).pop();
						return projectShell === pathBasename;
					})(),
				})) || [];

			const items: ContextMenuItem[] = [
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
					label: "Set Default Shell",
					icon: <Terminal size={14} />,
					submenu: shellSubmenu,
					onSubmenuSelect: (shellPath: string) => {
						onUpdateProject(projectId, { defaultShell: shellPath });
					},
				});
			}

			items.push(
				{
					label: "Archive",
					icon: <Archive size={14} />,
					onClick: () => onArchiveProject(projectId),
				},
				{
					label: "Delete",
					icon: <Trash2 size={14} />,
					onClick: () => handleConfirmDelete(projectId),
					variant: "danger",
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
					variant: "danger",
				},
			];
		},
		[onRestoreProject, handleConfirmDelete],
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
		<aside className="w-56 bg-sidebar flex flex-col flex-shrink-0 h-full border-r border-border/50">
			{/* Header with inline + button */}
			<div className="h-8 flex items-center justify-between px-3 border-b border-border/50">
				<span className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
					Projects
				</span>
				<button
					onClick={onNewProject}
					className="group h-5 w-5 inline-flex items-center justify-center rounded hover:bg-sidebar-accent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
					title="New Project"
					aria-label="Create new project from header"
					data-testid="header-new-project"
				>
					<Plus size={12} className="text-muted-foreground group-hover:text-foreground transition-colors" />
				</button>
			</div>

			{/* Project List */}
			<div className="flex-1 overflow-y-auto py-0.5">
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
							{activeProjects.map((project, index) => {
								const hasActivity = projectActivityIds.includes(project.id);
								return (
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
											isEditing={editingId === project.id}
											editName={editName}
											shortcut={index < 9 ? `Ctrl+${index + 1}` : undefined}
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
										/>
									</Reorder.Item>
								);
							})}
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
									archivedProjects.map((project) => {
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
			<div className="px-3 py-1.5 border-t border-border/50">
				<span className="text-[10px] text-muted-foreground/60">v0.3.8</span>
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
		</aside>
	);
}

interface ProjectItemProps {
	project: Project;
	isActive: boolean;
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
}

function ProjectItem({
	project,
	isActive,
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

	return (
		<button
			onClick={isEditing ? undefined : onClick}
			onContextMenu={onContextMenu}
			className={cn(
				"w-full flex items-center px-2 py-1 transition-colors group text-left",
				isActive
					? "bg-sidebar-accent"
					: "hover:bg-sidebar-accent/50",
			)}
			aria-current={isActive ? "page" : undefined}
			aria-label={`Project: ${project.name}${isActive ? " (active)" : ""}`}
			data-testid={`project-item-${project.id}`}
		>
			<div
				className={cn(
					"w-3 h-3 rounded-full flex-shrink-0",
					colors.bg,
					isActive && "ring-1 ring-offset-1 ring-offset-sidebar ring-primary",
				)}
				aria-hidden="true"
			/>
			{isEditing ? (
				<input
					ref={inputRef}
					type="text"
					value={editName}
					onChange={(e) => onEditNameChange(e.target.value)}
					onKeyDown={handleKeyDown}
					onBlur={onSaveRename}
					className="flex-1 bg-sidebar-accent border border-border rounded px-1.5 py-0.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary ml-2"
					onClick={(e) => e.stopPropagation()}
				/>
			) : (
				<span
					className={cn(
						"text-xs transition-colors flex-1 ml-2 truncate",
						isActive
							? "text-foreground font-medium"
							: "text-muted-foreground group-hover:text-foreground",
					)}
				>
					{project.name}
				</span>
			)}
			{hasError && (
				<span className="flex items-center ml-auto text-yellow-500 animate-pulse" title="Terminal crashed">
					<AlertTriangle size={10} />
				</span>
			)}
			{!isEditing && shortcut && (
				<span
					className={cn(
						"text-[10px] font-mono text-muted-foreground/60 transition-opacity ml-auto",
						isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
					)}
				>
					{shortcut}
				</span>
			)}
			{!isEditing && hasActivity && (
				<span className="flex items-center ml-auto" title="Terminal activity" style={{ isolation: "isolate" }}>
					<Loader2 size={10} className="animate-spin text-primary" />
				</span>
			)}
		</button>
	);
}

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
				"w-full flex items-center px-2 py-1 transition-colors group text-left opacity-50 hover:opacity-80",
			)}
			aria-label={`Archived project: ${project.name}`}
			data-testid={`archived-project-item-${project.id}`}
		>
			<div
				className={cn(
					"w-3 h-3 rounded-full flex-shrink-0",
					colors.bg,
				)}
				aria-hidden="true"
			/>
			<span className="text-xs text-muted-foreground group-hover:text-foreground flex-1 ml-2 truncate">
				{project.name}
			</span>
			{hasActivity && (
				<span className="flex items-center ml-auto" title="Terminal activity" style={{ isolation: "isolate" }}>
					<Loader2 size={10} className="animate-spin text-primary opacity-60" />
				</span>
			)}
			{hasError && (
				<span className="flex items-center ml-auto text-yellow-500 animate-pulse" title="Terminal crashed">
					<AlertTriangle size={10} />
				</span>
			)}
			<Archive size={10} className="text-muted-foreground/40 ml-1" />
		</button>
	);
}
