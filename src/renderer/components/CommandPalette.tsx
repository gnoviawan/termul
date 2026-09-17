import { AnimatePresence, motion } from 'framer-motion'
import {
  Bot,
  FolderPlus,
  Globe,
  History,
  Keyboard,
  Layers,
  Monitor,
  Palette,
  Pin,
  Save,
  Settings,
  SlidersHorizontal,
  Terminal,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut
} from '@/components/ui/command'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { usePinnedCommandIds, useTogglePinnedCommand } from '@/hooks/use-pinned-commands'
import { useRecentCommandIds, useSaveRecentCommand } from '@/hooks/use-recent-commands'
import { getColorClasses } from '@/lib/colors'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import type { Project, ProjectColor } from '@/types/project'

type CommandShortcutId = 'newTerminal' | 'newBrowserTab' | 'commandHistory' | 'colorThemePicker'

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  projects: Project[]
  onSwitchProject: (id: string) => void
  onAddTerminal?: () => void
  onShowAgentLauncher?: () => void
  onLaunchAgent?: () => void
  onSaveSnapshot?: () => void
  onNewBrowserTab?: () => void
  /** Story 7: opens the New Project modal (mobile creation entry + desktop). */
  onNewProject?: () => void
  onOpenProjectSettings?: () => void
  onOpenAppPreferences?: () => void
  onOpenCommandHistory?: () => void
  onOpenShortcutMenu?: () => void
  onOpenThemePicker?: () => void
  onSSHConnect?: (profileId: string) => void
  sshProfiles?: Array<{ id: string; name: string; host: string; username: string }>
  getShortcutLabel?: (id: CommandShortcutId) => string | undefined
  getProjectShortcutLabel?: (index: number) => string | undefined
}

type CommandCategory = 'workspace' | 'navigation' | 'projects' | 'tools'

const COMMAND_CATEGORY_LABELS: Record<CommandCategory, string> = {
  workspace: 'Workspace',
  navigation: 'Navigation',
  projects: 'Projects',
  tools: 'Tools'
}

const COMMAND_CATEGORY_ORDER: CommandCategory[] = ['projects', 'workspace', 'navigation', 'tools']

interface CommandDef {
  id: string
  category: CommandCategory
  icon: React.ReactNode
  label: string
  description?: string
  keywords?: string[]
  shortcut?: string
  execute: () => void
  projectColor?: ProjectColor
}

function getSearchableValue(cmd: CommandDef): string {
  return [
    cmd.label,
    cmd.description,
    cmd.category,
    COMMAND_CATEGORY_LABELS[cmd.category],
    ...(cmd.keywords ?? [])
  ]
    .filter(Boolean)
    .join(' ')
}

