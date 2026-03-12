import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { History, Terminal, Clock, Trash2 } from 'lucide-react'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { CommandHistoryEntry } from '@/stores/command-history-store'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConfirmDialog } from '@/components/ConfirmDialog'

type FilterMode = 'this-project' | 'all-projects'

interface CommandHistoryModalProps {
  isOpen: boolean
  onClose: () => void
  entries: CommandHistoryEntry[]
  allEntries: CommandHistoryEntry[]
  onSelectCommand: (command: string) => void
  onClearHistory: () => Promise<void>
}

export function CommandHistoryModal({
  isOpen,
  onClose,
  entries,
  allEntries,
  onSelectCommand,
  onClearHistory
}: CommandHistoryModalProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [filterMode, setFilterMode] = useState<FilterMode>('this-project')
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  // Get entries based on filter mode
  const baseEntries = useMemo(() => {
    return filterMode === 'this-project' ? entries : allEntries
  }, [filterMode, entries, allEntries])

  // Filter entries based on query
  const filteredEntries = useMemo(() => {
    if (!query) return baseEntries
    const lowerQuery = query.toLowerCase()
    return baseEntries.filter((e) => e.command.toLowerCase().includes(lowerQuery))
  }, [baseEntries, query])

  // Reset selection when query or filter changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [query, filterMode])

  // Reset state when modal opens or closes
  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIndex(0)
      setFilterMode('this-project')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
    // Always reset confirmation state on any isOpen change
    setShowClearConfirm(false)
    setIsClearing(false)
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

  const handleClearConfirm = useCallback(async () => {
    if (isClearing) return
    setIsClearing(true)
    try {
      await onClearHistory()
      setShowClearConfirm(false)
    } catch {
      // Keep dialog open on failure - parent already showed toast
    } finally {
      setIsClearing(false)
    }
  }, [onClearHistory, isClearing])

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
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <History size={18} className="text-muted-foreground" />
                <span className="text-sm font-medium">Command History</span>
              </div>
              <Select
                value={filterMode}
                onValueChange={(value) => setFilterMode(value as FilterMode)}
              >
                <SelectTrigger className="w-[140px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="this-project">This Project</SelectItem>
                  <SelectItem value="all-projects">All Projects</SelectItem>
                </SelectContent>
              </Select>
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
                  {baseEntries.length === 0 ? 'No command history yet' : 'No matching commands'}
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
            <div className="bg-background px-4 py-2 border-t border-border flex items-center justify-between text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
              <div className="flex items-center space-x-4">
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
              <button
                onClick={() => setShowClearConfirm(true)}
                className="flex items-center gap-1 px-2 py-1 rounded hover:bg-secondary/50 text-red-400 hover:text-red-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={entries.length === 0 || filterMode !== 'this-project' || isClearing}
                title={filterMode === 'all-projects' ? 'Switch to "This Project" to clear history' : undefined}
              >
                <Trash2 size={12} />
                <span>{isClearing ? 'Clearing...' : 'Clear History'}</span>
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* Clear History Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showClearConfirm}
        title="Clear Command History"
        message="Are you sure you want to clear the command history for this project? This action cannot be undone."
        confirmLabel="Clear"
        cancelLabel="Cancel"
        variant="danger"
        isLoading={isClearing}
        onConfirm={handleClearConfirm}
        onCancel={() => setShowClearConfirm(false)}
      />
    </AnimatePresence>
  )
}