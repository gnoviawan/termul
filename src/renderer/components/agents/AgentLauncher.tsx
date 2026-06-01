import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, CornerDownLeft, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { memo } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import {
	BUILT_IN_AGENTS,
	type TerminalAgentDefinition,
} from '@/lib/agents/agent-registry'
import { loadAllAgents, upsertCustomAgent } from '@/lib/agents/custom-agents'
import { launchAgentInPane } from '@/lib/agent-launch'
import { persistenceApi } from '@/lib/api'
import { PersistenceKeys } from '@shared/types/persistence.types'
import { useProjectStore } from '@/stores/project-store'
import { useMaxTerminalsPerProject } from '@/stores/app-settings-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { CustomAgentDialog } from './CustomAgentDialog'

/**
 * ADR-004.5: The "blank tab" agent launch surface.
 *
 * Rendered inside the existing empty-pane state (PaneContent) or as an overlay.
 * Presents a prompt textarea with an agent dropdown in the top-left, plus a
 * "New custom agent" option that opens a creation dialog. The selected agent
 * persists across sessions via persistenceApi.
 */

interface AgentLauncherProps {
	paneId: string
	/** Override the agent list (mainly for tests). Defaults to built-ins + custom. */
	agents?: readonly TerminalAgentDefinition[]
	className?: string
}

const AGENT_SELECT_NONE = '__none__'
const AGENT_SELECT_NEW = '__new__'

