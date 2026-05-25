import { useState, useRef, useEffect, useCallback } from "react";
import { useShallow } from "zustand/shallow";
import {
	Terminal as TerminalIcon,
	X as XIcon,
	Edit2,
	Loader2,
	Skull,
	Globe,
	Maximize2,
	Minimize2,
	GitBranch,
	GitPullRequest,
} from "lucide-react";
import { useGitStatusStore, type GitStatusState } from "@/stores/git-status-store";
import type { GitStatusDetail } from "@shared/types/ipc.types";
import { cn } from "@/lib/utils";
import { EditorTab } from "./EditorTab";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceStore, useLeafCount, editorTabId } from "@/stores/workspace-store";
import { useEditorStore } from "@/stores/editor-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useProjectStore } from "@/stores/project-store";
import { usePaneDnd } from "@/hooks/use-pane-dnd";
import type { WorkspaceTab } from "@/stores/workspace-store";
import type { ShellInfo, DetectedShells } from "@shared/types/ipc.types";
import type { Terminal } from "@/types/project";
import type { TabReorderPosition } from "@/types/workspace.types";
import { ContextMenu } from "@/components/ContextMenu";
import { useBrowserSessionStore } from "@/stores/browser-session-store";
import { useAnnotationStore } from "@/stores/annotation-store";
import { shellApi, clipboardApi } from "@/lib/api";
import { browserTabHide, browserTabShow } from "@/lib/browser-api";

// Helper to compute drop position from mouse coordinates
function computeTabPosition(
	target: HTMLElement,
	clientX: number,
): TabReorderPosition {
	const rect = target.getBoundingClientRect();
	const x = clientX - rect.left;
	const halfWidth = rect.width / 2;
	return x < halfWidth ? "before" : "after";
}

// Inline TerminalTab matching the style from TerminalTabBar

interface TerminalTabInlineProps {
	terminal: Terminal;
	isActive: boolean;
	isDragging: boolean;
	isDropTarget: boolean;
	dropPosition: TabReorderPosition | null;
	isClosing?: boolean;
	onSelect: () => void;
	onClose: () => void;
	onRename: (name: string) => void;
	onDragStart: (e: React.DragEvent) => void;
	onDragOver: (e: React.DragEvent) => void;
	onDragLeave: () => void;
	onDrop: (e: React.DragEvent) => void;
}

function TerminalTabInline({
	terminal,
	isActive,
	isDragging,
	isDropTarget,
	dropPosition,
	isClosing = false,
	onSelect,
	onClose,
	onRename,
	onDragStart,
	onDragOver,
	onDragLeave,
	onDrop,
}: TerminalTabInlineProps): React.JSX.Element {
	const [isEditing, setIsEditing] = useState(false);
	const [editName, setEditName] = useState(terminal.name);
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
	} | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (isEditing && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [isEditing]);

	const handleDoubleClick = useCallback(() => {
		setEditName(terminal.name);
		setIsEditing(true);
	}, [terminal.name]);

	const handleSave = useCallback(() => {
		const trimmedName = editName.trim();
		if (trimmedName && trimmedName !== terminal.name) {
			onRename(trimmedName);
		}
		setIsEditing(false);
	}, [editName, terminal.name, onRename]);

	const handleCancel = useCallback(() => {
		setEditName(terminal.name);
		setIsEditing(false);
	}, [terminal.name]);

	return (
		<>
			<div
				draggable={!isEditing}
				onDragStart={onDragStart}
				onDragOver={onDragOver}
				onDragLeave={onDragLeave}
				onDrop={onDrop}
				onClick={onSelect}
				onContextMenu={(e) => {
					e.preventDefault();
					e.stopPropagation();
					setContextMenu({ x: e.clientX, y: e.clientY });
				}}
				className={cn(
					"relative h-full px-3 flex items-center border-r border-border min-w-[100px] cursor-pointer group transition-all duration-150 ease-out border-b-2 border-b-transparent",
					isActive
						? "bg-background border-b-primary"
						: "hover:bg-secondary/50 text-muted-foreground",
					isDragging && "opacity-50 scale-[0.98]",
				)}
			>
				{/* Drop indicator line */}
				{isDropTarget && dropPosition === "before" && (
					<div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
				)}
				{isDropTarget && dropPosition === "after" && (
					<div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
				)}

				<TerminalIcon
					size={12}
					className={cn("mr-2", isActive ? "text-primary" : "")}
				/>
				{isEditing ? (
					<input
						ref={inputRef}
						type="text"
						value={editName}
						onChange={(e) => setEditName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								handleSave();
							} else if (e.key === "Escape") {
								e.preventDefault();
								handleCancel();
							}
						}}
						onBlur={handleSave}
						onClick={(e) => e.stopPropagation()}
						className="text-[11px] font-medium bg-transparent border-b border-primary outline-none w-full"
					/>
				) : (
					<span
						onDoubleClick={handleDoubleClick}
						className={cn("text-[11px] font-medium", isActive && "text-foreground")}
					>
						{terminal.name}
					</span>
				)}
				<button
					onClick={(e) => {
						e.stopPropagation();
						if (!isClosing) {
							onClose();
						}
					}}
					disabled={isClosing}
					className="ml-auto p-0.5 rounded-md hover:bg-secondary opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-100 disabled:cursor-wait"
				>
					{isClosing ? (
						<Loader2 size={11} className="animate-spin" />
					) : (
						<XIcon size={11} />
					)}
				</button>
			</div>

			{contextMenu && (
				<ContextMenu
					items={[
						{
							label: "Rename",
							icon: <Edit2 size={12} />,
							onClick: () => {
								setEditName(terminal.name);
								setIsEditing(true);
							},
						},
						{
							label: "Close",
							icon: <XIcon size={12} />,
							onClick: () => {
								if (!isClosing) {
									onClose();
								}
							},
						},
						{
							label: "Kill Process",
							icon: <Skull size={12} />,
							onClick: () => {
								if (!isClosing) {
									onClose();
								}
							},
							variant: "danger",
						},
					]}
					x={contextMenu.x}
					y={contextMenu.y}
					onClose={() => setContextMenu(null)}
				/>
			)}
		</>
	);
}

