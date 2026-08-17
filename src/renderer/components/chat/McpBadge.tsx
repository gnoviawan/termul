import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface McpBadgeProps {
  /** Number of MCP servers attached to this session (badge summary count). */
  count: number
  className?: string
}

function McpIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
    >
      <title>MCP</title>
      <path
        fill="currentColor"
        d="M9.795 1.694a4.287 4.287 0 0 1 6.061 0a4.28 4.28 0 0 1 1.181 3.819a4.28 4.28 0 0 1 3.819 1.181a4.287 4.287 0 0 1 0 6.061l-6.793 6.793a.25.25 0 0 0 0 .353l2.617 2.618a.75.75 0 1 1-1.061 1.061l-2.617-2.618a1.75 1.75 0 0 1 0-2.475l6.793-6.793a2.785 2.785 0 1 0-3.939-3.939l-5.9 5.9a.7.7 0 0 1-.249.165a.749.749 0 0 1-.812-1.225l5.9-5.901a2.785 2.785 0 1 0-3.939-3.939L2.931 10.68A.75.75 0 1 1 1.87 9.619z"
      />
      <path
        fill="currentColor"
        d="M12.42 4.069a.75.75 0 0 1 1.061 0a.75.75 0 0 1 0 1.061L7.33 11.28a2.79 2.79 0 0 0 0 3.94a2.79 2.79 0 0 0 3.94 0l6.15-6.151a.75.75 0 0 1 1.061 0a.75.75 0 0 1 0 1.061l-6.151 6.15a4.285 4.285 0 1 1-6.06-6.06z"
      />
    </svg>
  )
}

/**
 * MCP indicator in the composer toolbar. Simple icon button with a tooltip
 * showing the count of attached MCP servers. Management is done in Settings
 * → MCP Servers.
 */
export function McpBadge({ count, className }: McpBadgeProps): React.JSX.Element | null {
  if (count <= 0) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`MCP servers — ${count} attached`}
          className={cn(
            'relative flex size-8 items-center justify-center text-muted-foreground transition-colors',
            "after:absolute after:-inset-1.5 after:content-['']",
            'hover:text-foreground',
            className
          )}
        >
          <McpIcon className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {count} MCP server{count === 1 ? '' : 's'} attached
      </TooltipContent>
    </Tooltip>
  )
}
