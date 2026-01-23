import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronDown, Terminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import type { ShellInfo, DetectedShells } from '@shared/types/ipc.types'

interface ShellSelectorProps {
  onSelectShell: (shell: ShellInfo) => void
  defaultShell?: string
  className?: string
}

export function ShellSelector({ onSelectShell, defaultShell, className }: ShellSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [shells, setShells] = useState<DetectedShells | null>(null)
  const [loading, setLoading] = useState(true)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const fetchShells = async () => {
      try {
        const result = await window.api.shell.getAvailableShells()
        if (result.success) {
          setShells(result.data)
        }
      } catch {
        // Fallback if IPC fails
        setShells(null)
      } finally {
        setLoading(false)
      }
    }
    fetchShells()
  }, [])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const handleSelectShell = useCallback(
    (shell: ShellInfo) => {
      onSelectShell(shell)
      setIsOpen(false)
    },
    [onSelectShell]
  )

  const sortedShells = shells?.available?.slice().sort((a, b) => {
    if (defaultShell) {
      if (a.name === defaultShell) return -1
      if (b.name === defaultShell) return 1
    }
    return a.displayName.localeCompare(b.displayName)
  })

  return (
    <div ref={dropdownRef} className={cn('relative', className)}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="h-8 px-2 flex items-center justify-center rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors gap-1"
        title="Select shell"
      >
        <Terminal size={14} />
        <ChevronDown size={12} />
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-1 w-48 bg-popover border border-border rounded-md shadow-lg z-50">
          {loading ? (
            <div className="py-1 px-3 space-y-1">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
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
                  <Terminal size={14} />
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
    </div>
  )
}