interface EditorTabWrapperProps {
	tab: { type: "editor"; id: string; filePath: string };
	isActive: boolean;
	isDragging: boolean;
	isDropTarget: boolean;
	dropPosition: TabReorderPosition | null;
	onSelect: () => void;
	onClose: () => void;
	onCloseOthers: () => void;
	onCloseAll: () => void;
	onCopyPath: () => void;
	onDragStart: (e: React.DragEvent) => void;
	onDragOver: (e: React.DragEvent) => void;
	onDragLeave: () => void;
	onDrop: (e: React.DragEvent) => void;
}

function EditorTabWrapper({
	tab,
	isActive,
	isDragging,
	isDropTarget,
	dropPosition,
	onSelect,
	onClose,
	onCloseOthers,
	onCloseAll,
	onCopyPath,
	onDragStart,
	onDragOver,
	onDragLeave,
	onDrop,
}: EditorTabWrapperProps): React.JSX.Element {
	const { isDirty, operationStatus } = useEditorStore(
		useShallow((state) => {
			const file = state.openFiles.get(tab.filePath);
			return {
				isDirty: file?.isDirty ?? false,
				operationStatus: file?.operationStatus ?? "idle",
			};
		}),
	);
	return (
		<div
			draggable
			onDragStart={onDragStart}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
			className={cn(
				"relative h-full transition-all duration-150 ease-out",
				isDragging && "opacity-50 scale-[0.98]",
			)}
		>
			{/* Drop indicator line */}
			{isDropTarget && dropPosition === "before" && (
				<div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary rounded-full z-10" />
			)}
			{isDropTarget && dropPosition === "after" && (
				<div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary rounded-full z-10" />
			)}
			<EditorTab
				filePath={tab.filePath}
				isActive={isActive}
				isDirty={isDirty}
				operationStatus={operationStatus}
				onSelect={onSelect}
				onClose={onClose}
				onCloseOthers={onCloseOthers}
				onCloseAll={onCloseAll}
				onCopyPath={onCopyPath}
			/>
		</div>
	);
}

interface BrowserTabInlineProps {
	tab: { type: "browser"; id: string; browserTabId: string };
	isActive: boolean;
	isDragging: boolean;
	isDropTarget: boolean;
	dropPosition: TabReorderPosition | null;
	onSelect: () => void;
	onClose: () => void;
	onDragStart: (e: React.DragEvent) => void;
	onDragOver: (e: React.DragEvent) => void;
	onDragLeave: () => void;
	onDrop: (e: React.DragEvent) => void;
}

