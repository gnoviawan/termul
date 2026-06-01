import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUp, Bot, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { memo } from 'react'
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
 * Chat-style input bar: agent selector on the left, prompt textarea fills
 * the middle, launch button on the right — all inside a single container.
 * "New custom agent" in the dropdown opens a creation dialog.
 * Selected agent persists across sessions.
 */

interface AgentLauncherProps {
	paneId: string
	/** Override the agent list (mainly for tests). Defaults to built-ins + custom. */
	agents?: readonly TerminalAgentDefinition[]
	className?: string
}

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
		if (!selectedAgentId) return
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
					useWorkspaceStore.getState().hideAgentLauncher()
				}
			} finally {
				setIsLaunching(false)
			}
		},
		[activeProjectId, isLaunching, maxTerminals, paneId, prompt],
	)

	const handleSubmit = useCallback(() => {
		void launch(selectedAgent)
	}, [launch, selectedAgent])

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			// Cmd/Ctrl+Enter launches the selected agent.
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				e.preventDefault()
				void launch(selectedAgent)
			}
			// Enter without modifier submits; Shift+Enter for newline.
			if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
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

	const canLaunch = selectedAgent && !isLaunching

	return (
		<div
			className={cn(
				'absolute inset-0 flex flex-col items-center justify-end p-4 pb-8',
				className,
			)}
		>
			<div className="flex w-full max-w-xl flex-col gap-2">
				{/* Chat-style input bar */}
				<div className="flex items-end gap-0 rounded-xl border border-border bg-card shadow-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1">
					{/* Agent selector — left side */}
					<div className="flex shrink-0 items-end border-r border-border/50">
						<Select
							value={selectedAgentId}
							onValueChange={handleSelectChange}
						>
							<SelectTrigger className="h-auto min-h-[44px] gap-1.5 border-0 bg-transparent px-3 py-2 shadow-none hover:bg-secondary/50 focus:ring-0 focus:ring-offset-0 [&>svg]:opacity-60">
								<span className="flex items-center gap-1.5">
									<AgentGlyph agent={selectedAgent} />
									<span className="max-w-[100px] truncate text-xs font-medium">
										{selectedAgent?.name ?? 'Agent'}
									</span>
								</span>
							</SelectTrigger>
							<SelectContent>
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

					{/* Textarea — fills remaining width */}
					<textarea
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Describe what you want…"
						rows={1}
						aria-label="Agent prompt"
						autoFocus
						className="flex-1 resize-none bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground/60"
						style={{ minHeight: '44px', maxHeight: '120px' }}
						onInput={(e) => {
							const el = e.currentTarget
							el.style.height = 'auto'
							el.style.height = `${Math.min(el.scrollHeight, 120)}px`
						}}
					/>

					{/* Launch button — right side */}
					<button
						type="button"
						onClick={handleSubmit}
						disabled={!canLaunch}
						className={cn(
							'flex shrink-0 items-center justify-center rounded-e-xl px-3 py-2 transition-colors',
							canLaunch
								? 'bg-primary text-primary-foreground hover:bg-primary/90'
								: 'bg-muted text-muted-foreground',
						)}
						aria-label={`Launch ${selectedAgent?.name ?? 'agent'}`}
						title={isLaunching ? 'Launching…' : `Launch ${selectedAgent?.name ?? 'agent'}`}
					>
						{isLaunching ? (
							<Loader2 size={18} className="animate-spin" />
						) : (
							<ArrowUp size={18} />
						)}
					</button>
				</div>

				{/* Hint */}
				<span className="text-center text-[11px] text-muted-foreground/50">
					Enter to launch · Shift+Enter for newline · Esc to dismiss
				</span>
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
				className="inline-flex h-4 w-4 shrink-0 text-foreground/80 [&_svg]:h-full [&_svg]:w-full"
				dangerouslySetInnerHTML={{ __html: normalized }}
			/>
		)
	}
	return (
		<span
			aria-hidden="true"
			className="flex h-4 w-4 items-center justify-center rounded-sm bg-foreground/10 text-[9px] font-semibold uppercase"
		>
			{agent.name.charAt(0)}
		</span>
	)
})