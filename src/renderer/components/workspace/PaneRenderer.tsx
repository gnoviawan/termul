import { useCallback, useEffect, useRef, memo } from "react";
import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@/components/ui/resizable";
import { PaneContent } from "./PaneContent";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { PaneNode, SplitNode, LeafNode } from "@/types/workspace.types";
import type { ShellInfo } from "@shared/types/ipc.types";

interface PaneRendererProps {
	node: PaneNode;
	onAddTerminal?: (paneId: string, shell?: ShellInfo) => void;
	onAddBrowserTab?: (paneId: string) => void;
	onAddGitTab?: (paneId: string) => void;
	onAddTunnelTab?: (paneId: string) => void;
	onCloseTerminal?: (id: string, tabId: string) => void;
	onRenameTerminal?: (id: string, name: string) => void;
	onCloseEditorTab?: (filePath: string) => void;
	closingTerminalIds?: string[];
	defaultShell?: string;
}

export function PaneRenderer({
	node,
	onAddTerminal,
	onAddBrowserTab,
	onAddGitTab,
	onAddTunnelTab,
	onCloseTerminal,
	onRenameTerminal,
	onCloseEditorTab,
	closingTerminalIds,
	defaultShell,
}: PaneRendererProps): React.JSX.Element {
	if (node.type === "leaf") {
		return (
			<PaneLeafRenderer
				pane={node}
				onAddTerminal={onAddTerminal}
				onAddBrowserTab={onAddBrowserTab}
				onAddGitTab={onAddGitTab}
		onAddTunnelTab={onAddTunnelTab}
				onCloseTerminal={onCloseTerminal}
				onRenameTerminal={onRenameTerminal}
				onCloseEditorTab={onCloseEditorTab}
				closingTerminalIds={closingTerminalIds}
				defaultShell={defaultShell}
			/>
		);
	}
	return (
		<PaneSplitRenderer
			node={node}
			onAddTerminal={onAddTerminal}
			onAddBrowserTab={onAddBrowserTab}
			onAddGitTab={onAddGitTab}
			onAddTunnelTab={onAddTunnelTab}
			onCloseTerminal={onCloseTerminal}
			onRenameTerminal={onRenameTerminal}
			onCloseEditorTab={onCloseEditorTab}
			closingTerminalIds={closingTerminalIds}
			defaultShell={defaultShell}
		/>
	);
}

interface PaneLeafRendererProps {
	pane: LeafNode;
	onAddTerminal?: (paneId: string, shell?: ShellInfo) => void;
	onAddBrowserTab?: (paneId: string) => void;
	onAddGitTab?: (paneId: string) => void;
	onAddTunnelTab?: (paneId: string) => void;
	onCloseTerminal?: (id: string, tabId: string) => void;
	onRenameTerminal?: (id: string, name: string) => void;
	onCloseEditorTab?: (filePath: string) => void;
	closingTerminalIds?: string[];
	defaultShell?: string;
}

const PaneLeafRenderer = memo(
	({
		pane,
		onAddTerminal,
		onAddBrowserTab,
		onAddGitTab,
	onAddTunnelTab,
		onCloseTerminal,
		onRenameTerminal,
		onCloseEditorTab,
		closingTerminalIds,
		defaultShell,
	}: PaneLeafRendererProps): React.JSX.Element => {
		return (
			<ErrorBoundary context="Terminal Pane">
				<PaneContent
					pane={pane}
					onAddTerminal={onAddTerminal}
					onAddBrowserTab={onAddBrowserTab}
					onAddGitTab={onAddGitTab}
		onAddTunnelTab={onAddTunnelTab}
					onCloseTerminal={onCloseTerminal}
					onRenameTerminal={onRenameTerminal}
					onCloseEditorTab={onCloseEditorTab}
					closingTerminalIds={closingTerminalIds}
					defaultShell={defaultShell}
				/>
			</ErrorBoundary>
		);
	},
);

interface PaneSplitRendererProps {
	node: SplitNode;
	onAddTerminal?: (paneId: string, shell?: ShellInfo) => void;
	onAddBrowserTab?: (paneId: string) => void;
	onAddGitTab?: (paneId: string) => void;
	onAddTunnelTab?: (paneId: string) => void;
	onCloseTerminal?: (id: string, tabId: string) => void;
	onRenameTerminal?: (id: string, name: string) => void;
	onCloseEditorTab?: (filePath: string) => void;
	closingTerminalIds?: string[];
	defaultShell?: string;
}