function BrowserTabInline({
	tab,
	isActive,
	isDragging,
	isDropTarget,
	dropPosition,
	onSelect,
	onClose,
	onDragStart,
	onDragOver,
	onDragLeave,
	onDrop,
}: BrowserTabInlineProps): React.JSX.Element {
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
	} | null>(null);
	const browserTab = useBrowserSessionStore((state) => state.getTab(tab.browserTabId));
	const label = (() => {
		if (!browserTab) return "Browser";
		if (browserTab.title.trim()) return browserTab.title.trim();
		if (browserTab.url) {
			try {
				const parsed = new URL(browserTab.url);
				return parsed.host || parsed.hostname || browserTab.url;
			} catch {
				return browserTab.url.replace(/^https?:\/\//, "").split("/")[0] || "Browser";
			}
		}
		return "Browser";
	})();

	return (
		<>
			<div
				draggable
				onDragStart={onDragStart}
				onDragOver={onDragOver}
				onDragLeave={onDragLeave}
				onDrop={onDrop}
				onClick={onSelect}
				onContextMenu={(e) => {
					e.preventDefault();
					e.stopPropagation();
					setContextMenu({ x: e.clientX, y: e.clientY });
				}}
				className={cn(
					"relative h-full px-3 flex items-center border-r border-border min-w-[100px] cursor-pointer group transition-all duration-150 ease-out border-b-2 border-b-transparent",
					isActive
						? "bg-background border-b-primary"
						: "hover:bg-secondary/50 text-muted-foreground",
					isDragging && "opacity-50 scale-[0.98]",
				)}
			>
				{/* Drop indicator line */}
				{isDropTarget && dropPosition === "before" && (
					<div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
				)}
				{isDropTarget && dropPosition === "after" && (
					<div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
				)}

				<Globe
					size={12}
					className={cn("mr-2", isActive ? "text-primary" : "")}
				/>
				<span className={cn("text-[11px] font-medium truncate", isActive && "text-foreground")}>
					{label}
				</span>
				<button
					onClick={(e) => {
						e.stopPropagation();
						onClose();
					}}
					className="ml-auto p-0.5 rounded-md hover:bg-secondary opacity-0 group-hover:opacity-100 transition-opacity"
				>
					<XIcon size={11} />
				</button>
			</div>

			{contextMenu && (
				<ContextMenu
					items={[
						{
							label: "Close",
							icon: <XIcon size={12} />,
							onClick: onClose,
						},
					]}
					x={contextMenu.x}
					y={contextMenu.y}
					onClose={() => setContextMenu(null)}
				/>
			)}
		</>
	);
}

function GitTabInline({
	tab,
	isActive,
	isDragging,
	isDropTarget,
	dropPosition,
	onSelect,
	onClose,
	onDragStart,
	onDragOver,
	onDragLeave,
	onDrop,
}: {
	tab: { type: "git"; id: string; cwd: string };
	isActive: boolean;
	isDragging: boolean;
	isDropTarget: boolean;
	dropPosition: TabReorderPosition | null;
	onSelect: () => void;
	onClose: () => void;
	onDragStart: (e: React.DragEvent) => void;
	onDragOver: (e: React.DragEvent) => void;
	onDragLeave: () => void;
	onDrop: (e: React.DragEvent) => void;
}) {
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
	} | null>(null);

	const totalChanges = useGitStatusStore((state: GitStatusState) => (state.statuses[tab.cwd] || []).length);

	return (
		<>
			<div
				draggable
				onDragStart={onDragStart}
				onDragOver={onDragOver}
				onDragLeave={onDragLeave}
				onDrop={onDrop}
				onClick={onSelect}
				onContextMenu={(e) => {
					e.preventDefault();
					setContextMenu({ x: e.clientX, y: e.clientY });
				}}
				className={cn(
					"group relative flex items-center h-7 px-3 min-w-[120px] max-w-[200px] gap-2 cursor-pointer select-none border-r border-border/40 transition-colors",
					isActive
						? "bg-secondary text-foreground"
						: "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
					isDragging && "opacity-50",
					isDropTarget &&
						dropPosition === "before" &&
						"border-l-2 border-l-primary",
					isDropTarget &&
						dropPosition === "after" &&
						"border-r-2 border-r-primary",
				)}
			>
				<GitBranch size={12} className={isActive ? "text-primary" : ""} />
				<span className="truncate text-[11px] font-medium flex-1">
					Git Changes
				</span>
				{totalChanges > 0 && (
					<span
						className={cn(
							"px-1 min-w-[14px] h-3.5 flex items-center justify-center rounded-full text-[9px] font-bold",
							isActive
								? "bg-primary text-primary-foreground"
								: "bg-muted-foreground/20 text-muted-foreground",
						)}
					>
						{totalChanges}
					</span>
				)}
				<button
					onClick={(e) => {
						e.stopPropagation();
						onClose();
					}}
					className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-background/50 transition-opacity"
				>
					<XIcon size={10} />
				</button>

				{isActive && (
					<div className="absolute bottom-0 left-0 right-0 h-[1.5px] bg-primary" />
				)}
			</div>

			{contextMenu && (
				<ContextMenu
					items={[
						{
							label: "Close",
							icon: <XIcon size={12} />,
							onClick: onClose,
						},
					]}
					x={contextMenu.x}
					y={contextMenu.y}
					onClose={() => setContextMenu(null)}
				/>
			)}
		</>
	);
}

