import { useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import { WorkspaceTabBar } from "./WorkspaceTabBar";
import { DropZoneOverlay } from "./DropZoneOverlay";
import { ConnectedTerminal } from "@/components/terminal/ConnectedTerminal";
import { EditorPanel } from "@/components/editor/EditorPanel";
import { useWorkspaceStore, getAllLeafPanes } from "@/stores/workspace-store";
import { useTerminalStore, useTerminalActions } from "@/stores/terminal-store";
import { usePaneDnd } from "@/hooks/use-pane-dnd";
import type { LeafNode } from "@/types/workspace.types";
import type { WorkspaceTab } from "@/stores/workspace-store";
import type { ShellInfo } from "@shared/types/ipc.types";

// Import useShallow for selective re-rendering
import { useShallow } from "zustand/shallow";

interface PaneContentProps {
	pane: LeafNode;
	onNewTerminal?: (paneId: string) => void;
	onNewTerminalWithShell?: (paneId: string, shell: ShellInfo) => void;
	onCloseTerminal?: (id: string, tabId: string) => void;
	onRenameTerminal?: (id: string, name: string) => void;
	onCloseEditorTab?: (filePath: string) => void;
	closingTerminalIds?: string[];
	defaultShell?: string;
}

export function PaneContent({
	pane,
	onNewTerminal,
	onNewTerminalWithShell,
	onCloseTerminal,
	onRenameTerminal,
	onCloseEditorTab,
	closingTerminalIds = [],
	defaultShell,
}: PaneContentProps): React.JSX.Element {
	const paneId = pane.id;

	// CRITICAL FIX: Get terminal IDs from this pane's tabs
	const terminalIdsInPane = useMemo(
		() =>
			new Set(
				pane.tabs.filter((t) => t.type === "terminal").map((t) => t.terminalId),
			),
		[pane.tabs],
	);

	// CRITICAL FIX: Only subscribe to terminals' essential properties (not output!)
	// This prevents re-renders when terminal output changes
	const terminalsInPane = useTerminalStore(
		useShallow((state) =>
			state.terminals.filter((t) => terminalIdsInPane.has(t.id)),
		),
	);

	// FIX: Batch workspace store subscriptions with useShallow to prevent cascading re-renders
	const { activePaneId, setActivePane } = useWorkspaceStore(
		useShallow((state) => ({
			activePaneId: state.activePaneId,
			setActivePane: state.setActivePane,
		})),
	);

	const hasMultiplePanes = useWorkspaceStore(
		(state) => getAllLeafPanes(state.root).length > 1,
	);

	const { setTerminalPtyId } = useTerminalActions();
	const { isDragging, previewTarget } = usePaneDnd();

	const isActivePane = activePaneId === pane.id;
	const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
	const panePreviewPosition =
		previewTarget?.paneId === pane.id ? previewTarget.position : null;

	const handleFocus = useCallback(() => {
		if (!isActivePane) {
			setActivePane(pane.id);
		}
	}, [isActivePane, setActivePane, pane.id]);

	const previewSpaceClass =
		panePreviewPosition === "left"
			? "pl-6"
			: panePreviewPosition === "right"
				? "pr-6"
				: panePreviewPosition === "top"
					? "pt-6"
					: panePreviewPosition === "bottom"
						? "pb-6"
						: "";

	const previewTranslateClass =
		panePreviewPosition === "left"
			? "translate-x-2"
			: panePreviewPosition === "right"
				? "-translate-x-2"
				: panePreviewPosition === "top"
					? "translate-y-2"
					: panePreviewPosition === "bottom"
						? "-translate-y-2"
						: "";

	return (
		<div
			className={cn(
				"flex flex-col h-full relative",
				isActivePane && hasMultiplePanes && "ring-1 ring-primary/30",
			)}
			onMouseDown={handleFocus}
		>
			<WorkspaceTabBar
				paneId={pane.id}
				tabs={pane.tabs}
				activeTabId={pane.activeTabId}
				closingTerminalIds={closingTerminalIds}
				onNewTerminal={useMemo(
					() => (onNewTerminal ? () => onNewTerminal(pane.id) : undefined),
					[onNewTerminal, pane.id],
				)}
				onNewTerminalWithShell={useMemo(
					() =>
						onNewTerminalWithShell
							? (shell) => onNewTerminalWithShell(pane.id, shell)
							: undefined,
					[onNewTerminalWithShell, pane.id],
				)}
				onCloseTerminal={onCloseTerminal}
				onRenameTerminal={onRenameTerminal}
				onCloseEditorTab={onCloseEditorTab}
				defaultShell={defaultShell}
			/>

			<div className="flex-1 overflow-hidden bg-terminal-bg relative h-full">
				<div
					className={cn(
						"w-full h-full relative transition-all duration-150 ease-out",
						previewSpaceClass,
					)}
				>
					{(panePreviewPosition === "left" ||
						panePreviewPosition === "right") && (
						<div
							className={cn(
								"absolute top-0 bottom-0 w-5 rounded-sm border border-primary/40 bg-primary/10 pointer-events-none",
								panePreviewPosition === "left" ? "left-0" : "right-0",
							)}
						/>
					)}
					{(panePreviewPosition === "top" ||
						panePreviewPosition === "bottom") && (
						<div
							className={cn(
								"absolute left-0 right-0 h-5 rounded-sm border border-primary/40 bg-primary/10 pointer-events-none",
								panePreviewPosition === "top" ? "top-0" : "bottom-0",
							)}
						/>
					)}

					<div
						className={cn(
							"w-full h-full relative transition-transform duration-150 ease-out",
							previewTranslateClass,
						)}
					>
						{pane.tabs
							.filter(
								(t): t is WorkspaceTab & { type: "terminal" } =>
									t.type === "terminal",
							)
							.map((tab, index) => {
								const terminal = terminalsInPane.find(
									(t) => t.id === tab.terminalId,
								);
								if (!terminal) {
									return null;
								}
								// CRITICAL: Skip rendering if terminal doesn't have a PTY ID yet
								// This prevents spawn loops when workspace tabs aren't fully synced
								if (!terminal.ptyId) {
									const isVisible = activeTab?.id === tab.id;
									return (
										<div
											key={tab.id}
											className={
												isVisible
													? "w-full h-full flex items-center justify-center text-muted-foreground text-sm"
													: "hidden"
											}
										>
											Connecting...
										</div>
									);
								}
								const isVisible = activeTab?.id === tab.id;
								return (
									<div
										key={tab.id}
										className={
											isVisible
												? "w-full h-full"
												: "w-full h-full absolute inset-0 invisible"
										}
									>
										<ConnectedTerminal
											terminalId={terminal.ptyId}
											storeTerminalId={terminal.id}
											autoSpawn={false}
											spawnOptions={{
												projectId: terminal.projectId,
												shell: terminal.shell,
												cwd: terminal.cwd,
											}}
											onBoundToStoreTerminal={(ptyId) => {
												if (terminal.ptyId !== ptyId) {
													setTerminalPtyId(terminal.id, ptyId);
												}
											}}
											initialScrollback={terminal.pendingScrollback}
											className="w-full h-full"
											isVisible={isVisible}
										/>
									</div>
								);
							})}

						{pane.tabs
							.filter(
								(t): t is WorkspaceTab & { type: "editor" } =>
									t.type === "editor",
							)
							.map((tab) => {
								const isVisible = activeTab?.id === tab.id;
								return (
									<div
										key={tab.id}
										className={
											isVisible
												? "w-full h-full"
												: "w-full h-full absolute inset-0 invisible"
										}
									>
										<EditorPanel
											filePath={tab.filePath}
											isVisible={isVisible}
										/>
									</div>
								);
							})}

						{pane.tabs.length === 0 && (
							<div className="absolute inset-0 flex items-center justify-center">
								<span className="text-muted-foreground text-sm">
									Drag a tab or file here
								</span>
							</div>
						)}
					</div>
				</div>

				{isDragging && <DropZoneOverlay paneId={pane.id} />}
			</div>
		</div>
	);
}
