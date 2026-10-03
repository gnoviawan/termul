import {
  AnimatePresence,
  domAnimation,
  LazyMotion,
  m,
  PresenceContext,
  useReducedMotion
} from 'framer-motion'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Collapse/expand via `grid-template-rows` 0fr→1fr (not `height`), so layout
 * work stays cheaper than animating pixel height. See animations skill.
 *
 * Uses LazyMotion + `m` for the shell only. Do not enable `strict`: chat
 * children (ToolCallCard / ThoughtGroup / ChatMessage) still use `motion.*`,
 * and strict mode throws when those nest under this provider.
 */
/** Sidebar and file tree. Agent Chat passes `motion="chat"`. */
const DEFAULT_COLLAPSE = {
  duration: 0.15,
  ease: 'easeInOut' as const
}

/** Accordion token: 250ms smooth-out, same duration open and close. */
const CHAT_COLLAPSE = {
  duration: 0.25,
  ease: [0.22, 1, 0.36, 1] as const
}

interface CollapseExpandMotionProps {
  open: boolean
  children: ReactNode
  className?: string
  onExitComplete?: () => void
  /** Agent Chat disclosures use the 250ms accordion timing. */
  motion?: 'default' | 'chat'
}

export function CollapseExpandMotion({
  open,
  children,
  className,
  onExitComplete,
  motion: motionPreset = 'default'
}: CollapseExpandMotionProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const collapseExpandTransition = motionPreset === 'chat' ? CHAT_COLLAPSE : DEFAULT_COLLAPSE

  return (
    <LazyMotion features={domAnimation}>
      <AnimatePresence initial={false} onExitComplete={onExitComplete}>
        {open && (
          <m.div
            initial={
              reduced
                ? false
                : motionPreset === 'chat'
                  ? { gridTemplateRows: '0fr' }
                  : { gridTemplateRows: '0fr', opacity: 0 }
            }
            animate={
              motionPreset === 'chat'
                ? { gridTemplateRows: '1fr' }
                : { gridTemplateRows: '1fr', opacity: 1 }
            }
            exit={
              reduced
                ? { opacity: 0 }
                : motionPreset === 'chat'
                  ? { gridTemplateRows: '0fr' }
                  : { gridTemplateRows: '0fr', opacity: 0 }
            }
            transition={reduced ? { duration: 0 } : collapseExpandTransition}
            className={cn('grid overflow-hidden', className)}
          >
            <div className="min-h-0 overflow-hidden">
              {/* `initial={false}` must stop at this shell; inherited, it blocks every child entrance. */}
              <PresenceContext.Provider value={null}>{children}</PresenceContext.Provider>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </LazyMotion>
  )
}
