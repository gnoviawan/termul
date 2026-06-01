import { memo, useMemo } from 'react'
import { getBuiltInAgent } from '@/lib/agents/agent-registry'

/**
 * Renders an agent's bundled SVG icon inline so `currentColor` inherits from
 * the parent's CSS text color — giving us theme-aware icons without any filter
 * hacks.
 *
 * Falls back to a letter-initial placeholder when the agent has no icon or the
 * agent ID can't be resolved.
 */

function normalizeSvg(svg: string): string | null {
	const src = svg
		.replace(/\s+width="[^"]*"/g, '')
		.replace(/\s+height="[^"]*"/g, '')
	if (!/viewBox/i.test(src)) return null
	return src
}

export interface AgentIconProps {
	agentId: string
	/** Tailwind sizing class. Default: h-3.5 w-3.5 (tab-bar size). */
	className?: string
}

export const AgentIcon = memo(function AgentIcon({
	agentId,
	className = 'h-3.5 w-3.5',
}: AgentIconProps): React.JSX.Element {
	const icon = useMemo(() => {
		const agent = getBuiltInAgent(agentId)
		if (!agent) return null

		if (agent.icon) {
			const normalized = normalizeSvg(agent.icon)
			if (normalized) return normalized
		}

		return null
	}, [agentId])

	if (icon) {
		return (
			<span
				aria-hidden="true"
				className={`inline-flex shrink-0 text-foreground/80 [&_svg]:h-full [&_svg]:w-full ${className}`}
				dangerouslySetInnerHTML={{ __html: icon }}
			/>
		)
	}

	// Fallback: first letter of the agent name
	const agent = getBuiltInAgent(agentId)
	return (
		<span
			aria-hidden="true"
			className={`flex shrink-0 items-center justify-center rounded-sm bg-foreground/10 text-[8px] font-semibold uppercase ${className}`}
		>
			{agent?.name?.charAt(0) ?? '?'}
		</span>
	)
})
