import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Clock,
  Globe,
  History,
  Keyboard,
  Layers,
  Save,
  Settings,
  SlidersHorizontal,
  Terminal
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut
} from '@/components/ui/command'
import type { Project, ProjectColor } from '@/types/project'
import { getColorClasses } from '@/lib/colors'
import { cn } from '@/lib/utils'
import { useRecentCommandIds, useSaveRecentCommand } from '@/hooks/use-recent-commands'

type CommandShortcutId = 'newTerminal' | 'newBrowserTab' | 'commandHistory' | 'startTunnel'

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  projects: Project[]
  onSwitchProject: (id: string) => void
  onAddTerminal?: () => void
  onSaveSnapshot?: () => void
  onNewBrowserTab?: () => void
  onOpenProjectSettings?: () => void
  onOpenAppPreferences?: () => void
  onOpenCommandHistory?: () => void
  onStartTunnel?: () => void
  onOpenShortcutMenu?: () => void
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

const COMMAND_CATEGORY_ORDER: CommandCategory[] = [
  'workspace',
  'navigation',
  'projects',
  'tools'
]

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
  onSaveSnapshot,
  onNewBrowserTab,
  onOpenProjectSettings,
  onOpenAppPreferences,
  onOpenCommandHistory,
  onStartTunnel,
  onOpenShortcutMenu,
  getShortcutLabel,
  getProjectShortcutLabel
}: CommandPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const recentCommandIds = useRecentCommandIds()
  const saveRecentCommand = useSaveRecentCommand()

  const commands: CommandDef[] = useMemo(
    () => [
      ...(onAddTerminal
        ? [
            {
              id: 'new-terminal',
              category: 'workspace' as const,
              icon: <Terminal aria-hidden="true" size={16} />,
              label: 'New Terminal',
              description: 'Open a terminal in the active pane',
              keywords: ['shell', 'console', 'pty', 'workspace'],
              shortcut: getShortcutLabel?.('newTerminal'),
              execute: onAddTerminal
            }
          ]
        : []),
      ...(onNewBrowserTab
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
          <Layers
            aria-hidden="true"
            size={16}
            className={getColorClasses(project.color).text}
          />
        ),
        label: `Switch to Project: ${project.name}`,
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
      ...(onStartTunnel
        ? [
            {
              id: 'start-tunnel',
              category: 'tools' as const,
              icon: <Globe aria-hidden="true" size={16} />,
              label: 'Start Tunnel',
              description: 'Expose the active project using Cloudflare Tunnel',
              keywords: ['tunnel', 'cloudflare', 'share', 'local', 'preview', 'expose'],
              shortcut: getShortcutLabel?.('startTunnel'),
              execute: onStartTunnel
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
        : [])
    ],
    [
      projects,
      onSwitchProject,
      onAddTerminal,
      onSaveSnapshot,
      onNewBrowserTab,
      onOpenProjectSettings,
      onOpenAppPreferences,
      onOpenCommandHistory,
      onStartTunnel,
      onOpenShortcutMenu,
      getShortcutLabel,
      getProjectShortcutLabel
    ]
  )

  const { recentCommands, commandsByCategory } = useMemo(() => {
    const recent: CommandDef[] = []
    const recentIds = new Set(recentCommandIds)

    for (const cmd of commands) {
      if (recentIds.has(cmd.id)) {
        recent.push(cmd)
      }
    }

    recent.sort(
      (a, b) => recentCommandIds.indexOf(a.id) - recentCommandIds.indexOf(b.id)
    )

    const grouped = COMMAND_CATEGORY_ORDER.map((category) => ({
      category,
      commands: commands.filter((cmd) => cmd.category === category)
    })).filter((group) => group.commands.length > 0)

    return { recentCommands: recent, commandsByCategory: grouped }
  }, [commands, recentCommandIds])

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

  const renderCommandItem = (cmd: CommandDef): React.JSX.Element => (
    <CommandItem
      key={cmd.id}
      value={getSearchableValue(cmd)}
      onSelect={() => executeCommand(cmd)}
      className="group flex items-center justify-between gap-3 px-2.5 py-2 cursor-pointer rounded-md"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary/70 text-muted-foreground group-data-[selected=true]:text-foreground',
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
      {cmd.shortcut && (
        <CommandShortcut className="shrink-0 rounded border border-border bg-secondary/70 px-1.5 py-0.5 font-mono text-[10px] tracking-normal text-muted-foreground">
          {cmd.shortcut}
        </CommandShortcut>
      )}
    </CommandItem>
  )

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex flex-col items-center pt-[7vh] px-3 sm:px-0 bg-black/40 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -8 }}
            transition={{ duration: 0.15 }}
            className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <Command
              className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
              shouldFilter={true}
            >
              <CommandInput
                ref={inputRef}
                placeholder="Search commands, projects, settings..."
                value={query}
                onValueChange={setQuery}
                className="h-10 py-2 text-sm"
              />
              <CommandList className="max-h-[52vh] px-1 py-1">
                <CommandEmpty>No commands found.</CommandEmpty>

                {recentCommands.length > 0 && query === '' && (
                  <CommandGroup heading="Recent">
                    {recentCommands.map(renderCommandItem)}
                  </CommandGroup>
                )}

                {commandsByCategory.map(({ category, commands: categoryCommands }) => (
                  <CommandGroup
                    key={category}
                    heading={COMMAND_CATEGORY_LABELS[category]}
                  >
                    {categoryCommands.map(renderCommandItem)}
                  </CommandGroup>
                ))}
              </CommandList>

              <div className="flex items-center justify-between gap-3 border-t border-border bg-background px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Clock aria-hidden="true" size={12} />
                  Recent commands saved
                </span>
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
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
