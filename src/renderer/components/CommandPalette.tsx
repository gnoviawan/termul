import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Archive,
  GitBranch,
  GitMerge,
  Layers,
  RotateCcw,
  Save,
  Search,
  Terminal,
  Trash2,
  Workflow,
  AlertTriangle
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
import type { Project } from '@/types/project'
import { getColorClasses } from '@/lib/colors'
import { useRecentCommandIds, useSaveRecentCommand } from '@/hooks/use-recent-commands'
import { useWorktrees } from '@/stores/worktree-store'
import { toast } from '@/hooks/use-toast'
import { WorktreeSelectorPalette } from './WorktreeSelectorPalette'


interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  projects: Project[]
  onSwitchProject: (id: string) => void
  onNewTerminal: () => void
  onSaveSnapshot?: () => void
  onOpenWorktreeCreate?: () => void
  onOpenQuickHotfix?: () => void
  onOpenWorktreeArchive?: () => void
  onOpenWorktreeMerge?: () => void
  onOpenWorktreeTerminal?: (worktreeId: string) => void
  onOpenWorktreeDelete?: () => void
  onOpenWorktreeRestore?: () => void
  onOpenWorktreeSearch?: () => void
  onToggleWorktreeGrouping?: () => void
  onShowWorktreeStatus?: () => void
  emergencyModeEnabled?: boolean
}

interface CommandDef {
  id: string
  icon: React.ReactNode
  label: string
  shortcut?: string
  type: 'action' | 'project' | 'worktree'
  projectId?: string
  projectColor?: string
}

interface HighlightSegment {
  text: string
  isMatch: boolean
}

function getHighlightSegments(label: string, query: string): HighlightSegment[] {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    return [{ text: label, isMatch: false }]
  }

  const lowerLabel = label.toLowerCase()
  const tokens = trimmedQuery.toLowerCase().split(/\s+/).filter(Boolean)
  const ranges: Array<{ start: number; end: number }> = []

  for (const token of tokens) {
    let searchIndex = 0
    while (searchIndex < lowerLabel.length) {
      const matchIndex = lowerLabel.indexOf(token, searchIndex)
      if (matchIndex < 0) break
      ranges.push({ start: matchIndex, end: matchIndex + token.length })
      searchIndex = matchIndex + token.length
    }
  }

  if (ranges.length === 0) {
    return [{ text: label, isMatch: false }]
  }

  ranges.sort((a, b) => a.start - b.start)

  const merged: Array<{ start: number; end: number }> = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (!last || range.start > last.end) {
      merged.push({ ...range })
    } else {
      last.end = Math.max(last.end, range.end)
    }
  }

  const segments: HighlightSegment[] = []
  let cursor = 0

  for (const range of merged) {
    if (range.start > cursor) {
      segments.push({ text: label.slice(cursor, range.start), isMatch: false })
    }
    segments.push({ text: label.slice(range.start, range.end), isMatch: true })
    cursor = range.end
  }

  if (cursor < label.length) {
    segments.push({ text: label.slice(cursor), isMatch: false })
  }

  return segments
}