interface WorkspaceTabBarProps {
	paneId: string;
	tabs: WorkspaceTab[];
	activeTabId: string | null;
	closingTerminalIds?: string[];
	onAddTerminal?: (shell?: ShellInfo) => void;
	onAddBrowserTab?: () => void;
	onAddGitTab?: () => void;
	onCloseTerminal?: (id: string, tabId: string) => void;
	onRenameTerminal?: (id: string, name: string) => void;
	onCloseEditorTab?: (filePath: string) => void;
	defaultShell?: string;
}

export function WorkspaceTabBar({
	paneId,
	tabs,
	activeTabId,
	closingTerminalIds = [],
	onAddTerminal,
	onAddBrowserTab,
	onAddGitTab,
	onCloseTerminal,
	onRenameTerminal,
	onCloseEditorTab,
	defaultShell,
}: WorkspaceTabBarProps): React.JSX.Element {
	const { setActiveTab, setActivePane, fullscreenPaneId, togglePaneFullscreen } =
		useWorkspaceStore(
			useShallow((state) => ({
				setActiveTab: state.setActiveTab,
				setActivePane: state.setActivePane,
				fullscreenPaneId: state.fullscreenPaneId,
				togglePaneFullscreen: state.togglePaneFullscreen,
			}))
		);
	const leafCount = useLeafCount();
	const {
		startTabDrag,
		dragPayload,
		reorderPreview,
		setReorderPreview,
		clearReorderPreview,
		handleTabReorder,
	} = usePaneDnd();

	const [isTerminalMenuOpen, setIsTerminalMenuOpen] = useState(false);
	const [shells, setShells] = useState<DetectedShells | null>(null);
	const [loading, setLoading] = useState(true);
	const [hasOverflow, setHasOverflow] = useState(false);
	const terminalMenuRef = useRef<HTMLDivElement>(null);
	const tabsContainerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const fetchShells = async (): Promise<void> => {
			try {
				const result = await shellApi.getAvailableShells();
				if (result.success) {
					setShells(result.data);
				}
			} catch {
				setShells(null);
			} finally {
				setLoading(false);
			}
		};
		void fetchShells();
	}, []);

	useEffect(() => {
		const handleClickOutside = (e: globalThis.MouseEvent): void => {
			if (
				terminalMenuRef.current &&
				!terminalMenuRef.current.contains(e.target as Node)
			) {
				setIsTerminalMenuOpen(false);
			}
		};
		if (isTerminalMenuOpen) {
			document.addEventListener("mousedown", handleClickOutside);
		}
		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, [isTerminalMenuOpen]);

	useEffect(() => {
		const checkOverflow = (): void => {
			if (tabsContainerRef.current) {
				const { scrollWidth, clientWidth } = tabsContainerRef.current;
				setHasOverflow(scrollWidth > clientWidth);
			}
		};
		checkOverflow();
		window.addEventListener("resize", checkOverflow);
		return () => window.removeEventListener("resize", checkOverflow);
	}, [tabs.length]);

	// Native child webviews paint above the DOM, so the terminal popover would be
	// obscured unless we temporarily hide browser webviews while the menu is open.
	useEffect(() => {
		const browserTabs = tabs.filter(
			(tab): tab is WorkspaceTab & { type: "browser"; browserTabId: string } =>
				tab.type === "browser",
		);
		if (browserTabs.length === 0) return;

		const hideAll = (tabsToHide: Array<{ browserTabId: string }>): void => {
			for (const tab of tabsToHide) {
				void browserTabHide(tab.browserTabId).catch(console.error);
			}
		};

		const showActive = (activeBrowserTab?: { browserTabId: string }): void => {
			if (activeBrowserTab) {
				void browserTabShow(activeBrowserTab.browserTabId).catch(console.error);
			}
		};

		if (isTerminalMenuOpen) {
			hideAll(browserTabs);
			return;
		}

		const activeBrowserTab = browserTabs.find((tab) => tab.id === activeTabId);
		showActive(activeBrowserTab);
	}, [isTerminalMenuOpen, tabs, activeTabId]);

	const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
		if (tabsContainerRef.current) {
			e.preventDefault();
			tabsContainerRef.current.scrollLeft += e.deltaY;
		}
	}, []);

	const handleSelectShell = useCallback(
		(shell: ShellInfo) => {
			if (onAddTerminal) {
				onAddTerminal(shell);
			}
			setIsTerminalMenuOpen(false);
		},
		[onAddTerminal],
	);

	const handleCloseEditorTab = useCallback(
		(filePath: string) => {
			const operationStatus =
				useEditorStore.getState().openFiles.get(filePath)?.operationStatus ??
				"idle";
			if (operationStatus === "saving" || operationStatus === "reloading") {
				return;
			}

			if (onCloseEditorTab) {
				onCloseEditorTab(filePath);
			} else {
				// Fallback: close from store directly
				const didClose = useEditorStore.getState().closeFileIfIdle(filePath);
				if (didClose) {
					useWorkspaceStore.getState().closeTab(paneId, editorTabId(filePath));
				}
			}
		},
		[onCloseEditorTab, paneId],
	);

	const handleCloseOtherEditorTabs = useCallback(
		(filePath: string) => {
			const editorTabs = tabs.filter(
				(t): t is WorkspaceTab & { type: "editor" } =>
					t.type === "editor" && t.filePath !== filePath,
			);
			for (const tab of editorTabs) {
				handleCloseEditorTab(tab.filePath);
			}
		},
		[tabs, handleCloseEditorTab],
	);

	const handleCloseAllEditorTabs = useCallback(() => {
		const editorTabs = tabs.filter(
			(t): t is WorkspaceTab & { type: "editor" } => t.type === "editor",
		);
		for (const tab of editorTabs) {
			handleCloseEditorTab(tab.filePath);
		}
	}, [tabs, handleCloseEditorTab]);

	const handleTabDragStart = useCallback(
		(tabId: string, e: React.DragEvent) => {
			startTabDrag(tabId, paneId, e);
		},
		[startTabDrag, paneId],
	);

	const handleTabDragOver = useCallback(
		(tabId: string, e: React.DragEvent) => {
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";

			if (!dragPayload || dragPayload.type !== "tab") return;
			if (dragPayload.sourcePaneId !== paneId) return;

			const position = computeTabPosition(
				e.currentTarget as HTMLElement,
				e.clientX,
			);
			setReorderPreview(paneId, tabId, position);
		},
		[dragPayload, paneId, setReorderPreview],
	);

	const handleTabDragLeave = useCallback(() => {
		// Only clear if we're not entering a child element
		// This is handled by the individual tab components
	}, []);

	const handleContainerDragLeave = useCallback(
		(e: React.DragEvent) => {
			// Only clear preview if actually leaving the container (not moving to child)
			const relatedTarget = e.relatedTarget as Node | null;
			if (relatedTarget && e.currentTarget.contains(relatedTarget)) {
				return;
			}
			clearReorderPreview();
		},
		[clearReorderPreview],
	);

	const handleTabDrop = useCallback(
		(tabId: string, e: React.DragEvent) => {
			// Only prevent/stop if this is a same-pane tab reorder
			// Otherwise, let the event bubble for cross-pane drops
			if (
				!dragPayload ||
				dragPayload.type !== "tab" ||
				dragPayload.sourcePaneId !== paneId
			) {
				return;
			}

			e.preventDefault();
			e.stopPropagation();

			const position = computeTabPosition(
				e.currentTarget as HTMLElement,
				e.clientX,
			);
			handleTabReorder(paneId, tabId, position);
		},
		[dragPayload, paneId, handleTabReorder],
	);

	const sortedShells = shells?.available?.slice().sort((a, b) => {
		if (defaultShell) {
			if (a.name === defaultShell) return -1;
			if (b.name === defaultShell) return 1;
		}
		return a.displayName.localeCompare(b.displayName);
	});

	const activeProjectId = useProjectStore((state) => state.activeProjectId);
	const terminalStoreTerminals = useTerminalStore(
		useShallow((state) =>
			activeProjectId
				? state.terminals.filter((t) => t.projectId === activeProjectId)
				: [],
		),
	);
	const isFullscreenPane = fullscreenPaneId === paneId;

	// Check if this tab is being dragged
	const isTabDragging = (tabId: string): boolean =>
		dragPayload?.type === "tab" && dragPayload.tabId === tabId;

	// Check if this tab is a drop target
	const isTabDropTarget = (
		tabId: string,
	): { isTarget: boolean; position: TabReorderPosition | null } => {
		if (!reorderPreview || reorderPreview.paneId !== paneId) {
			return { isTarget: false, position: null };
		}
		if (reorderPreview.targetTabId === tabId) {
			return { isTarget: true, position: reorderPreview.position };
		}
		return { isTarget: false, position: null };
	};

	return (
		<div
			className="h-9 bg-card border-b border-border flex items-center"
			onDragOver={(e) => {
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
			}}
		>
			<div className="relative flex items-center h-full min-w-0 flex-1 overflow-hidden">
				<div
					ref={tabsContainerRef}
					onWheel={handleWheel}
					onDragLeave={handleContainerDragLeave}
					className="overflow-x-auto scrollbar-hide flex items-center h-full min-w-0 flex-1"
				>
					<div className="flex items-center h-full min-w-max">
						{tabs.map((tab) => {
							const dragging = isTabDragging(tab.id);
							const { isTarget, position } = isTabDropTarget(tab.id);

							return (
								<div key={tab.id} className="list-none h-full">
									{tab.type === "terminal" ? (
										(() => {
											const terminal = terminalStoreTerminals.find(
												(t) => t.id === tab.terminalId,
											);
											if (!terminal) return null;
											return (
												<TerminalTabInline
													terminal={terminal}
													isActive={tab.id === activeTabId}
													isDragging={dragging}
													isDropTarget={isTarget}
													dropPosition={position}
													isClosing={closingTerminalIds.includes(
														tab.terminalId,
													)}
													onSelect={() => {
														setActiveTab(paneId, tab.id);
														setActivePane(paneId);
													}}
													onClose={() => {
														if (onCloseTerminal)
															onCloseTerminal(tab.terminalId, tab.id);
													}}
													onRename={(name) => {
														if (onRenameTerminal)
															onRenameTerminal(tab.terminalId, name);
													}}
													onDragStart={(e) => handleTabDragStart(tab.id, e)}
													onDragOver={(e) => handleTabDragOver(tab.id, e)}
													onDragLeave={handleTabDragLeave}
													onDrop={(e) => handleTabDrop(tab.id, e)}
												/>
											);
										})()
									) : tab.type === "editor" ? (
										<EditorTabWrapper
											tab={
												tab as { type: "editor"; id: string; filePath: string }
											}
											isActive={tab.id === activeTabId}
											isDragging={dragging}
											isDropTarget={isTarget}
											dropPosition={position}
											onSelect={() => {
												setActiveTab(paneId, tab.id);
												setActivePane(paneId);
											}}
											onClose={() => handleCloseEditorTab(tab.filePath)}
											onCloseOthers={() =>
												handleCloseOtherEditorTabs(tab.filePath)
											}
											onCloseAll={handleCloseAllEditorTabs}
											onCopyPath={() =>
												void clipboardApi.writeText(tab.filePath)
											}
											onDragStart={(e) => handleTabDragStart(tab.id, e)}
											onDragOver={(e) => handleTabDragOver(tab.id, e)}
											onDragLeave={handleTabDragLeave}
											onDrop={(e) => handleTabDrop(tab.id, e)}
										/>
									) : tab.type === "git" ? (
										<GitTabInline
											tab={tab as { type: "git"; id: string; cwd: string }}
											isActive={tab.id === activeTabId}
											isDragging={dragging}
											isDropTarget={isTarget}
											dropPosition={position}
											onSelect={() => {
												setActiveTab(paneId, tab.id);
												setActivePane(paneId);
											}}
											onClose={() => {
												useWorkspaceStore.getState().removeTab(tab.id);
											}}
											onDragStart={(e) => handleTabDragStart(tab.id, e)}
											onDragOver={(e) => handleTabDragOver(tab.id, e)}
											onDragLeave={handleTabDragLeave}
											onDrop={(e) => handleTabDrop(tab.id, e)}
										/>
									) : (
										<BrowserTabInline
											tab={
												tab as { type: "browser"; id: string; browserTabId: string }
											}
											isActive={tab.id === activeTabId}
											isDragging={dragging}
											isDropTarget={isTarget}
											dropPosition={position}
											onSelect={() => {
												setActiveTab(paneId, tab.id);
												setActivePane(paneId);
											}}
											onClose={() => {
												useBrowserSessionStore.getState().removeTab(tab.browserTabId)
												useAnnotationStore.getState().clearAnnotationsForTab(tab.browserTabId)
												useWorkspaceStore.getState().closeTab(paneId, tab.id)
											}}
											onDragStart={(e) => handleTabDragStart(tab.id, e)}
											onDragOver={(e) => handleTabDragOver(tab.id, e)}
											onDragLeave={handleTabDragLeave}
											onDrop={(e) => handleTabDrop(tab.id, e)}
										/>
									)}
								</div>
							);
						})}
					</div>
				</div>

				{hasOverflow && (
					<div className="absolute right-0 top-0 h-full w-8 bg-gradient-to-l from-card to-transparent pointer-events-none" />
				)}
			</div>

			<div className="ml-auto flex items-center gap-1 px-2 shrink-0 h-full border-l border-border/60">
				{leafCount > 1 && (
					<button
						onClick={() => togglePaneFullscreen(paneId)}
						className="h-7 w-7 flex items-center justify-center rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
						title={isFullscreenPane ? "Restore pane layout" : "Focus pane"}
						aria-label={isFullscreenPane ? "Restore pane layout" : "Focus pane"}
					>
						{isFullscreenPane ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
					</button>
				)}
				{onAddTerminal && (
					<div ref={terminalMenuRef} className="relative flex items-center h-full">
						<button
							onClick={() => setIsTerminalMenuOpen((open) => !open)}
							className="h-7 w-7 flex items-center justify-center rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
							title="Open terminal menu"
						>
							<TerminalIcon size={12} />
						</button>

						{isTerminalMenuOpen && (
							<div className="absolute top-full right-0 mt-1 w-44 bg-popover border border-border rounded-md shadow-lg z-50 overflow-hidden">
								<div className="px-2.5 py-1 text-[11px] font-medium text-muted-foreground bg-secondary/30">
									Terminal
								</div>
								{loading ? (
									<div className="py-1 px-2.5 space-y-1.5">
										<Skeleton className="h-6 w-full" />
										<Skeleton className="h-6 w-full" />
									</div>
								) : sortedShells && sortedShells.length > 0 ? (
									<div className="py-1">
										{sortedShells.map((shell) => (
											<button
												key={shell.name}
												onClick={() => handleSelectShell(shell)}
												className={cn(
													"w-full px-2.5 py-1.5 text-left text-[11px] hover:bg-secondary flex items-center gap-2 leading-none",
													shell.name === defaultShell && "text-primary",
												)}
											>
												<TerminalIcon size={11} />
												<span className="truncate">{shell.displayName}</span>
												{shell.name === defaultShell && (
													<span className="ml-auto text-[10px] text-muted-foreground">
														(default)
													</span>
												)}
											</button>
										))}
									</div>
								) : (
									<div className="px-2.5 py-1.5 text-[11px] text-muted-foreground">
										No shells detected
									</div>
								)}
							</div>
						)}
					</div>
				)}

				{onAddBrowserTab && (
					<button
						onClick={onAddBrowserTab}
						className="h-7 w-7 flex items-center justify-center rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
						title="New Browser Tab"
					>
						<Globe size={12} />
					</button>
				)}

				{onAddGitTab && (
					<button
						onClick={onAddGitTab}
						className="h-7 w-7 flex items-center justify-center rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
						title="Git Changes"
					>
						<GitBranch size={12} />
					</button>
				)}
			</div>
		</div>
	);
}
