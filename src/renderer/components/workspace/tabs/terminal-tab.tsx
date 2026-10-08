import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentIcon } from '@/components/agents/AgentIcon'
import { Terminal as TerminalIcon } from '@/components/icons'
import type { Terminal } from '@/types/project'
import { TabContextMenu } from '../tab-context-menu'
import { TabChrome } from './tab-chrome'
import type { TabInlineProps } from './types'

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
  onSelect,
  onClose,
  onRename,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  bulkMenu
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
      <TabChrome
        isActive={isActive}
        isDragging={isDragging}
        isDropTarget={isDropTarget}
        dropPosition={dropPosition}
        onSelect={onSelect}
        onClose={onClose}
        closeDisabled={isClosing}
        pinClose={isActive}
        dragDisabled={isEditing}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        icon={
          terminal.kind === 'agent' && terminal.agentId ? (
            <AgentIcon agentId={terminal.agentId} name={terminal.agentName} className="h-3 w-3" />
          ) : (
            <TerminalIcon size={12} />
          )
        }
        label={terminal.name}
        onLabelDoubleClick={handleDoubleClick}
        labelOverride={
          isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                // Keep rename key events out of the tab's Enter/Space
                // activation handler — Space must type, Enter must not
                // re-select the tab.
                e.stopPropagation()
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
              aria-label="Terminal name"
              className="min-w-0 flex-1 border-b border-primary bg-transparent text-xs font-medium leading-none outline-none"
            />
          ) : undefined
        }
      />
    </TabContextMenu>
  )
}
