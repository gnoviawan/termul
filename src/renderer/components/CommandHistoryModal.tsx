import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { History, Terminal, Clock } from 'lucide-react'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { CommandHistoryEntry } from '@/stores/command-history-store'

interface CommandHistoryModalProps {
  isOpen: boolean
  onClose: () => void
  entries: CommandHistoryEntry[]
  onSelectCommand: (command: string) => void
}

export function CommandHistoryModal({
  isOpen,
  onClose,
  entries,
  onSelectCommand
}: CommandHistoryModalProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  // Filter entries based on query
  const filteredEntries = useMemo(() => {
    if (!query) return entries
    const lowerQuery = query.toLowerCase()
    return entries.filter((e) => e.command.toLowerCase().includes(lowerQuery))
  }, [entries, query])

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen])

  // Scroll selected item into view using Virtuoso
  useEffect(() => {
    if (virtuosoRef.current && filteredEntries.length > 0) {
      virtuosoRef.current.scrollToIndex(selectedIndex)
    }
  }, [selectedIndex, filteredEntries.length])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, filteredEntries.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (filteredEntries[selectedIndex]) {
          onSelectCommand(filteredEntries[selectedIndex].command)
          onClose()
        }
      }
    },
    [filteredEntries, selectedIndex, onSelectCommand, onClose]
  )

  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  }

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
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
              <History size={18} className="text-muted-foreground" />
              <span className="text-sm font-medium">Command History</span>
            </div>

            {/* Search Input */}
            <div className="p-2 border-b border-border">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search commands..."
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            {/* Command List */}
            {filteredEntries.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                <History size={32} className="mx-auto mb-2 opacity-50" />
                <p className="text-sm">
                  {entries.length === 0 ? 'No command history yet' : 'No matching commands'}
                </p>
              </div>
            ) : (
              <div className="max-h-[50vh]">
                <Virtuoso
                  ref={virtuosoRef}
                  style={{ height: '50vh' }}
                  data={filteredEntries}
                  itemContent={(index, entry) => (
                    <div
                      key={entry.id}
                      onClick={() => {
                        onSelectCommand(entry.command)
                        onClose()
                      }}
                      className={`px-4 py-3 cursor-pointer transition-colors ${
                        index === selectedIndex ? 'bg-secondary' : 'hover:bg-secondary/50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <code className="flex-1 text-sm font-mono text-foreground break-all">
                          {entry.command}
                        </code>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Terminal size={12} />
                          {entry.terminalName}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock size={12} />
                          {formatTime(entry.timestamp)}
                        </span>
                      </div>
                    </div>
                  )}
                />
              </div>
            )}

            {/* Footer */}
            <div className="bg-background px-4 py-2 border-t border-border flex items-center justify-end space-x-4 text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
              <span className="flex items-center">
                <kbd className="bg-secondary text-foreground px-1 rounded mr-1">↑↓</kbd> to navigate
              </span>
              <span className="flex items-center">
                <kbd className="bg-secondary text-foreground px-1 rounded mr-1">↵</kbd> to insert
              </span>
              <span className="flex items-center">
                <kbd className="bg-secondary text-foreground px-1 rounded mr-1">Esc</kbd> to close
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
