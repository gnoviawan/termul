import { Server, GitBranch, Folder, Bell, Pencil, Plus, FileQuestion } from 'lucide-react'
import type { Project } from '@/types/project'
import { statusBarColors } from '@/lib/colors'
import { cn } from '@/lib/utils'
import { useActiveTerminal } from '@/stores/terminal-store'
import { formatPath, useHomeDirectory } from '@/hooks/use-cwd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ContextBarSettingsPopover } from '@/components/ContextBarSettingsPopover'
import {
  useShowGitBranch,
  useShowGitStatus,
  useShowWorkingDirectory,
  useShowExitCode
} from '@/stores/context-bar-settings-store'

interface StatusBarProps {
  project: Project | undefined
}

export function StatusBar({ project }: StatusBarProps): React.JSX.Element {
  const bgColor = project ? statusBarColors[project.color] : 'bg-status-bar'
  const activeTerminal = useActiveTerminal()
  const homeDir = useHomeDirectory()

  // Context bar visibility settings
  const showGitBranch = useShowGitBranch()
  const showGitStatus = useShowGitStatus()
  const showWorkingDirectory = useShowWorkingDirectory()
  const showExitCode = useShowExitCode()

  // Display terminal CWD if available, otherwise fall back to project path
  const displayPath = activeTerminal?.cwd || project?.path
  const formattedPath = displayPath ? formatPath(displayPath, homeDir) : undefined

  // Display terminal git branch if available, otherwise fall back to project gitBranch
  const gitBranch = activeTerminal?.gitBranch ?? project?.gitBranch

  // Git status from active terminal
  const gitStatus = activeTerminal?.gitStatus

  // Last command exit code from active terminal
  const lastExitCode = activeTerminal?.lastExitCode

  return (
    <div
      className={cn(
        'h-8 text-white flex items-center px-3 text-xs font-sans select-none flex-shrink-0',
        bgColor
      )}
    >
      {/* Left side */}
      <div className="flex items-center space-x-4">
        {project && (
          <>
            <StatusItem icon={<Server size={14} />}>
              {project.name.toLowerCase().replace(/\s+/g, '-')}
            </StatusItem>

            {showGitBranch && gitBranch && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <StatusItem icon={<GitBranch size={14} />}>{gitBranch}</StatusItem>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {gitBranch}
                </TooltipContent>
              </Tooltip>
            )}

            {showGitStatus && gitStatus && gitStatus.hasChanges && (
              <GitStatusIndicator
                modified={gitStatus.modified}
                staged={gitStatus.staged}
                untracked={gitStatus.untracked}
              />
            )}

            {showWorkingDirectory && formattedPath && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <StatusItem icon={<Folder size={14} />} className="opacity-80">
                      {formattedPath}
                    </StatusItem>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-md break-all">
                  {displayPath}
                </TooltipContent>
              </Tooltip>
            )}
          </>
        )}
      </div>

      <div className="flex-1" />

      {/* Right side */}
      <div className="flex items-center space-x-4">
        {showExitCode && lastExitCode !== null && lastExitCode !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <StatusItem>
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full mr-2',
                      lastExitCode === 0 ? 'bg-green-400' : 'bg-red-400'
                    )}
                  />
                  Exit: {lastExitCode}
                </StatusItem>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              {lastExitCode === 0
                ? 'Last command succeeded'
                : `Last command failed with exit code ${lastExitCode}`}
            </TooltipContent>
          </Tooltip>
        )}

        <StatusItem icon={<Bell size={14} />} />
        <ContextBarSettingsPopover />
      </div>
    </div>
  )
}

interface StatusItemProps {
  icon?: React.ReactNode
  children?: React.ReactNode
  className?: string
}

function StatusItem({ icon, children, className }: StatusItemProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center hover:bg-white/10 px-2 py-0.5 rounded cursor-pointer transition-colors',
        className
      )}
    >
      {icon && <span className="mr-1.5">{icon}</span>}
      {children}
    </div>
  )
}

interface GitStatusIndicatorProps {
  modified: number
  staged: number
  untracked: number
}

function GitStatusIndicator({ modified, staged, untracked }: GitStatusIndicatorProps): React.JSX.Element | null {
  const items: React.ReactNode[] = []

  if (modified > 0) {
    items.push(
      <Tooltip key="modified">
        <TooltipTrigger asChild>
          <span className="flex items-center text-yellow-400">
            <Pencil size={12} className="mr-0.5" />
            {modified}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          {modified} modified {modified === 1 ? 'file' : 'files'}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (staged > 0) {
    items.push(
      <Tooltip key="staged">
        <TooltipTrigger asChild>
          <span className="flex items-center text-green-400">
            <Plus size={12} className="mr-0.5" />
            {staged}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          {staged} staged {staged === 1 ? 'file' : 'files'}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (untracked > 0) {
    items.push(
      <Tooltip key="untracked">
        <TooltipTrigger asChild>
          <span className="flex items-center text-gray-400">
            <FileQuestion size={12} className="mr-0.5" />
            {untracked}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          {untracked} untracked {untracked === 1 ? 'file' : 'files'}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (items.length === 0) return null

  return (
    <div className="flex items-center space-x-2 px-2 py-0.5 rounded hover:bg-white/10 transition-colors">
      {items}
    </div>
  )
}
