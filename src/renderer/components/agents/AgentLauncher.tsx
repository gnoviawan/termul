import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, CornerDownLeft, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { memo } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { BUILT_IN_AGENTS, type TerminalAgentDefinition } from '@/lib/agents/agent-registry'
import { loadAllAgents } from '@/lib/agents/custom-agents'
import { launchAgentInPane } from '@/lib/agent-launch'
import { useProjectStore } from '@/stores/project-store'
import { useMaxTerminalsPerProject } from '@/stores/app-settings-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { getDefaultCwdForProject } from '@/lib/worktree-context'

/**
 * ADR-004.5: The "blank tab" agent launch surface.
 *
 * Rendered inside the existing empty-pane state (PaneContent) rather than as a
 * new pane type. Presents a prompt textarea + an agent picker. Submitting
 * launches the selected agent's TUI in this pane via `launchAgentInPane`, which
 * replaces the launcher by adding the agent terminal tab — "the blank page
 * becomes the agent terminal".
 */

interface AgentLauncherProps {
	paneId: string
	/** Override the agent list (mainly for tests). Defaults to built-ins + custom. */
	agents?: readonly TerminalAgentDefinition[]
	className?: string
}

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
			// Cmd/Ctrl+Enter launches the selected agent. Plain Enter inserts a
			// newline so multi-line prompts are easy to compose.
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				e.preventDefault()
				void launch(selectedAgent)
			}
			// Escape dismisses the overlay (only when the overlay is active, i.e.
			// when there are existing tabs underneath).
			if (e.key === 'Escape') {
				useWorkspaceStore.getState().hideAgentLauncher()
			}
		},
		[launch, selectedAgent],
	)

	const handleOverlayKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			if (e.key === 'Escape') {
				useWorkspaceStore.getState().hideAgentLauncher()
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
			onKeyDown={handleOverlayKeyDown}
		>
			<div className="flex flex-col items-center gap-1.5 text-center">
				<Bot aria-hidden="true" className="text-muted-foreground" size={22} />
				<span className="text-sm font-medium text-foreground">Launch a CLI agent</span>
				<span className="text-xs text-muted-foreground/70">
					Describe what you want, pick an agent, and it opens in this pane.
				</span>
			</div>

			<div className="flex w-full max-w-md flex-col gap-3">
				<div className="relative">
					<Textarea
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="e.g. explain this project and suggest a refactor"
						rows={3}
						aria-label="Agent prompt"
						className="resize-none pr-10 text-sm"
						autoFocus
					/>
					<span className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 text-[10px] text-muted-foreground/60">
						<kbd className="rounded bg-secondary px-1">⌘</kbd>
						<CornerDownLeft size={11} aria-hidden="true" />
					</span>
				</div>

				<div
					className="flex flex-wrap items-center justify-center gap-2"
					role="radiogroup"
					aria-label="Select a CLI agent"
				>
					{agents.map((agent) => {
						const isSelected = agent.id === selectedAgent?.id
						return (
							<button
								key={agent.id}
								type="button"
								role="radio"
								aria-checked={isSelected}
								disabled={isLaunching}
								onClick={() => setSelectedAgentId(agent.id)}
								onDoubleClick={() => void launch(agent)}
								className={cn(
									'flex h-8 items-center gap-2 rounded-md border px-3 text-[11px] font-medium transition-colors',
									isSelected
										? 'border-primary/60 bg-primary/10 text-foreground'
										: 'border-border bg-secondary/40 text-muted-foreground hover:bg-secondary',
								)}
							>
								<AgentGlyph agent={agent} />
								{agent.name}
							</button>
						)
					})}
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
		</div>
	)
}

/**
 * Small icon for an agent. Renders the bundled SVG inline so `currentColor`
 * inherits from the parent's CSS text color — giving us a bright icon on dark
 * themes and a dark one on light themes, without any filter hacks.
 */
const AgentGlyph = memo(function AgentGlyph({
	agent,
}: {
	agent: TerminalAgentDefinition
}): React.JSX.Element {
	const normalized = useMemo(() => {
		if (!agent.icon) return null
		// Normalize the SVG source: strip width/height (CSS sizes it), keep
		// viewBox for aspect ratio.
		const src = agent.icon
			.replace(/\s+width="[^"]*"/g, '')
			.replace(/\s+height="[^"]*"/g, '')
			// Replace `fill="currentColor"` with a CSS-visible fill token so the
			// icon stays bright on any background — even when the SVG is isolated
			// from the parent's color cascade (dangerouslySetInnerHTML creates a
			// new tree but currentColor DOES inherit; this is belt-and-suspenders).
			// We use currentColor (which inherits from our span's `color` set via
			// the Tailwind class below), ensuring theme-awareness.
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