const PaneSplitRenderer = memo(
	({
		node,
		onAddTerminal,
		onAddBrowserTab,
		onAddGitTab,
	onAddTunnelTab,
		onCloseTerminal,
		onRenameTerminal,
		onCloseEditorTab,
		closingTerminalIds,
		defaultShell,
	}: PaneSplitRendererProps): React.JSX.Element => {
		const updatePaneSizes = useWorkspaceStore((state) => state.updatePaneSizes);
		const pendingSizesRef = useRef<number[] | null>(null);
		const isDraggingRef = useRef(false);

		const handleLayout = useCallback(
			(sizes: number[]) => {
				pendingSizesRef.current = sizes;
				if (!isDraggingRef.current) {
					updatePaneSizes(node.id, sizes);
					pendingSizesRef.current = null;
				}
			},
			[node.id, updatePaneSizes],
		);

		const handleDragging = useCallback(
			(dragging: boolean) => {
				isDraggingRef.current = dragging;
				if (!dragging && pendingSizesRef.current) {
					updatePaneSizes(node.id, pendingSizesRef.current);
					pendingSizesRef.current = null;
				}
			},
			[node.id, updatePaneSizes],
		);

		useEffect(() => {
			return () => {
				isDraggingRef.current = false;
				pendingSizesRef.current = null;
			};
		}, []);

		return (
			<ResizablePanelGroup
				id={node.id}
				direction={node.direction}
				onLayout={handleLayout}
			>
				{node.children.map((child, index) => (
					<PaneRendererPanel
						key={child.id}
						child={child}
						panelOrder={index}
						defaultSize={node.sizes[index] ?? 50}
						isLast={index === node.children.length - 1}
						onDragging={handleDragging}
						onAddTerminal={onAddTerminal}
						onAddBrowserTab={onAddBrowserTab}
						onAddGitTab={onAddGitTab}
		onAddTunnelTab={onAddTunnelTab}
						onCloseTerminal={onCloseTerminal}
						onRenameTerminal={onRenameTerminal}
						onCloseEditorTab={onCloseEditorTab}
						closingTerminalIds={closingTerminalIds}
						defaultShell={defaultShell}
					/>
				))}
			</ResizablePanelGroup>
		);
	},
);

interface PaneRendererPanelProps {
	child: PaneNode;
	panelOrder: number;
	defaultSize: number;
	isLast: boolean;
	onDragging: (dragging: boolean) => void;
	onAddTerminal?: (paneId: string, shell?: ShellInfo) => void;
	onAddBrowserTab?: (paneId: string) => void;
	onAddGitTab?: (paneId: string) => void;
	onAddTunnelTab?: (paneId: string) => void;
	onCloseTerminal?: (id: string, tabId: string) => void;
	onRenameTerminal?: (id: string, name: string) => void;
	onCloseEditorTab?: (filePath: string) => void;
	closingTerminalIds?: string[];
	defaultShell?: string;
}

const PaneRendererPanel = memo(
	({
		child,
		panelOrder,
		defaultSize,
		isLast,
		onDragging,
		onAddTerminal,
		onAddBrowserTab,
		onAddGitTab,
	onAddTunnelTab,
		onCloseTerminal,
		onRenameTerminal,
		onCloseEditorTab,
		closingTerminalIds,
		defaultShell,
	}: PaneRendererPanelProps): React.JSX.Element => {
		return (
			<>
				<ResizablePanel
					id={child.id}
					order={panelOrder}
					defaultSize={defaultSize}
					minSize={15}
				>
					<PaneRenderer
						node={child}
						onAddTerminal={onAddTerminal}
						onAddBrowserTab={onAddBrowserTab}
						onAddGitTab={onAddGitTab}
		onAddTunnelTab={onAddTunnelTab}
						onCloseTerminal={onCloseTerminal}
						onRenameTerminal={onRenameTerminal}
						onCloseEditorTab={onCloseEditorTab}
						closingTerminalIds={closingTerminalIds}
						defaultShell={defaultShell}
					/>
				</ResizablePanel>
				{!isLast && (
					<ResizableHandle
						withHandle
						onDragging={onDragging}
						className="bg-border/60 hover:bg-primary/40 transition-colors"
					/>
				)}
			</>
		);
	},
);
