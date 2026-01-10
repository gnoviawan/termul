import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronRight, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ContextMenuSubItem {
  label: string
  value: string
  icon?: React.ReactNode
  isSelected?: boolean
}

export interface ContextMenuItem {
  label: string
  icon?: React.ReactNode
  onClick?: () => void
  variant?: 'default' | 'danger'
  disabled?: boolean
  submenu?: ContextMenuSubItem[]
  onSubmenuSelect?: (value: string) => void
}

interface ContextMenuProps {
  items: ContextMenuItem[]
  x: number
  y: number
  onClose: () => void
}

export function ContextMenu({ items, x, y, onClose }: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  // Adjust position if menu would overflow viewport
  const adjustedPosition = useCallback((): { left: number; top: number } => {
    const menuWidth = 180
    const menuHeight = items.length * 36 + 8
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    let left = x
    let top = y

    if (x + menuWidth > viewportWidth) {
      left = viewportWidth - menuWidth - 8
    }
    if (y + menuHeight > viewportHeight) {
      top = viewportHeight - menuHeight - 8
    }

    return { left, top }
  }, [x, y, items.length])

  const position = adjustedPosition()

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    // Use setTimeout to avoid immediate close from the same click that opened the menu
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 0)
    document.addEventListener('keydown', handleEscape)

    return () => {
      clearTimeout(timeoutId)
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-card border border-border rounded-md shadow-lg py-1 min-w-[180px]"
      style={{ left: position.left, top: position.top }}
    >
      {items.map((item, index) => (
        <div
          key={index}
          className="relative"
          onMouseEnter={() => setHoveredIndex(index)}
          onMouseLeave={() => setHoveredIndex(null)}
        >
          <button
            onClick={() => {
              if (!item.disabled && item.onClick) {
                item.onClick()
                onClose()
              }
            }}
            disabled={item.disabled}
            className={cn(
              'w-full flex items-center px-3 py-2 text-sm transition-colors',
              item.disabled && 'opacity-50 cursor-not-allowed',
              item.variant === 'danger'
                ? 'text-red-400 hover:bg-red-500/10'
                : 'text-foreground hover:bg-secondary'
            )}
          >
            {item.icon && <span className="mr-2">{item.icon}</span>}
            {item.label}
            {item.submenu && <ChevronRight size={14} className="ml-auto" />}
          </button>

          {/* Submenu */}
          {item.submenu && hoveredIndex === index && (
            <div
              className="absolute left-full top-0 ml-1 bg-card border border-border rounded-md shadow-lg py-1 min-w-[160px]"
            >
              {item.submenu.map((subItem) => (
                <button
                  key={subItem.value}
                  onClick={() => {
                    if (item.onSubmenuSelect) {
                      item.onSubmenuSelect(subItem.value)
                    }
                    onClose()
                  }}
                  className="w-full flex items-center px-3 py-2 text-sm text-foreground hover:bg-secondary transition-colors"
                >
                  {subItem.isSelected ? (
                    <Check size={14} className="mr-2 text-primary" />
                  ) : (
                    <span className="w-[14px] mr-2" />
                  )}
                  {subItem.icon && <span className="mr-2">{subItem.icon}</span>}
                  {subItem.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
