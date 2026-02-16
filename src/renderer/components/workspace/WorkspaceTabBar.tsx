import { useState, useRef, useEffect, useCallback } from 'react'
import { Plus, Terminal as TerminalIcon, ChevronDown } from 'lucide-react'
import { Reorder } from 'framer-motion'
import { cn } from '@/lib/utils'
import { EditorTab } from './EditorTab'
import { Skeleton } from '@/components/ui/skeleton'
import { useWorkspaceTabs, useActiveTabId, useWorkspaceActions } from '@/stores/workspace-store'
import { useEditorStore } from '@/stores/editor-store'
import { useTerminalStore } from '@/stores/terminal-store'
import type { WorkspaceTab } from '@/stores/workspace-store'
import type { ShellInfo, DetectedShells } from '@shared/types/ipc.types'
import type { Terminal } from '@/types/project'
import { editorTabId } from '@/stores/workspace-store'

// Inline TerminalTab matching the style from TerminalTabBar
import { X, Edit2, Skull } from 'lucide-react'
import { ContextMenu } from '@/components/ContextMenu'
import type { ContextMenuItem } from '@/components/ContextMenu'

interface TerminalTabInlineProps {
  terminal: Terminal
  isActive: boolean
  onSelect: () => void
  onClose: () => void
  onRename: (name: string) => void
}

function TerminalTabInline({ terminal, isActive, onSelect, onClose, onRename }: TerminalTabInlineProps): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(terminal.name)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleDoubleClick = useCallback(() => {
    setEditName(terminal.name)
    setIsEditing(true)
  }, [terminal.name])

  const handleSave = useCallback(() => {
    const trimmedName = editName.trim()
    if (trimmedName && trimmedName !== terminal.name) {
      onRename(trimmedName)
    }
    setIsEditing(false)
  }, [editName, terminal.name, onRename])

  const handleCancel = useCallback(() => {
    setEditName(terminal.name)
    setIsEditing(false)
  }, [terminal.name])

  return (
    <>
      <div
        onClick={onSelect}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setContextMenu({ x: e.clientX, y: e.clientY })
        }}
        className={cn(
          'h-full px-4 flex items-center border-r border-border min-w-[150px] cursor-pointer group transition-colors',
          isActive
            ? 'bg-background border-t-2 border-t-primary'
            : 'hover:bg-secondary/50 text-muted-foreground'
        )}
      >
        <TerminalIcon size={14} className={cn('mr-2', isActive ? 'text-primary' : '')} />
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleSave() }
              else if (e.key === 'Escape') { e.preventDefault(); handleCancel() }
            }}
            onBlur={handleSave}
            onClick={(e) => e.stopPropagation()}
            className="text-sm font-medium bg-transparent border-b border-primary outline-none w-full"
          />
        ) : (
          <span
            onDoubleClick={handleDoubleClick}
            className={cn('text-sm font-medium', isActive && 'text-foreground')}
          >
            {terminal.name}
          </span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onClose() }}
          className="ml-auto p-0.5 rounded-md hover:bg-secondary opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <X size={12} />
        </button>
      </div>

      {contextMenu && (
        <ContextMenu
          items={[
            { label: 'Rename', icon: <Edit2 size={14} />, onClick: () => { setEditName(terminal.name); setIsEditing(true) } },
            { label: 'Close', icon: <X size={14} />, onClick: onClose },
            { label: 'Kill Process', icon: <Skull size={14} />, onClick: onClose, variant: 'danger' }
          ]}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  )
}

interface WorkspaceTabBarProps {
  onNewTerminal: () => void
  onNewTerminalWithShell?: (shell: ShellInfo) => void
  onCloseTerminal: (id: string) => void
  onRenameTerminal: (id: string, name: string) => void
  onSelectTerminal: (id: string) => void
  onCloseEditorTab: (filePath: string) => void
  defaultShell?: string
}

interface EditorTabWrapperProps {
  tab: { type: 'editor'; id: string; filePath: string }
  isActive: boolean
  onSelect: () => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseAll: () => void
  onCopyPath: () => void
}

function EditorTabWrapper({ tab, isActive, onSelect, onClose, onCloseOthers, onCloseAll, onCopyPath }: EditorTabWrapperProps): React.JSX.Element {
  const isDirty = useEditorStore((state) => state.openFiles.get(tab.filePath)?.isDirty ?? false)
  return (
    <EditorTab
      filePath={tab.filePath}
      isActive={isActive}
      isDirty={isDirty}
      onSelect={onSelect}
      onClose={onClose}
      onCloseOthers={onCloseOthers}
      onCloseAll={onCloseAll}
      onCopyPath={onCopyPath}
    />
  )
}

