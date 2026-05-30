import { Server, GitBranch, Folder, Bell, Pencil, Plus, FileQuestion, Download, ArrowUp, ArrowDown } from 'lucide-react'
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
import { useUpdateDownloaded, useUpdateVersion } from '@/stores/updater-store'

interface StatusBarProps {
  project: Project | undefined
}

export function StatusBar({ project }: StatusBarProps): React.JSX.Element {
  const bgColor = project ? statusBarColors[project.color] : 'bg-status-bar'
  const activeTerminal = useActiveTerminal()
  const homeDir = useHomeDirectory()

  const showGitBranch = useShowGitBranch()
  const showGitStatus = useShowGitStatus()
  const showWorkingDirectory = useShowWorkingDirectory()
  const showExitCode = useShowExitCode()

  const updateDownloaded = useUpdateDownloaded()
  const updateVersion = useUpdateVersion()

  const displayPath = activeTerminal?.cwd || project?.path
  const formattedPath = displayPath ? formatPath(displayPath, homeDir) : undefined

  const gitBranch = activeTerminal?.gitBranch ?? project?.gitBranch
  const gitStatus = activeTerminal?.gitStatus
  const lastExitCode = activeTerminal?.lastExitCode

  return (
    <div
      className={cn(
        'h-8 text-white flex items-center px-3 text-xs font-sans select-none flex-shrink-0 relative z-50',
        bgColor
      )}
    >
      <div className="flex items-center gap-2 sm:gap-3">
        {project && (
          <>
            <span className="font-medium opacity-90 truncate max-w-[120px] sm:max-w-none">
              {project.name.toLowerCase().replace(/\s+/g, '-')}
            </span>

            {showGitBranch && gitBranch && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="hidden sm:flex items-center gap-1 opacity-80 hover:opacity-100 cursor-pointer transition-opacity">
                    <GitBranch size={12} />
                    {gitBranch}
                    {gitStatus && (gitStatus.ahead > 0 || gitStatus.behind > 0) && (
                      <span className="flex items-center gap-1 ml-1 border-l border-white/15 pl-1.5">
                        {gitStatus.ahead > 0 && (
                          <span className="flex items-center gap-0.5">
                            <ArrowUp size={10} />
                            {gitStatus.ahead}
                          </span>
                        )}
                        {gitStatus.behind > 0 && (
                          <span className="flex items-center gap-0.5">
                            <ArrowDown size={10} />
                            {gitStatus.behind}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {gitBranch} {gitStatus?.ahead ? `(${gitStatus.ahead} ahead)` : ''} {gitStatus?.behind ? `(${gitStatus.behind} behind)` : ''}
                </TooltipContent>
              </Tooltip>
            )}

            {showGitStatus && gitStatus && gitStatus.hasChanges && (
              <span className="hidden sm:inline">
                <GitStatusIndicator
                  modified={gitStatus.modified}
                  staged={gitStatus.staged}
                  untracked={gitStatus.untracked}
                />
              </span>
            )}

            {showWorkingDirectory && formattedPath && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="hidden md:flex items-center gap-1 opacity-60 hover:opacity-100 cursor-pointer transition-opacity">
                    <Folder size={12} />
                    {formattedPath}
                  </span>
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

      <div className="flex items-center gap-2 sm:gap-3">
        {showExitCode && lastExitCode !== null && lastExitCode !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1.5 opacity-80 hover:opacity-100 cursor-pointer transition-opacity">
                <span
                  className={cn(
                    'w-1.5 h-1.5 rounded-full',
                    lastExitCode === 0 ? 'bg-green-400' : 'bg-red-400'
                  )}
                />
                {lastExitCode}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {lastExitCode === 0
                ? 'Last command succeeded'
                : `Last command failed with exit code ${lastExitCode}`}
            </TooltipContent>
          </Tooltip>
        )}

        {updateDownloaded && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center text-green-300 opacity-80 hover:opacity-100 cursor-pointer transition-opacity">
                <Download size={12} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              Update ready to install (version {updateVersion})
            </TooltipContent>
          </Tooltip>
        )}

        <span className="flex items-center opacity-60 hover:opacity-100 cursor-pointer transition-opacity">
          <Bell size={12} />
        </span>
        <ContextBarSettingsPopover />
      </div>
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
          <span className="flex items-center gap-0.5 text-yellow-300">
            <Pencil size={10} />
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
          <span className="flex items-center gap-0.5 text-green-300">
            <Plus size={10} />
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
          <span className="flex items-center text-muted-foreground">
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
    <span className="flex items-center gap-1.5 opacity-80">
      {items}
    </span>
  )
}
