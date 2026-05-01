import { useState, useRef, useEffect, useCallback } from "react";
import { useShallow } from "zustand/shallow";
import {
	Plus,
	Terminal as TerminalIcon,
	ChevronDown,
	X as XIcon,
	Edit2,
	Loader2,
	Skull,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { EditorTab } from "./EditorTab";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceStore, editorTabId } from "@/stores/workspace-store";
import { useEditorStore } from "@/stores/editor-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { usePaneDnd } from "@/hooks/use-pane-dnd";
import type { WorkspaceTab } from "@/stores/workspace-store";
import type { ShellInfo, DetectedShells } from "@shared/types/ipc.types";
import type { Terminal } from "@/types/project";
import type { TabReorderPosition } from "@/types/workspace.types";
import { ContextMenu } from "@/components/ContextMenu";
import { shellApi, clipboardApi } from "@/lib/api";

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
						{ label: "Close", icon: <XIcon size={12} />, onClick: onClose },
						{
							label: "Kill Process",
							icon: <Skull size={12} />,
							onClick: onClose,
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

interface WorkspaceTabBarProps {
	paneId: string;
	tabs: WorkspaceTab[];
	activeTabId: string | null;
	closingTerminalIds?: string[];
	onNewTerminal?: () => void;
	onNewTerminalWithShell?: (shell: ShellInfo) => void;
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
	onNewTerminal,
	onNewTerminalWithShell,
	onCloseTerminal,
	onRenameTerminal,
	onCloseEditorTab,
	defaultShell,
}: WorkspaceTabBarProps): React.JSX.Element {
	const setActiveTab = useWorkspaceStore((state) => state.setActiveTab);
	const setActivePane = useWorkspaceStore((state) => state.setActivePane);
	const {
		startTabDrag,
		dragPayload,
		reorderPreview,
		setReorderPreview,
		clearReorderPreview,
		handleTabReorder,
	} = usePaneDnd();

	const [isDropdownOpen, setIsDropdownOpen] = useState(false);
	const [shells, setShells] = useState<DetectedShells | null>(null);
	const [loading, setLoading] = useState(true);
	const [hasOverflow, setHasOverflow] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);
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
				dropdownRef.current &&
				!dropdownRef.current.contains(e.target as Node)
			) {
				setIsDropdownOpen(false);
			}
		};
		if (isDropdownOpen) {
			document.addEventListener("mousedown", handleClickOutside);
		}
		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, [isDropdownOpen]);

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

	const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
		if (tabsContainerRef.current) {
			e.preventDefault();
			tabsContainerRef.current.scrollLeft += e.deltaY;
		}
	}, []);

	const handleSelectShell = useCallback(
		(shell: ShellInfo) => {
			if (onNewTerminalWithShell) {
				onNewTerminalWithShell(shell);
			}
			setIsDropdownOpen(false);
		},
		[onNewTerminalWithShell],
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
				useEditorStore.getState().closeFile(filePath);
				useWorkspaceStore.getState().closeTab(paneId, editorTabId(filePath));
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

	const terminalStoreTerminals = useTerminalStore((state) => state.terminals);

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
			<div className="relative flex items-center h-full min-w-0 shrink">
				<div
					ref={tabsContainerRef}
					onWheel={handleWheel}
					onDragLeave={handleContainerDragLeave}
					className="overflow-x-auto scrollbar-hide flex items-center h-full"
				>
					<div className="flex items-center h-full">
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
									) : (
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

			{/* Split Button: New Terminal */}
			{onNewTerminal && (
				<div
					ref={dropdownRef}
					className="relative flex items-center ml-1 shrink-0"
				>
					<button
						onClick={onNewTerminal}
						className="h-7 w-7 flex items-center justify-center rounded-l hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors border-r border-border/50"
						title="New terminal (default shell)"
					>
						<Plus size={12} />
					</button>
					{onNewTerminalWithShell && (
						<>
							<button
								onClick={() => setIsDropdownOpen(!isDropdownOpen)}
								className="h-7 w-5 flex items-center justify-center rounded-r hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
								title="Select shell"
							>
								<ChevronDown size={12} />
							</button>

							{isDropdownOpen && (
								<div className="absolute top-full left-0 mt-1 w-48 bg-popover border border-border rounded-md shadow-lg z-50">
									{loading ? (
										<div className="py-1 px-3 space-y-2">
											<Skeleton className="h-8 w-full" />
											<Skeleton className="h-8 w-full" />
											<Skeleton className="h-8 w-full" />
										</div>
									) : sortedShells && sortedShells.length > 0 ? (
										<div className="py-1">
											{sortedShells.map((shell) => (
												<button
													key={shell.name}
													onClick={() => handleSelectShell(shell)}
													className={cn(
														"w-full px-3 py-2 text-left text-sm hover:bg-secondary flex items-center gap-2",
														shell.name === defaultShell && "text-primary",
													)}
												>
													<TerminalIcon size={12} />
													<span>{shell.displayName}</span>
													{shell.name === defaultShell && (
														<span className="ml-auto text-xs text-muted-foreground">
															(default)
														</span>
													)}
												</button>
											))}
										</div>
									) : (
										<div className="px-3 py-2 text-sm text-muted-foreground">
											No shells detected
										</div>
									)}
								</div>
							)}
						</>
					)}
				</div>
			)}

			{/* Spacer */}
			<div className="flex-1" />
		</div>
	);
}