export function CommandPalette({
  isOpen,
  onClose,
  projects,
  onSwitchProject,
  onAddTerminal,
  onShowAgentLauncher,
  onLaunchAgent,
  onSaveSnapshot,
  onNewBrowserTab,
  onNewProject,
  onOpenProjectSettings,
  onOpenAppPreferences,
  onOpenCommandHistory,
  onOpenShortcutMenu,
  onOpenThemePicker,
  onSSHConnect,
  sshProfiles,
  getShortcutLabel,
  getProjectShortcutLabel
}: CommandPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const recentCommandIds = useRecentCommandIds()
  const saveRecentCommand = useSaveRecentCommand()
  const pinnedCommandIds = usePinnedCommandIds()
  const togglePinnedCommand = useTogglePinnedCommand()
  // Story 11 (QA F9): on the mobile web shell the palette is top-anchored at
  // pt-[7vh] (thumb-unreachable), shows dead ↑↓/↵/Esc desktop key hints, and
  // offers no visible close. Mobile repositions to the lower third, hides the
  // kbd hints, and renders a touch-sized close button. Desktop unchanged.
  const isMobile = useMobileWebShell()
  const commands: CommandDef[] = useMemo(
    () => [
      ...(onAddTerminal
        ? [
            {
              id: 'new-terminal',
              category: 'workspace' as const,
              icon: <Terminal aria-hidden="true" size={16} />,
              label: 'New Terminal',
              description: 'Open a new shell in the active pane',
              keywords: ['shell', 'console', 'pty', 'workspace'],
              execute: onAddTerminal
            }
          ]
        : []),
      ...(onNewProject
        ? [
            {
              id: 'new-project',
              category: 'workspace' as const,
              icon: <FolderPlus aria-hidden="true" size={16} />,
              label: 'New Project',
              description: 'Create a new project workspace',
              keywords: ['project', 'create', 'new', 'workspace', 'folder'],
              execute: onNewProject
            }
          ]
        : []),
      ...(onShowAgentLauncher
        ? [
            {
              id: 'show-agent-launcher',
              category: 'workspace' as const,
              icon: <Bot aria-hidden="true" size={16} />,
              label: 'Agent Launcher',
              description: 'Show the agent launcher prompt in the active pane',
              keywords: ['agent', 'ai', 'claude', 'codex', 'prompt', 'launcher'],
              shortcut: getShortcutLabel?.('newTerminal'),
              execute: onShowAgentLauncher
            }
          ]
        : []),
      ...(onLaunchAgent
        ? [
            {
              id: 'launch-agent',
              category: 'workspace' as const,
              icon: <Bot aria-hidden="true" size={16} />,
              label: 'Launch Agent',
              description: "Open a CLI agent's TUI in the active pane",
              keywords: ['agent', 'ai', 'claude', 'codex', 'gemini', 'cursor', 'opencode', 'cli'],
              execute: onLaunchAgent
            }
          ]
        : []),
      ...(onNewBrowserTab && isTauriContext()
        ? [
            {
              id: 'new-browser-tab',
              category: 'workspace' as const,
              icon: <Globe aria-hidden="true" size={16} />,
              label: 'New Browser Tab',
              description: 'Open a browser tab in the active pane',
              keywords: ['web', 'url', 'workspace'],
              shortcut: getShortcutLabel?.('newBrowserTab'),
              execute: onNewBrowserTab
            }
          ]
        : []),
      ...(onSaveSnapshot
        ? [
            {
              id: 'save-snapshot',
              category: 'workspace' as const,
              icon: <Save aria-hidden="true" size={16} />,
              label: 'Save Workspace Snapshot',
              description: 'Capture the current workspace layout',
              keywords: ['snapshot', 'checkpoint', 'layout', 'save'],
              execute: onSaveSnapshot
            }
          ]
        : []),
      ...(onOpenProjectSettings
        ? [
            {
              id: 'open-project-settings',
              category: 'navigation' as const,
              icon: <Settings aria-hidden="true" size={16} />,
              label: 'Project Settings',
              description: 'Configure the active project workspace',
              keywords: ['settings', 'project', 'configure', 'config'],
              execute: onOpenProjectSettings
            }
          ]
        : []),
      ...(onOpenAppPreferences
        ? [
            {
              id: 'open-app-preferences',
              category: 'navigation' as const,
              icon: <SlidersHorizontal aria-hidden="true" size={16} />,
              label: 'App Preferences',
              description: 'Open global application preferences',
              keywords: ['preferences', 'prefs', 'settings', 'app', 'global'],
              execute: onOpenAppPreferences
            }
          ]
        : []),
      ...projects.map((project, index) => ({
        id: `project-${project.id}`,
        category: 'projects' as const,
        icon: (
          <Layers aria-hidden="true" size={16} className={getColorClasses(project.color).text} />
        ),
        label: project.name,
        description: project.path ?? 'Switch active workspace project',
        keywords: ['project', 'switch', project.name, project.path].filter(
          (keyword): keyword is string => Boolean(keyword)
        ),
        shortcut: index < 9 ? getProjectShortcutLabel?.(index) : undefined,
        execute: () => onSwitchProject(project.id),
        projectColor: project.color
      })),
      ...(onOpenCommandHistory
        ? [
            {
              id: 'open-command-history',
              category: 'tools' as const,
              icon: <History aria-hidden="true" size={16} />,
              label: 'Command History',
              description: 'Review and reuse recent terminal commands',
              keywords: ['history', 'recent', 'terminal', 'commands', 'shell'],
              shortcut: getShortcutLabel?.('commandHistory'),
              execute: onOpenCommandHistory
            }
          ]
        : []),
      ...(onOpenThemePicker
        ? [
            {
              id: 'change-color-theme',
              category: 'tools' as const,
              icon: <Palette aria-hidden="true" size={16} />,
              label: 'Change Color Theme',
              description: 'Preview and apply a UI color theme',
              keywords: ['theme', 'color', 'appearance', 'palette', 'dark', 'dracula', 'nord'],
              shortcut: getShortcutLabel?.('colorThemePicker'),
              execute: onOpenThemePicker
            }
          ]
        : []),
      ...(onOpenShortcutMenu
        ? [
            {
              id: 'open-shortcut-menu',
              category: 'tools' as const,
              icon: <Keyboard aria-hidden="true" size={16} />,
              label: 'Open Shortcut Menu',
              description: 'View and edit common keyboard shortcuts',
              keywords: ['keyboard', 'shortcuts', 'hotkeys', 'keys'],
              execute: onOpenShortcutMenu
            }
          ]
        : []),
      ...(isTauriContext() && onSSHConnect && sshProfiles
        ? sshProfiles.map((profile) => ({
            id: `ssh-${profile.id}`,
            category: 'tools' as const,
            icon: <Monitor aria-hidden="true" size={16} />,
            label: `SSH: ${profile.name}`,
            description: `${profile.username}@${profile.host}`,
            keywords: ['ssh', 'remote', 'connect', profile.name, profile.host, profile.username],
            execute: () => onSSHConnect(profile.id)
          }))
        : [])
    ],
    [
      projects,
      onSwitchProject,
      onAddTerminal,
      onShowAgentLauncher,
      onLaunchAgent,
      onSaveSnapshot,
      onNewBrowserTab,
      onNewProject,
      onOpenProjectSettings,
      onOpenAppPreferences,
      onOpenCommandHistory,
      onOpenShortcutMenu,
      onOpenThemePicker,
      onSSHConnect,
      sshProfiles,
      getShortcutLabel,
      getProjectShortcutLabel
    ]
  )

  const { pinnedCommands, recentCommands, commandsByCategory } = useMemo(() => {
    const commandById = new Map(commands.map((cmd) => [cmd.id, cmd]))

    const pinned: CommandDef[] = []
    for (const id of pinnedCommandIds) {
      const cmd = commandById.get(id)
      if (cmd) {
        pinned.push(cmd)
      }
    }

    const recent: CommandDef[] = []
    const recentIds = new Set(recentCommandIds)

    for (const cmd of commands) {
      if (recentIds.has(cmd.id)) {
        recent.push(cmd)
      }
    }

    recent.sort((a, b) => recentCommandIds.indexOf(a.id) - recentCommandIds.indexOf(b.id))

    const grouped = COMMAND_CATEGORY_ORDER.map((category) => ({
      category,
      commands: commands.filter((cmd) => cmd.category === category)
    })).filter((group) => group.commands.length > 0)

    return {
      pinnedCommands: pinned,
      recentCommands: recent,
      commandsByCategory: grouped
    }
  }, [commands, pinnedCommandIds, recentCommandIds])

  const pinnedIdSet = useMemo(() => new Set(pinnedCommandIds), [pinnedCommandIds])

  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setQuery('')
      // Explicitly blur active element first so terminal doesn't hold focus,
      // then focus the command palette input after the overlay renders.
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [isOpen])

  const executeCommand = useCallback(
    async (cmd: CommandDef) => {
      try {
        await saveRecentCommand(cmd.id)
      } catch (error) {
        console.warn('Failed to save recent command', error)
      }

      onClose()
      cmd.execute()
    },
    [saveRecentCommand, onClose]
  )

  const togglePin = useCallback(
    async (commandId: string) => {
      try {
        await togglePinnedCommand(commandId)
      } catch (error) {
        console.warn('Failed to toggle pinned command', error)
      }
    },
    [togglePinnedCommand]
  )

  // Handle Escape key - use capture phase to intercept before cmdk handles it
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [isOpen, onClose])

  const renderCommandItem = (cmd: CommandDef, keyPrefix?: string): React.JSX.Element => {
    const isPinned = pinnedIdSet.has(cmd.id)
    return (
      <CommandItem
        key={keyPrefix ? `${keyPrefix}:${cmd.id}` : cmd.id}
        value={keyPrefix ? `${keyPrefix}:${getSearchableValue(cmd)}` : getSearchableValue(cmd)}
        onSelect={() => executeCommand(cmd)}
        className="group flex items-center justify-between gap-3 px-2.5 py-1.5 cursor-pointer rounded-md data-[selected='true']:bg-background data-[selected=true]:text-foreground"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-secondary/70 text-muted-foreground group-data-[selected=true]:text-foreground',
              cmd.projectColor && getColorClasses(cmd.projectColor).bg
            )}
          >
            {cmd.icon}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium leading-5">{cmd.label}</span>
            {cmd.description && (
              <span className="truncate text-xs leading-4 text-muted-foreground">
                {cmd.description}
              </span>
            )}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {cmd.shortcut && (
            <CommandShortcut className="rounded border border-border bg-secondary/70 px-1.5 py-0.5 font-mono text-3xs tracking-normal text-muted-foreground">
              {cmd.shortcut}
            </CommandShortcut>
          )}
          <button
            type="button"
            aria-label={isPinned ? `Unpin ${cmd.label}` : `Pin ${cmd.label}`}
            aria-pressed={isPinned}
            title={isPinned ? 'Unpin' : 'Pin'}
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              void togglePin(cmd.id)
            }}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-secondary hover:text-foreground group-data-[selected=true]:text-foreground',
              isPinned
                ? 'text-foreground opacity-100'
                : 'opacity-0 group-data-[selected=true]:opacity-100 group-hover:opacity-100'
            )}
          >
            <Pin aria-hidden="true" size={13} className={cn(isPinned && 'fill-current')} />
          </button>
        </div>
      </CommandItem>
    )
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className={cn(
            'fixed inset-0 z-[60] flex flex-col items-center bg-black/40 backdrop-blur-sm',
            // Story 11 (QA F9): mobile anchor is the lower third (thumb
            // zone) instead of the desktop pt-[7vh] top anchor, with the
            // bottom safe-area inset honored.
            isMobile ? 'justify-end pb-[max(2rem,env(safe-area-inset-bottom))] px-3' : 'pt-[7vh]'
          )}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: isMobile ? 8 : -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: isMobile ? 8 : -8 }}
            transition={{ duration: 0.15 }}
            className="w-full max-w-[100vw] overflow-hidden rounded-lg border border-border bg-card shadow-2xl md:max-w-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <Command
              className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-3xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
              shouldFilter={true}
            >
              <div className="relative">
                <CommandInput
                  ref={inputRef}
                  placeholder="Search commands, projects, settings..."
                  value={query}
                  onValueChange={setQuery}
                  className={cn('h-10 py-2 text-sm', isMobile && 'h-11')}
                />
                {/* Story 11 (QA F5): visible touch-sized close — Escape is
                    dead on phones and the backdrop tap target is not
                    obvious while the OSK is up. 44px floor + hit-slop idiom. */}
                {isMobile && (
                  <button
                    type="button"
                    className="absolute right-1 top-1/2 z-10 flex size-11 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                    aria-label="Close command palette"
                    title="Close command palette"
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose()
                    }}
                  >
                    <X aria-hidden="true" size={20} />
                  </button>
                )}
              </div>
              <CommandList className="max-h-[52vh] px-1 py-1">
                <CommandEmpty>No commands found.</CommandEmpty>

                {pinnedCommands.length > 0 && query === '' && (
                  <CommandGroup heading="Pinned">
                    {pinnedCommands.map((cmd) => renderCommandItem(cmd, 'pinned'))}
                  </CommandGroup>
                )}

                {recentCommands.length > 0 && query === '' && (
                  <CommandGroup heading="Recent">
                    {recentCommands.map((cmd) => renderCommandItem(cmd, 'recent'))}
                  </CommandGroup>
                )}

                {commandsByCategory.map(({ category, commands: categoryCommands }) => (
                  <CommandGroup key={category} heading={COMMAND_CATEGORY_LABELS[category]}>
                    {categoryCommands.map((cmd) => renderCommandItem(cmd))}
                  </CommandGroup>
                ))}
              </CommandList>

              {/* Story 11 (QA F9): ↑↓/↵/Esc kbd hints are dead affordances
                  on touch (no hardware keyboard) — hide them on the mobile
                  shell. Desktop keeps them byte-identical. */}
              {!isMobile && (
                <div className="label-group flex items-center justify-end gap-3 border-t border-border bg-background px-3 py-2 text-muted-foreground">
                  <span className="flex items-center gap-3">
                    <span className="flex items-center">
                      <kbd className="mr-1 rounded bg-secondary px-1 text-foreground">↑↓</kbd>
                      Navigate
                    </span>
                    <span className="flex items-center">
                      <kbd className="mr-1 rounded bg-secondary px-1 text-foreground">↵</kbd>
                      Select
                    </span>
                    <span className="flex items-center">
                      <kbd className="mr-1 rounded bg-secondary px-1 text-foreground">Esc</kbd>
                      Close
                    </span>
                  </span>
                </div>
              )}
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
