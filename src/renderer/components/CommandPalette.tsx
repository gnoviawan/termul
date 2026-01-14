import { useState, useEffect, useCallback, useMemo } from 'react'
import { Terminal, Layers, SplitSquareVertical, Save } from 'lucide-react'
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
import type { Project } from '@/types/project'
import { getColorClasses } from '@/lib/colors'
import { useRecentCommandIds, useSaveRecentCommand } from '@/hooks/use-recent-commands'

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  projects: Project[]
  onSwitchProject: (id: string) => void
  onNewTerminal: () => void
  onSaveSnapshot?: () => void
}

interface CommandDef {
  id: string
  icon: React.ReactNode
  label: string
  shortcut?: string
  type: 'action' | 'project'
  projectId?: string
  projectColor?: string
}

export function CommandPalette({
  isOpen,
  onClose,
  projects,
  onSwitchProject,
  onNewTerminal,
  onSaveSnapshot
}: CommandPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const recentCommandIds = useRecentCommandIds()
  const saveRecentCommand = useSaveRecentCommand()

  const commands: CommandDef[] = useMemo(
    () => [
      ...projects.map((p, i) => ({
        id: `project-${p.id}`,
        icon: <Layers size={18} className={getColorClasses(p.color).text} />,
        label: `Switch to Project: ${p.name}`,
        shortcut: `Ctrl+${i + 1}`,
        type: 'project' as const,
        projectId: p.id,
        projectColor: p.color
      })),
      {
        id: 'new-terminal',
        icon: <Terminal size={18} />,
        label: 'New Terminal',
        shortcut: 'Ctrl+T',
        type: 'action'
      },
      {
        id: 'split-v',
        icon: <SplitSquareVertical size={18} />,
        label: 'Split Terminal Vertically',
        shortcut: 'Ctrl+Shift+D',
        type: 'action'
      },
      {
        id: 'save-snapshot',
        icon: <Save size={18} />,
        label: 'Save Workspace Snapshot',
        type: 'action'
      }
    ],
    [projects]
  )

  // Separate recent commands from others
  const { recentCommands, otherCommands } = useMemo(() => {
    const recent: CommandDef[] = []
    const others: CommandDef[] = []

    for (const cmd of commands) {
      if (recentCommandIds.includes(cmd.id)) {
        recent.push(cmd)
      } else {
        others.push(cmd)
      }
    }

    // Sort recent by their order in recentCommandIds
    recent.sort(
      (a, b) => recentCommandIds.indexOf(a.id) - recentCommandIds.indexOf(b.id)
    )

    return { recentCommands: recent, otherCommands: others }
  }, [commands, recentCommandIds])

  useEffect(() => {
    if (isOpen) {
      setQuery('')
    }
  }, [isOpen])

  const executeCommand = useCallback(
    async (cmd: CommandDef) => {
      await saveRecentCommand(cmd.id)

      if (cmd.type === 'project' && cmd.projectId) {
        onSwitchProject(cmd.projectId)
      } else if (cmd.id === 'new-terminal') {
        onNewTerminal()
      } else if (cmd.id === 'save-snapshot' && onSaveSnapshot) {
        onSaveSnapshot()
      }

      onClose()
    },
    [saveRecentCommand, onSwitchProject, onNewTerminal, onSaveSnapshot, onClose]
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

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex flex-col items-center pt-[10vh] bg-black/40 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            transition={{ duration: 0.15 }}
            className="w-full max-w-2xl bg-card rounded-xl shadow-2xl border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <Command
              className="[&_[cmdk-group-heading]]:text-muted-foreground"
              shouldFilter={true}
            >
              <CommandInput
                placeholder="Type a command or search..."
                value={query}
                onValueChange={setQuery}
                className="text-lg"
              />
              <CommandList className="max-h-[60vh]">
                <CommandEmpty>No commands found.</CommandEmpty>

                {/* Recent Commands - only show when no query */}
                {recentCommands.length > 0 && query === '' && (
                  <CommandGroup heading="Recent">
                    {recentCommands.map((cmd) => (
                      <CommandItem
                        key={cmd.id}
                        value={cmd.label}
                        onSelect={() => executeCommand(cmd)}
                        className="flex items-center justify-between px-4 py-3 cursor-pointer"
                      >
                        <div className="flex items-center gap-3">
                          {cmd.icon}
                          <span className="text-sm font-medium">{cmd.label}</span>
                        </div>
                        {cmd.shortcut && (
                          <CommandShortcut className="text-xs font-mono bg-secondary px-2 py-1 rounded border border-border">
                            {cmd.shortcut}
                          </CommandShortcut>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}

                {/* All Commands */}
                <CommandGroup heading={query === '' && recentCommands.length > 0 ? 'All Commands' : undefined}>
                  {(query === '' ? otherCommands : commands).map((cmd) => (
                    <CommandItem
                      key={cmd.id}
                      value={cmd.label}
                      onSelect={() => executeCommand(cmd)}
                      className="flex items-center justify-between px-4 py-3 cursor-pointer"
                    >
                      <div className="flex items-center gap-3">
                        {cmd.icon}
                        <span className="text-sm font-medium">{cmd.label}</span>
                      </div>
                      {cmd.shortcut && (
                        <CommandShortcut className="text-xs font-mono bg-secondary px-2 py-1 rounded border border-border">
                          {cmd.shortcut}
                        </CommandShortcut>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>

              {/* Footer */}
              <div className="bg-background px-4 py-2 border-t border-border flex items-center justify-end space-x-4 text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
                <span className="flex items-center">
                  <kbd className="bg-secondary text-foreground px-1 rounded mr-1">↑↓</kbd> to navigate
                </span>
                <span className="flex items-center">
                  <kbd className="bg-secondary text-foreground px-1 rounded mr-1">↵</kbd> to select
                </span>
                <span className="flex items-center">
                  <kbd className="bg-secondary text-foreground px-1 rounded mr-1">Esc</kbd> to close
                </span>
              </div>
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
