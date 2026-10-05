import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentIcon } from '@/components/agents/AgentIcon'
import { Terminal as TerminalIcon, X as XIcon } from '@/components/icons'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { Terminal } from '@/types/project'
import { TAB_CLOSE_BUTTON_CLASS, TabCloseReveal } from '../EditorTab'
import { handleTabAuxClick, TabContextMenu } from '../tab-context-menu'
import type { TabInlineProps } from './types'

// Inline TerminalTab matching the style from TerminalTabBar

interface TerminalTabInlineProps extends TabInlineProps {
  terminal: Terminal
  isClosing?: boolean
  onRename: (name: string) => void
}

export function TerminalTabInline({
  terminal,
  isActive,
  isDragging,
  isDropTarget,
  dropPosition,
  isClosing = false,
  bulkMenu,
  onSelect,
  onClose,
  onRename,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop
}: TerminalTabInlineProps): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(terminal.name)
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

  const handleRenameFromMenu = useCallback(() => {
    setEditName(terminal.name)
    setIsEditing(true)
  }, [terminal.name])

  return (
    <TabContextMenu
      kind="terminal"
      onClose={onClose}
      onRename={handleRenameFromMenu}
      isClosing={isClosing}
      {...bulkMenu}
    >
      <div
        draggable={!isEditing}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onSelect}
        // Middle-click is a no-op while the inline rename input is editing.
        onAuxClick={(e) => handleTabAuxClick(e, onClose, isClosing || isEditing)}
        className={cn(
          'relative h-full px-3 flex items-center border-r border-border min-w-[100px] cursor-pointer group transition-[opacity,transform,background-color] duration-150 ease-out',
          isActive ? 'bg-background' : 'hover:bg-secondary/50 text-muted-foreground',
          isDragging && 'opacity-50 scale-[0.98]'
        )}
      >
        {/* Drop indicator line */}
        {isDropTarget && dropPosition === 'before' && (
          <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary-fill rounded-full" />
        )}
        {isDropTarget && dropPosition === 'after' && (
          <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary-fill rounded-full" />
        )}

        <div className={cn('flex min-w-0 items-center', isEditing && 'flex-1')}>
          {terminal.kind === 'agent' && terminal.agentId ? (
            <AgentIcon
              agentId={terminal.agentId}
              name={terminal.agentName}
              className="h-3 w-3 shrink-0"
            />
          ) : (
            <TerminalIcon size={12} className={cn('shrink-0', isActive ? 'text-primary' : '')} />
          )}
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleSave()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  handleCancel()
                }
              }}
              onBlur={handleSave}
              onClick={(e) => e.stopPropagation()}
              onAuxClick={(e) => e.stopPropagation()}
              className="ml-2 min-w-0 flex-1 bg-transparent text-2xs font-medium border-b border-primary outline-none"
            />
          ) : (
            <span
              onDoubleClick={handleDoubleClick}
              className={cn(
                'ml-2 min-w-0 truncate text-2xs font-medium',
                isActive && 'text-foreground'
              )}
            >
              {terminal.name}
            </span>
          )}
        </div>
        <TabCloseReveal pinned={isActive || isClosing}>
          <button
            type="button"
            tabIndex={isActive || isClosing ? undefined : -1}
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              if (!isClosing) {
                onClose()
              }
            }}
            disabled={isClosing}
            className={cn(TAB_CLOSE_BUTTON_CLASS, isClosing && 'disabled:cursor-wait')}
          >
            {isClosing ? <Spinner size={11} decorative /> : <XIcon size={11} />}
          </button>
        </TabCloseReveal>
      </div>
    </TabContextMenu>
  )
}
