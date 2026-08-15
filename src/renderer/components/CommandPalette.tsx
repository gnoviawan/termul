import { AnimatePresence, motion } from 'framer-motion'
import {
  Bot,
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
  Terminal
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut
} from '@/components/ui/command'
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

function getSearchableValue(cmd: CommandDef, categoryLabel: string): string {
  return [cmd.label, cmd.description, cmd.category, categoryLabel, ...(cmd.keywords ?? [])]
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
  const { t } = useTranslation('shell')
  const [query, setQuery] = useState('')
  const recentCommandIds = useRecentCommandIds()
  const saveRecentCommand = useSaveRecentCommand()
  const pinnedCommandIds = usePinnedCommandIds()
  const togglePinnedCommand = useTogglePinnedCommand()

  const commands: CommandDef[] = useMemo(
    () => [
      ...(onAddTerminal
        ? [
            {
              id: 'new-terminal',
              category: 'workspace' as const,
              icon: <Terminal aria-hidden="true" size={16} />,
              label: t('commandPalette.newTerminal'),
              description: t('commandPalette.newTerminalDescription'),
              keywords: ['shell', 'console', 'pty', 'workspace'],
              execute: onAddTerminal
            }
          ]
        : []),
      ...(onShowAgentLauncher
        ? [
            {
              id: 'show-agent-launcher',
              category: 'workspace' as const,
              icon: <Bot aria-hidden="true" size={16} />,
              label: t('commandPalette.agentLauncher'),
              description: t('commandPalette.agentLauncherDescription'),
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
              label: t('commandPalette.launchAgent'),
              description: t('commandPalette.launchAgentDescription'),
              keywords: ['agent', 'ai', 'claude', 'codex', 'gemini', 'cursor', 'opencode', 'cli'],
              execute: onLaunchAgent
            }
          ]
        : []),
      ...(onNewBrowserTab
        ? [
            {
              id: 'new-browser-tab',
              category: 'workspace' as const,
              icon: <Globe aria-hidden="true" size={16} />,
              label: t('commandPalette.newBrowserTab'),
              description: t('commandPalette.newBrowserTabDescription'),
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
              label: t('commandPalette.saveSnapshot'),
              description: t('commandPalette.saveSnapshotDescription'),
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
              label: t('commandPalette.projectSettings'),
              description: t('commandPalette.projectSettingsDescription'),
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
              label: t('commandPalette.appPreferences'),
              description: t('commandPalette.appPreferencesDescription'),
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
        description: project.path ?? t('commandPalette.switchProject'),
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
              label: t('commandPalette.commandHistory'),
              description: t('commandPalette.commandHistoryDescription'),
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
              label: t('commandPalette.colorTheme'),
              description: t('commandPalette.colorThemeDescription'),
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
              label: t('commandPalette.shortcutMenu'),
              description: t('commandPalette.shortcutMenuDescription'),
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
            label: t('commandPalette.sshLabel', { name: profile.name }),
            description: t('commandPalette.sshDescription', {
              username: profile.username,
              host: profile.host
            }),
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
      onOpenProjectSettings,
      onOpenAppPreferences,
      onOpenCommandHistory,
      onOpenShortcutMenu,
      onOpenThemePicker,
      onSSHConnect,
      sshProfiles,
      getShortcutLabel,
      getProjectShortcutLabel,
      t
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
        value={
          keyPrefix
            ? `${keyPrefix}:${getSearchableValue(
                cmd,
                t(`commandPalette.categories.${cmd.category}`)
              )}`
            : getSearchableValue(cmd, t(`commandPalette.categories.${cmd.category}`))
        }
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
            aria-label={t('commandPalette.pinCommand', {
              action: isPinned ? t('commandPalette.unpin') : t('commandPalette.pin'),
              label: cmd.label
            })}
            aria-pressed={isPinned}
            title={isPinned ? t('commandPalette.unpin') : t('commandPalette.pin')}
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
          className="fixed inset-0 z-[60] flex flex-col items-center pt-[7vh] bg-black/40 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -8 }}
            transition={{ duration: 0.15 }}
            className="w-full max-w-[100vw] overflow-hidden rounded-lg border border-border bg-card shadow-2xl md:max-w-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <Command
              className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-3xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
              shouldFilter={true}
            >
              <CommandInput
                ref={inputRef}
                placeholder={t('commandPalette.searchPlaceholder')}
                value={query}
                onValueChange={setQuery}
                className="h-10 py-2 text-sm"
              />
              <CommandList className="max-h-[52vh] px-1 py-1">
                <CommandEmpty>{t('commandPalette.empty')}</CommandEmpty>

                {pinnedCommands.length > 0 && query === '' && (
                  <CommandGroup heading={t('commandPalette.pinned')}>
                    {pinnedCommands.map((cmd) => renderCommandItem(cmd, 'pinned'))}
                  </CommandGroup>
                )}

                {recentCommands.length > 0 && query === '' && (
                  <CommandGroup heading={t('commandPalette.recent')}>
                    {recentCommands.map((cmd) => renderCommandItem(cmd, 'recent'))}
                  </CommandGroup>
                )}

                {commandsByCategory.map(({ category, commands: categoryCommands }) => (
                  <CommandGroup key={category} heading={t(`commandPalette.categories.${category}`)}>
                    {categoryCommands.map((cmd) => renderCommandItem(cmd))}
                  </CommandGroup>
                ))}
              </CommandList>

              <div className="label-group flex items-center justify-end gap-3 border-t border-border bg-background px-3 py-2 text-muted-foreground">
                <span className="flex items-center gap-3">
                  <span className="flex items-center">
                    <kbd className="mr-1 rounded bg-secondary px-1 text-foreground">↑↓</kbd>
                    {t('commandPalette.navigate')}
                  </span>
                  <span className="flex items-center">
                    <kbd className="mr-1 rounded bg-secondary px-1 text-foreground">↵</kbd>
                    {t('commandPalette.select')}
                  </span>
                  <span className="flex items-center">
                    <kbd className="mr-1 rounded bg-secondary px-1 text-foreground">Esc</kbd>
                    {t('commandPalette.close')}
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