export function AgentLauncher({
	paneId,
	agents: agentsProp,
	className,
}: AgentLauncherProps): React.JSX.Element {
	const [prompt, setPrompt] = useState('')
	const [loadedAgents, setLoadedAgents] = useState<readonly TerminalAgentDefinition[]>(
		BUILT_IN_AGENTS,
	)
	const agents = agentsProp ?? loadedAgents
	const [selectedAgentId, setSelectedAgentId] = useState<string>(agents[0]?.id ?? '')
	const [isLaunching, setIsLaunching] = useState(false)
	const [showCreateDialog, setShowCreateDialog] = useState(false)

	// Load built-in + custom agents once (skipped when an explicit list is passed).
	useEffect(() => {
		if (agentsProp) return
		let cancelled = false
		void loadAllAgents()
			.then((all) => {
				if (!cancelled && all.length > 0) {
					setLoadedAgents(all)
				}
			})
			.catch(() => {
				/* fall back to built-ins already in state */
			})
		return () => {
			cancelled = true
		}
	}, [agentsProp])

	// Persist last-selected agent.
	useEffect(() => {
		if (!selectedAgentId || selectedAgentId === AGENT_SELECT_NONE) return
		void persistenceApi.write(PersistenceKeys.lastSelectedAgent, {
			agentId: selectedAgentId,
		})
	}, [selectedAgentId])

	// Restore last-selected agent on mount.
	useEffect(() => {
		if (agentsProp) return
		let cancelled = false
		void persistenceApi.read<{ agentId: string }>(PersistenceKeys.lastSelectedAgent).then(
			(result) => {
				if (cancelled) return
				if (result.success && result.data?.agentId) {
					const id = result.data.agentId
					// Only restore if the agent still exists in the current list.
					if (agents.some((a) => a.id === id)) {
						setSelectedAgentId(id)
					}
				}
			},
		)
		return () => {
			cancelled = true
		}
	}, [agentsProp]) // intentionally NOT `agents` — only run once on mount

	const activeProjectId = useProjectStore((s) => s.activeProjectId)
	const maxTerminals = useMaxTerminalsPerProject()

	const selectedAgent = useMemo(
		() => agents.find((a) => a.id === selectedAgentId) ?? agents[0],
		[agents, selectedAgentId],
	)

	const launch = useCallback(
		async (agent: TerminalAgentDefinition | undefined) => {
			if (!agent) return
			if (!activeProjectId) {
				toast.error('No active project')
				return
			}
			if (isLaunching) return

			setIsLaunching(true)
			try {
				const project = useProjectStore
					.getState()
					.projects.find((p) => p.id === activeProjectId)
				const cwd = getDefaultCwdForProject(activeProjectId)
				const result = await launchAgentInPane(
					paneId,
					activeProjectId,
					cwd,
					agent,
					prompt,
					{
						envVars: project?.envVars,
						maxTerminalsPerProject: maxTerminals,
					},
				)
				if (!result.success) {
					toast.error(result.error || 'Failed to launch agent')
				} else {
					// Hide the agent launcher overlay — the launched agent terminal tab
					// has been added to the pane alongside any existing tabs.
					useWorkspaceStore.getState().hideAgentLauncher()
				}
			} finally {
				setIsLaunching(false)
			}
		},
		[activeProjectId, isLaunching, maxTerminals, paneId, prompt],
	)

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			// Cmd/Ctrl+Enter launches the selected agent.
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				e.preventDefault()
				void launch(selectedAgent)
			}
			// Escape dismisses the overlay.
			if (e.key === 'Escape') {
				useWorkspaceStore.getState().hideAgentLauncher()
			}
		},
		[launch, selectedAgent],
	)

	const handleSelectChange = useCallback(
		(value: string) => {
			if (value === AGENT_SELECT_NEW) {
				setShowCreateDialog(true)
				// Keep current selection — don't change to __new__
				return
			}
			setSelectedAgentId(value)
		},
		[],
	)

	const handleAgentCreated = useCallback(
		async (def: TerminalAgentDefinition) => {
			try {
				await upsertCustomAgent({
					name: def.name,
					command: def.command,
					baseArgs: def.baseArgs,
					promptMode: def.promptMode,
					promptFlag: def.promptFlag,
					icon: def.icon,
					registryId: def.registryId,
				})
				// Reload agents and select the new one.
				const all = await loadAllAgents()
				setLoadedAgents(all)
				setSelectedAgentId(def.id)
				toast.success(`Added "${def.name}" to your agents`)
			} catch (err) {
				toast.error(err instanceof Error ? err.message : 'Failed to save agent')
			}
		},
		[],
	)

	return (
		<div
			className={cn(
				'absolute inset-0 flex flex-col items-center justify-center gap-5 p-8',
				className,
			)}
		>
			<div className="flex flex-col items-center gap-1.5 text-center">
				<Bot aria-hidden="true" className="text-muted-foreground" size={22} />
				<span className="text-sm font-medium text-foreground">Launch a CLI agent</span>
				<span className="text-xs text-muted-foreground/70">
					Describe what you want, pick an agent, and it opens in this pane.
				</span>
			</div>

			<div className="flex w-full max-w-lg flex-col gap-3">
				<div className="relative">
					{/* Agent selector — positioned top-left of the textarea */}
					<div className="absolute left-2 top-2 z-10">
						<Select
							value={selectedAgentId}
							onValueChange={handleSelectChange}
						>
							<SelectTrigger className="h-7 gap-1 border-0 bg-secondary/60 px-2 text-xs font-medium shadow-none hover:bg-secondary focus:ring-0 focus:ring-offset-0 [&>svg]:opacity-70">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{/* Agent groups — built-ins then custom */}
								{agents.filter((a) => a.isBuiltIn).length > 0 && (
									<>
										{agents
											.filter((a) => a.isBuiltIn)
											.map((agent) => (
												<SelectItem key={agent.id} value={agent.id}>
													<span className="flex items-center gap-2">
														<AgentGlyph agent={agent} />
														{agent.name}
													</span>
												</SelectItem>
											))}
									</>
								)}
								{agents.filter((a) => !a.isBuiltIn).length > 0 && (
									<>
										<SelectSeparator />
										{agents
											.filter((a) => !a.isBuiltIn)
											.map((agent) => (
												<SelectItem key={agent.id} value={agent.id}>
													<span className="flex items-center gap-2">
														<AgentGlyph agent={agent} />
														{agent.name}
													</span>
												</SelectItem>
											))}
									</>
								)}
								<SelectSeparator />
								<SelectItem value={AGENT_SELECT_NEW}>
									<span className="flex items-center gap-2 text-primary">
										<Plus size={12} />
										New custom agent…
									</span>
								</SelectItem>
							</SelectContent>
						</Select>
					</div>

					<Textarea
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="e.g. explain this project and suggest a refactor"
						rows={3}
						aria-label="Agent prompt"
						className="resize-none pb-2 pl-2 pr-10 pt-10 text-sm"
						autoFocus
					/>

					<span className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 text-[10px] text-muted-foreground/60">
						<kbd className="rounded bg-secondary px-1">⌘</kbd>
						<CornerDownLeft size={11} aria-hidden="true" />
					</span>
				</div>

				<Button
					type="button"
					size="sm"
					className="h-9 gap-2"
					disabled={isLaunching || !selectedAgent}
					onClick={() => void launch(selectedAgent)}
				>
					{isLaunching ? (
						<Loader2 size={14} className="animate-spin" aria-hidden="true" />
					) : (
						<Bot size={14} aria-hidden="true" />
					)}
					{isLaunching ? 'Launching…' : `Launch ${selectedAgent?.name ?? 'agent'}`}
				</Button>
			</div>

			<CustomAgentDialog
				open={showCreateDialog}
				onOpenChange={setShowCreateDialog}
				onAgentCreated={handleAgentCreated}
			/>
		</div>
	)
}


/**
 * Small icon for an agent. Renders the bundled SVG inline so `currentColor`
 * inherits from the parent's CSS text color.
 */
const AgentGlyph = memo(function AgentGlyph({
	agent,
}: {
	agent: TerminalAgentDefinition
}): React.JSX.Element {
	const normalized = useMemo(() => {
		if (!agent.icon) return null
		const src = agent.icon
			.replace(/\s+width="[^"]*"/g, '')
			.replace(/\s+height="[^"]*"/g, '')
		if (!/viewBox/i.test(src)) return null
		return src
	}, [agent.icon])

	if (normalized) {
		return (
			<span
				aria-hidden="true"
				className="inline-flex h-3.5 w-3.5 shrink-0 text-foreground/80 [&_svg]:h-full [&_svg]:w-full"
				dangerouslySetInnerHTML={{ __html: normalized }}
			/>
		)
	}
	return (
		<span
			aria-hidden="true"
			className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-foreground/10 text-[8px] font-semibold uppercase"
		>
			{agent.name.charAt(0)}
		</span>
	)
})