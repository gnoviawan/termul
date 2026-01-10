import { useState, useRef, useEffect, useCallback } from 'react'
import { X, ChevronUp, ChevronDown } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

interface TerminalSearchBarProps {
  isOpen: boolean
  onClose: () => void
  onFindNext: (term: string) => boolean
  onFindPrevious: (term: string) => boolean
  onClearDecorations: () => void
}

export function TerminalSearchBar({
  isOpen,
  onClose,
  onFindNext,
  onFindPrevious,
  onClearDecorations
}: TerminalSearchBarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [matchInfo, setMatchInfo] = useState<string>('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isOpen])

  // Clear decorations when closed or query cleared
  useEffect(() => {
    if (!isOpen || query === '') {
      onClearDecorations()
      setMatchInfo('')
    }
  }, [isOpen, query, onClearDecorations])

  const handleFindNext = useCallback(() => {
    if (!query) return
    const found = onFindNext(query)
    setMatchInfo(found ? 'Match found' : 'No matches')
  }, [query, onFindNext])

  const handleFindPrevious = useCallback(() => {
    if (!query) return
    const found = onFindPrevious(query)
    setMatchInfo(found ? 'Match found' : 'No matches')
  }, [query, onFindPrevious])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (e.shiftKey) {
          handleFindPrevious()
        } else {
          handleFindNext()
        }
      }
    },
    [onClose, handleFindNext, handleFindPrevious]
  )

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newQuery = e.target.value
      setQuery(newQuery)
      // Auto-search as you type
      if (newQuery) {
        const found = onFindNext(newQuery)
        setMatchInfo(found ? 'Match found' : 'No matches')
      } else {
        setMatchInfo('')
      }
    },
    [onFindNext]
  )

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.15 }}
          className="absolute top-2 right-2 z-10 flex items-center gap-1 bg-card border border-border rounded-md shadow-lg p-1"
        >
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Search..."
            className="w-48 px-2 py-1 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
          />

          {matchInfo && (
            <span className="text-xs text-muted-foreground px-1 min-w-[70px]">
              {matchInfo}
            </span>
          )}

          <button
            onClick={handleFindPrevious}
            disabled={!query}
            className="p-1 hover:bg-secondary rounded disabled:opacity-50 disabled:cursor-not-allowed"
            title="Previous match (Shift+Enter)"
          >
            <ChevronUp size={16} />
          </button>

          <button
            onClick={handleFindNext}
            disabled={!query}
            className="p-1 hover:bg-secondary rounded disabled:opacity-50 disabled:cursor-not-allowed"
            title="Next match (Enter)"
          >
            <ChevronDown size={16} />
          </button>

          <button
            onClick={onClose}
            className="p-1 hover:bg-secondary rounded"
            title="Close (Escape)"
          >
            <X size={16} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
