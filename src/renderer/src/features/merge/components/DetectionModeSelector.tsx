/**
 * Detection Mode Selector Component
 *
 * Radio button selector for conflict detection mode (Accurate vs Fast).
 * Source: Story 2.2 - Task 1: Create Detection Mode Selector Component
 */

import { memo, useState, useCallback, useRef, useEffect } from 'react'
import { Check, Info, Zap } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { DetectionMode } from '@/shared/types/merge.types'

export interface DetectionModeSelectorProps {
  selectedMode: DetectionMode
  onModeChange: (mode: DetectionMode) => void
  className?: string
  disabled?: boolean
}

/**
 * Tooltip component for mode descriptions
 */
interface TooltipProps {
  content: string
  children: React.ReactElement
}

const Tooltip = ({ content, children }: TooltipProps) => {
  const [isVisible, setIsVisible] = useState(false)
  const timeoutRef = useRef<NodeJS.Timeout>()

  const handleMouseEnter = useCallback(() => {
    // 500ms delay before showing tooltip (NFR7)
    timeoutRef.current = setTimeout(() => {
      setIsVisible(true)
    }, 500)
  }, [])

  const handleMouseLeave = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    setIsVisible(false)
  }, [])

  return (
    <div
      className="relative inline-block"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-50"
        >
          <div className="bg-popover border border-border text-popover-foreground text-xs rounded-md px-3 py-2 shadow-lg max-w-[280px]">
            {content}
          </div>
        </motion.div>
      )}
    </div>
  )
}

/**
 * Detection mode option configuration
 */
const DETECTION_MODES: Array<{
  value: DetectionMode
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  iconColor: string
  badge?: string
}> = [
  {
    value: 'accurate',
    label: 'Accurate',
    description: 'Runs full merge simulation. Slower but detects all potential conflicts. Recommended for critical merges.',
    icon: Check,
    iconColor: 'text-blue-500',
    badge: 'Recommended'
  },
  {
    value: 'fast',
    label: 'Fast',
    description: 'Quick check using git status. Faster but may miss some conflicts. Good for development branches.',
    icon: Zap,
    iconColor: 'text-yellow-500'
  }
]

/**
 * DetectionModeSelector - Radio button selector for detection mode
 */
export const DetectionModeSelector = memo(({
  selectedMode,
  onModeChange,
  className,
  disabled = false
}: DetectionModeSelectorProps) => {
  const [focusedMode, setFocusedMode] = useState<DetectionMode | null>(null)

  const handleModeChange = useCallback((mode: DetectionMode) => {
    if (!disabled) {
      onModeChange(mode)
    }
  }, [disabled, onModeChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent, mode: DetectionMode) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleModeChange(mode)
    }
  }, [handleModeChange])

  return (
    <div className={cn('space-y-3', className)}>
      <label className="text-sm font-medium text-foreground">
        Detection Mode
      </label>

      <div
        className="space-y-2"
        role="radiogroup"
        aria-label="Conflict detection mode"
      >
        {DETECTION_MODES.map((mode) => {
          const Icon = mode.icon
          const isSelected = selectedMode === mode.value
          const isFocused = focusedMode === mode.value

          return (
            <Tooltip key={mode.value} content={mode.description}>
              <motion.button
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={disabled}
                onFocus={() => setFocusedMode(mode.value)}
                onBlur={() => setFocusedMode(null)}
                onKeyDown={(e) => handleKeyDown(e, mode.value)}
                onClick={() => handleModeChange(mode.value)}
                whileHover={disabled ? {} : { scale: 1.01 }}
                whileTap={disabled ? {} : { scale: 0.99 }}
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-all',
                  'relative overflow-hidden',
                  isSelected
                    ? 'bg-blue-500/10 border-blue-500/50 shadow-sm'
                    : 'bg-secondary/20 border-border hover:bg-secondary/40',
                  isFocused && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
                  disabled && 'opacity-50 cursor-not-allowed'
                )}
              >
                {/* Radio indicator */}
                <div className="flex-shrink-0">
                  <div className={cn(
                    'w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors',
                    isSelected
                      ? 'border-blue-500 bg-blue-500'
                      : 'border-muted-foreground hover:border-blue-500'
                  )}>
                    {isSelected && (
                      <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        className="w-2.5 h-2.5 rounded-full bg-background"
                      />
                    )}
                  </div>
                </div>

                {/* Icon */}
                <div className={cn(
                  'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
                  isSelected ? 'bg-blue-500/20' : 'bg-secondary'
                )}>
                  <Icon className={cn('w-4 h-4', mode.iconColor)} />
                </div>

                {/* Label and badge */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      'text-sm font-medium',
                      isSelected ? 'text-foreground' : 'text-muted-foreground'
                    )}>
                      {mode.label}
                    </span>
                    {mode.badge && (
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-500 font-medium">
                        {mode.badge}
                      </span>
                    )}
                  </div>
                </div>

                {/* Info icon hint for tooltip */}
                <div className="flex-shrink-0 text-muted-foreground">
                  <Info className="w-4 h-4" />
                </div>
              </motion.button>
            </Tooltip>
          )
        })}
      </div>

      {/* Helper text */}
      <p className="text-xs text-muted-foreground pl-1">
        {selectedMode === 'accurate'
          ? 'Accurate mode runs full merge simulation (2-5 seconds)'
          : 'Fast mode uses git status parsing (within 1 second)'
        }
      </p>
    </div>
  )
})

DetectionModeSelector.displayName = 'DetectionModeSelector'