export function WorkspaceTabBar({
  onNewTerminal,
  onNewTerminalWithShell,
  onCloseTerminal,
  onRenameTerminal,
  onSelectTerminal,
  onCloseEditorTab,
  defaultShell
}: WorkspaceTabBarProps): React.JSX.Element {
  const tabs = useWorkspaceTabs()
  const activeTabId = useActiveTabId()
  const { setActiveTab, reorderTabs, removeTab } = useWorkspaceActions()
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [shells, setShells] = useState<DetectedShells | null>(null)
  const [loading, setLoading] = useState(true)
  const [hasOverflow, setHasOverflow] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const tabsContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const fetchShells = async (): Promise<void> => {
      try {
        const result = await window.api.shell.getAvailableShells()
        if (result.success) {
          setShells(result.data)
        }
      } catch {
        setShells(null)
      } finally {
        setLoading(false)
      }
    }
    fetchShells()
  }, [])

  useEffect(() => {
    const handleClickOutside = (e: globalThis.MouseEvent): void => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false)
      }
    }
    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isDropdownOpen])

  useEffect(() => {
    const checkOverflow = (): void => {
      if (tabsContainerRef.current) {
        const { scrollWidth, clientWidth } = tabsContainerRef.current
        setHasOverflow(scrollWidth > clientWidth)
      }
    }
    checkOverflow()
    window.addEventListener('resize', checkOverflow)
    return () => window.removeEventListener('resize', checkOverflow)
  }, [tabs.length])

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (tabsContainerRef.current) {
      e.preventDefault()
      tabsContainerRef.current.scrollLeft += e.deltaY
    }
  }, [])

  const handleSelectShell = useCallback(
    (shell: ShellInfo) => {
      if (onNewTerminalWithShell) {
        onNewTerminalWithShell(shell)
      }
      setIsDropdownOpen(false)
    },
    [onNewTerminalWithShell]
  )

  const handleCloseEditorTab = useCallback(
    (filePath: string) => {
      onCloseEditorTab(filePath)
    },
    [onCloseEditorTab]
  )

  const handleCloseOtherEditorTabs = useCallback(
    (filePath: string) => {
      const editorState = useEditorStore.getState()
      const allPaths = Array.from(editorState.openFiles.keys())
      for (const path of allPaths) {
        if (path !== filePath) {
          onCloseEditorTab(path)
        }
      }
    },
    [onCloseEditorTab]
  )

  const handleCloseAllEditorTabs = useCallback(() => {
    const editorState = useEditorStore.getState()
    const allPaths = Array.from(editorState.openFiles.keys())
    for (const path of allPaths) {
      onCloseEditorTab(path)
    }
  }, [onCloseEditorTab])

  const sortedShells = shells?.available?.slice().sort((a, b) => {
    if (defaultShell) {
      if (a.name === defaultShell) return -1
      if (b.name === defaultShell) return 1
    }
    return a.displayName.localeCompare(b.displayName)
  })

  const terminalStoreTerminals = useTerminalStore((state) => state.terminals)

  return (
    <div className="h-10 bg-card border-b border-border flex items-center">
      <div className="relative flex items-center h-full min-w-0 shrink">
        <div
          ref={tabsContainerRef}
          onWheel={handleWheel}
          className="overflow-x-auto scrollbar-hide flex items-center h-full"
        >
          <Reorder.Group
            axis="x"
            values={tabs}
            onReorder={(reordered: WorkspaceTab[]) => reorderTabs(reordered.map((t) => t.id))}
            className="flex items-center h-full"
          >
            {tabs.map((tab) => (
              <Reorder.Item
                key={tab.id}
                value={tab}
                className="list-none h-full"
                whileDrag={{ scale: 1.02, boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}
              >
                {tab.type === 'terminal' ? (
                  (() => {
                    const terminal = terminalStoreTerminals.find((t) => t.id === tab.terminalId)
                    if (!terminal) return null
                    return (
                      <TerminalTabInline
                        terminal={terminal}
                        isActive={tab.id === activeTabId}
                        onSelect={() => {
                          setActiveTab(tab.id)
                          onSelectTerminal(tab.terminalId)
                        }}
                        onClose={() => onCloseTerminal(tab.terminalId)}
                        onRename={(name) => onRenameTerminal(tab.terminalId, name)}
                      />
                    )
                  })()
                ) : (
                  <EditorTabWrapper
                    tab={tab as { type: 'editor'; id: string; filePath: string }}
                    isActive={tab.id === activeTabId}
                    onSelect={() => {
                      setActiveTab(tab.id)
                      useEditorStore.getState().setActiveFilePath(tab.filePath)
                    }}
                    onClose={() => handleCloseEditorTab(tab.filePath)}
                    onCloseOthers={() => handleCloseOtherEditorTabs(tab.filePath)}
                    onCloseAll={handleCloseAllEditorTabs}
                    onCopyPath={() => window.api.clipboard.writeText(tab.filePath)}
                  />
                )}
              </Reorder.Item>
            ))}
          </Reorder.Group>
        </div>

        {hasOverflow && (
          <div className="absolute right-0 top-0 h-full w-8 bg-gradient-to-l from-card to-transparent pointer-events-none" />
        )}
      </div>

      {/* Split Button: New Terminal */}
      <div ref={dropdownRef} className="relative flex items-center ml-1 shrink-0">
        <button
          onClick={onNewTerminal}
          className="h-8 w-8 flex items-center justify-center rounded-l hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors border-r border-border/50"
          title="New terminal (default shell)"
        >
          <Plus size={14} />
        </button>
        {onNewTerminalWithShell && (
          <>
            <button
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              className="h-8 w-6 flex items-center justify-center rounded-r hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
              title="Select shell"
            >
              <ChevronDown size={12} />
            </button>

            {isDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 w-48 bg-popover border border-border rounded-md shadow-lg z-50">
                {loading ? (
                  <div className="py-1 px-3 space-y-2">
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                  </div>
                ) : sortedShells && sortedShells.length > 0 ? (
                  <div className="py-1">
                    {sortedShells.map((shell) => (
                      <button
                        key={shell.name}
                        onClick={() => handleSelectShell(shell)}
                        className={cn(
                          'w-full px-3 py-2 text-left text-sm hover:bg-secondary flex items-center gap-2',
                          shell.name === defaultShell && 'text-primary'
                        )}
                      >
                        <TerminalIcon size={14} />
                        <span>{shell.displayName}</span>
                        {shell.name === defaultShell && (
                          <span className="ml-auto text-xs text-muted-foreground">(default)</span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="px-3 py-2 text-sm text-muted-foreground">No shells detected</div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />
    </div>
  )
}