export function CommandPalette({
  isOpen,
  onClose,
  projects,
  onSwitchProject,
  onNewTerminal,
  onSaveSnapshot,
  onOpenWorktreeCreate,
  onOpenQuickHotfix,
  onOpenWorktreeArchive,
  onOpenWorktreeMerge,
  onOpenWorktreeTerminal,
  onOpenWorktreeDelete,
  onOpenWorktreeRestore,
  onOpenWorktreeSearch,
  onToggleWorktreeGrouping,
  onShowWorktreeStatus,
  emergencyModeEnabled = false
}: CommandPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [worktreeSelectorOpen, setWorktreeSelectorOpen] = useState(false)
  const [selectorAction, setSelectorAction] = useState<string | null>(null)
  const [selectorTitle, setSelectorTitle] = useState('Select Worktree')
  const [allowBulkSelection, setAllowBulkSelection] = useState(false)
  const recentCommandIds = useRecentCommandIds()
  const saveRecentCommand = useSaveRecentCommand()
  const worktrees = useWorktrees()

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
        id: 'save-snapshot',
        icon: <Save size={18} />,
        label: 'Save Workspace Snapshot',
        type: 'action'
      },
      {
        id: 'quick-hotfix' as const,
        icon: <AlertTriangle size={18} className={emergencyModeEnabled ? 'text-destructive' : ''} />,
        label: emergencyModeEnabled ? 'Quick Hotfix (Emergency Mode)' : 'Quick Hotfix',
        shortcut: 'Ctrl+Shift+H',
        type: 'worktree' as const
      },
      {
        id: 'worktree-create',
        icon: <GitBranch size={18} />,
        label: 'Create worktree',
        shortcut: 'Ctrl+Shift+W',
        type: 'worktree'
      },
      {
        id: 'worktree-archive',
        icon: <Archive size={18} />,
        label: 'Archive worktree',
        type: 'worktree'
      },
      {
        id: 'worktree-merge',
        icon: <GitMerge size={18} />,
        label: 'Merge worktree',
        type: 'worktree'
      },
      {
        id: 'worktree-terminal',
        icon: <Terminal size={18} />,
        label: 'Open worktree terminal',
        type: 'worktree'
      },
      {
        id: 'worktree-delete',
        icon: <Trash2 size={18} />,
        label: 'Delete worktree',
        type: 'worktree'
      },
      {
        id: 'worktree-restore',
        icon: <RotateCcw size={18} />,
        label: 'Restore archived worktree',
        type: 'worktree'
      },
      {
        id: 'worktree-search',
        icon: <Search size={18} />,
        label: 'Search worktrees',
        type: 'worktree'
      },
      {
        id: 'worktree-toggle-grouping',
        icon: <Workflow size={18} />,
        label: 'Toggle worktree grouping',
        type: 'worktree'
      },
      {
        id: 'worktree-status',
        icon: <GitBranch size={18} />,
        label: 'Show worktree status',
        type: 'worktree'
      }
    ],
    [projects, emergencyModeEnabled]
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

  const commandItems = useMemo(() => {
    return query === '' ? otherCommands : commands
  }, [commands, otherCommands, query])


  useEffect(() => {
    if (isOpen) {
      setQuery('')
    }
  }, [isOpen])

  const handleWorktreeSelect = useCallback(
    (worktreeId: string | string[]) => {
      try {
        const isBulk = Array.isArray(worktreeId)
        const ids = isBulk ? worktreeId : [worktreeId]
        const count = ids.length

        switch (selectorAction) {
          case 'worktree-archive':
            if (onOpenWorktreeArchive) {
              onOpenWorktreeArchive()
              toast({
                title: 'Archive initiated',
                description: isBulk
                  ? `Archiving ${count} worktrees`
                  : `Archiving worktree ${worktreeId}`
              })
            }
            break
          case 'worktree-delete':
            if (onOpenWorktreeDelete) {
              onOpenWorktreeDelete()
              toast({
                title: 'Delete initiated',
                description: isBulk
                  ? `Deleting ${count} worktrees`
                  : `Deleting worktree ${worktreeId}`
              })
            }
            break
          case 'worktree-merge':
            if (onOpenWorktreeMerge) {
              onOpenWorktreeMerge()
              toast({
                title: 'Merge initiated',
                description: isBulk
                  ? `Merging ${count} worktrees`
                  : `Merging worktree ${worktreeId}`
              })
            }
            break
          case 'worktree-terminal':
            if (onOpenWorktreeTerminal) {
              if (isBulk) {
                // Open terminal for each worktree
                ids.forEach((id) => onOpenWorktreeTerminal(id))
                toast({
                  title: 'Terminals opened',
                  description: `Opened ${count} terminals`
                })
              } else {
                onOpenWorktreeTerminal(worktreeId as string)
                toast({
                  title: 'Terminal opened',
                  description: `Opened terminal for worktree ${worktreeId}`
                })
              }
            }
            break
          case 'worktree-restore':
            if (onOpenWorktreeRestore) {
              onOpenWorktreeRestore()
              toast({
                title: 'Restore initiated',
                description: isBulk
                  ? `Restoring ${count} worktrees`
                  : `Restoring worktree ${worktreeId}`
              })
            }
            break
          case 'worktree-status':
            if (onShowWorktreeStatus) {
              onShowWorktreeStatus()
              toast({
                title: 'Status displayed',
                description: isBulk
                  ? `Showing status for ${count} worktrees`
                  : `Showing status for worktree ${worktreeId}`
              })
            }
            break
          default:
            toast({
              title: 'Unknown action',
              description: `Action ${selectorAction} is not implemented`,
              variant: 'destructive'
            })
        }
        setWorktreeSelectorOpen(false)
        setSelectorAction(null)
      } catch (error) {
        console.error('[CommandPalette] Error handling worktree selection:', error)
        toast({
          title: 'Selection failed',
          description: error instanceof Error ? error.message : 'An unexpected error occurred',
          variant: 'destructive'
        })
      }
    },
    [
      selectorAction,
      onOpenWorktreeArchive,
      onOpenWorktreeDelete,
      onOpenWorktreeMerge,
      onOpenWorktreeTerminal,
      onOpenWorktreeRestore,
      onShowWorktreeStatus
    ]
  )

  const executeCommand = useCallback(
    async (cmd: CommandDef) => {
      try {
        await saveRecentCommand(cmd.id)

        // Project switching
        if (cmd.type === 'project' && cmd.projectId) {
          onSwitchProject(cmd.projectId)
          toast({
            title: 'Project switched',
            description: `Switched to ${cmd.label.replace('Switch to Project: ', '')}`
          })
        }
        // General actions
        else if (cmd.id === 'new-terminal') {
          onNewTerminal()
          toast({
            title: 'Terminal created',
            description: 'New terminal opened successfully'
          })
        } else if (cmd.id === 'save-snapshot' && onSaveSnapshot) {
          onSaveSnapshot()
          toast({
            title: 'Snapshot saved',
            description: 'Workspace snapshot saved successfully'
          })
        }
        // Worktree actions
        else if (cmd.type === 'worktree') {
          switch (cmd.id) {
            case 'quick-hotfix':
              if (onOpenQuickHotfix) {
                onOpenQuickHotfix()
              } else {
                toast({
                  title: 'Action not available',
                  description: 'Quick hotfix creation is not configured',
                  variant: 'destructive'
                })
              }
              break
            case 'worktree-create':
              if (onOpenWorktreeCreate) {
                onOpenWorktreeCreate()
              } else {
                toast({
                  title: 'Action not available',
                  description: 'Worktree creation is not configured',
                  variant: 'destructive'
                })
              }
              break
            case 'worktree-archive':
              if (onOpenWorktreeArchive) {
                if (worktrees.length > 0) {
                  setSelectorTitle('Archive Worktree(s)')
                  setSelectorAction('worktree-archive')
                  setAllowBulkSelection(true)
                  setWorktreeSelectorOpen(true)
                } else {
                  toast({
                    title: 'No worktrees',
                    description: 'Create a worktree first',
                    variant: 'destructive'
                  })
                }
              } else {
                toast({
                  title: 'Action not available',
                  description: 'Worktree archiving is not configured',
                  variant: 'destructive'
                })
              }
              break
            case 'worktree-merge':
              if (onOpenWorktreeMerge) {
                if (worktrees.length > 0) {
                  setSelectorTitle('Merge Worktree')
                  setSelectorAction('worktree-merge')
                  setAllowBulkSelection(false)
                  setWorktreeSelectorOpen(true)
                } else {
                  toast({
                    title: 'No worktrees',
                    description: 'Create a worktree first',
                    variant: 'destructive'
                  })
                }
              } else {
                toast({
                  title: 'Action not available',
                  description: 'Worktree merging is not configured',
                  variant: 'destructive'
                })
              }
              break
            case 'worktree-terminal':
              if (onOpenWorktreeTerminal && worktrees.length > 0) {
                setSelectorTitle('Open Terminal for Worktree')
                setSelectorAction('worktree-terminal')
                setAllowBulkSelection(false)
                setWorktreeSelectorOpen(true)
              } else if (worktrees.length === 0) {
                toast({
                  title: 'No worktrees',
                  description: 'Create a worktree first',
                  variant: 'destructive'
                })
              }
              break
            case 'worktree-delete':
              if (onOpenWorktreeDelete) {
                if (worktrees.length > 0) {
                  setSelectorTitle('Delete Worktree(s)')
                  setSelectorAction('worktree-delete')
                  setAllowBulkSelection(true)
                  setWorktreeSelectorOpen(true)
                } else {
                  toast({
                    title: 'No worktrees',
                    description: 'Create a worktree first',
                    variant: 'destructive'
                  })
                }
              } else {
                toast({
                  title: 'Action not available',
                  description: 'Worktree deletion is not configured',
                  variant: 'destructive'
                })
              }
              break
            case 'worktree-restore':
              if (onOpenWorktreeRestore) {
                if (worktrees.length > 0) {
                  setSelectorTitle('Restore Worktree')
                  setSelectorAction('worktree-restore')
                  setAllowBulkSelection(false)
                  setWorktreeSelectorOpen(true)
                } else {
                  toast({
                    title: 'No worktrees',
                    description: 'No archived worktrees to restore',
                    variant: 'destructive'
                  })
                }
              } else {
                toast({
                  title: 'Action not available',
                  description: 'Worktree restoration is not configured',
                  variant: 'destructive'
                })
              }
              break
            case 'worktree-search':
              if (onOpenWorktreeSearch) {
                onOpenWorktreeSearch()
              } else {
                toast({
                  title: 'Search worktrees',
                  description: 'Use the sidebar search to find worktrees'
                })
              }
              break
            case 'worktree-toggle-grouping':
              if (onToggleWorktreeGrouping) {
                onToggleWorktreeGrouping()
                toast({
                  title: 'Grouping toggled',
                  description: 'Worktree grouping mode changed'
                })
              } else {
                toast({
                  title: 'Action not available',
                  description: 'Worktree grouping is not configured',
                  variant: 'destructive'
                })
              }
              break
            case 'worktree-status':
              if (onShowWorktreeStatus) {
                if (worktrees.length > 0) {
                  setSelectorTitle('Show Worktree Status')
                  setSelectorAction('worktree-status')
                  setAllowBulkSelection(false)
                  setWorktreeSelectorOpen(true)
                } else {
                  toast({
                    title: 'No worktrees',
                    description: 'Create a worktree first',
                    variant: 'destructive'
                  })
                }
              } else {
                toast({
                  title: 'Action not available',
                  description: 'Worktree status display is not configured',
                  variant: 'destructive'
                })
              }
              break
            default:
              toast({
                title: 'Unknown command',
                description: `Command ${cmd.id} is not implemented`,
                variant: 'destructive'
              })
          }
        }

        // Don't close palette if we're opening the worktree selector
        if (!worktreeSelectorOpen) {
          onClose()
        }
      } catch (error) {
        console.error('[CommandPalette] Error executing command:', error)
        toast({
          title: 'Command failed',
          description: error instanceof Error ? error.message : 'An unexpected error occurred',
          variant: 'destructive'
        })
      }
    },
    [
      saveRecentCommand,
      onSwitchProject,
      onNewTerminal,
      onSaveSnapshot,
      onOpenWorktreeCreate,
      onOpenQuickHotfix,
      onOpenWorktreeArchive,
      onOpenWorktreeMerge,
      onOpenWorktreeTerminal,
      onOpenWorktreeDelete,
      onOpenWorktreeRestore,
      onOpenWorktreeSearch,
      onToggleWorktreeGrouping,
      onShowWorktreeStatus,
      worktrees.length,
      worktreeSelectorOpen,
      onClose
    ]
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
    <>
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
                    {commandItems.map((cmd) => (
                      <CommandItem
                        key={cmd.id}
                        value={cmd.label}
                        onSelect={() => executeCommand(cmd)}
                        className="flex items-center justify-between px-4 py-3 cursor-pointer"
                      >
                        <div className="flex items-center gap-3">
                          {cmd.icon}
                          <span className="text-sm font-medium">
                            {getHighlightSegments(cmd.label, query).map((segment, index) => (
                              <span
                                key={`${cmd.id}-segment-${index}`}
                                className={segment.isMatch ? 'text-primary' : undefined}
                              >
                                {segment.text}
                              </span>
                            ))}
                          </span>
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

      {/* Worktree Selector Palette */}
      <WorktreeSelectorPalette
        isOpen={worktreeSelectorOpen}
        onClose={() => {
          setWorktreeSelectorOpen(false)
          setSelectorAction(null)
          setAllowBulkSelection(false)
        }}
        onSelect={handleWorktreeSelect}
        title={selectorTitle}
        allowMultiple={allowBulkSelection}
      />
    </>
  )
}
