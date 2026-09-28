import { ConnectionStatusIndicator } from '@/components/ConnectionStatusIndicator'
import { ContextBarSettingsPopover } from '@/components/ContextBarSettingsPopover'
import { GitBranchPicker } from '@/components/GitBranchPicker'
import { Bell, Download, FileQuestion, Folder, Pencil, Plus, Server } from '@/components/icons'
import { RemoteAccessPopover } from '@/components/RemoteAccessPopover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatPath, useHomeDirectory } from '@/hooks/use-cwd'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { statusBarColors } from '@/lib/colors'
import { cn } from '@/lib/utils'
import {
  useShowExitCode,
  useShowGitBranch,
  useShowGitStatus,
  useShowWorkingDirectory
} from '@/stores/context-bar-settings-store'
import { useActiveTerminal } from '@/stores/terminal-store'
import { useUpdateDownloaded, useUpdateVersion } from '@/stores/updater-store'
import type { Project } from '@/types/project'

interface StatusBarProps {
  project: Project | undefined
}

export function StatusBar({ project }: StatusBarProps): React.JSX.Element {
  const bgColor = project ? statusBarColors[project.color] : 'bg-status-bar'
  const isMobileWebShell = useMobileWebShell()
  const activeTerminal = useActiveTerminal()
  const homeDir = useHomeDirectory()

  // Context bar visibility settings
  const showGitBranch = useShowGitBranch()
  const showGitStatus = useShowGitStatus()
  const showWorkingDirectory = useShowWorkingDirectory()
  const showExitCode = useShowExitCode()

  // Updater state
  const updateDownloaded = useUpdateDownloaded()
  const updateVersion = useUpdateVersion()

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
      data-status-bar=""
      className={cn(
        'h-6 text-white flex items-center px-1 text-xs font-sans select-none flex-shrink-0 relative z-50',
        bgColor
      )}
    >
      {/* Left side */}
      <div className="flex items-center gap-1 min-w-0">
        {project && !isMobileWebShell && (
          <>
            <StatusItem icon={<Server size={14} />} className="font-medium max-w-40">
              <span className="truncate leading-none">
                {project.name.toLowerCase().replace(/\s+/g, '-')}
              </span>
            </StatusItem>

            {showGitBranch && displayPath && (
              <GitBranchPicker
                repoPath={displayPath}
                currentBranch={gitBranch}
                projectId={project.id}
                ahead={gitStatus?.ahead}
                behind={gitStatus?.behind}
              />
            )}

            {showGitStatus && gitStatus?.hasChanges && (
              <GitStatusIndicator
                modified={gitStatus.modified}
                staged={gitStatus.staged}
                untracked={gitStatus.untracked}
              />
            )}

            {showWorkingDirectory && formattedPath && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex min-w-0 items-center">
                    <StatusItem
                      icon={<Folder size={14} />}
                      className="max-w-64 font-normal text-white/60"
                    >
                      <span className="truncate leading-none">{formattedPath}</span>
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

      <div className="flex-1 min-w-2" />

      {/* Right side */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Story 10 (F1): global web connection health (control + terminal
            channels). Renders null on Tauri desktop. */}
        <ConnectionStatusIndicator />

        <RemoteAccessPopover />

        {showExitCode && lastExitCode !== null && lastExitCode !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex shrink-0 items-center">
                <StatusItem className="tabular-nums">
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full shrink-0',
                      lastExitCode === 0 ? 'bg-green-400' : 'bg-red-400'
                    )}
                  />
                  <span className="leading-none">Exit: {lastExitCode}</span>
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

        {updateDownloaded && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex shrink-0 items-center">
                <StatusItem icon={<Download size={14} />} className="text-green-400" />
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              Update ready to install (version {updateVersion})
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
  const isIconOnly = Boolean(icon) && !children
  return (
    <div
      className={cn(
        'flex h-5 items-center gap-1.5 rounded cursor-pointer transition-colors hover:bg-white/10 min-w-0 shrink-0',
        isIconOnly ? 'w-5 justify-center p-0' : 'px-2',
        className
      )}
    >
      {icon && <span className="flex shrink-0 items-center">{icon}</span>}
      {children}
    </div>
  )
}

interface GitStatusIndicatorProps {
  modified: number
  staged: number
  untracked: number
}

function GitStatusIndicator({
  modified,
  staged,
  untracked
}: GitStatusIndicatorProps): React.JSX.Element | null {
  const items: React.ReactNode[] = []

  if (modified > 0) {
    items.push(
      <Tooltip key="modified">
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1 text-yellow-400">
            <Pencil size={12} className="shrink-0" />
            <span className="min-w-[2ch] tabular-nums leading-none">{modified}</span>
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
          <span className="flex items-center gap-1 text-green-400">
            <Plus size={12} className="shrink-0" />
            <span className="min-w-[2ch] tabular-nums leading-none">{staged}</span>
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
          <span className="flex items-center gap-1 text-muted-foreground">
            <FileQuestion size={12} className="shrink-0" />
            <span className="min-w-[2ch] tabular-nums leading-none">{untracked}</span>
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
    <div className="flex h-5 items-center gap-2 rounded px-2 transition-colors hover:bg-white/10 tabular-nums shrink-0">
      {items}
    </div>
  )
}
