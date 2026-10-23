/** Radix Collapsible: Root (`open` / `defaultOpen` / `onOpenChange`), a toggling Trigger, and Content shown while open. */
import type { PublicInstance } from '@gpuix/react'
import { createContext, forwardRef, useContext } from 'react'
import { Box, type HostProps } from './internal/host'
import { useControllableState } from './internal/overlay'
import { ModalPressLike } from './internal/press'

interface CollapsibleState {
  open: boolean
  disabled: boolean
  toggle(): void
}

const CollapsibleContext = createContext<CollapsibleState>({
  open: false,
  disabled: false,
  toggle: () => {}
})

export interface CollapsibleProps extends HostProps {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
}

const Collapsible = forwardRef<PublicInstance, CollapsibleProps>(
  ({ open, defaultOpen = false, onOpenChange, disabled = false, ...props }, ref) => {
    const [current, setCurrent] = useControllableState(open, defaultOpen, onOpenChange)
    const state = { open: current, disabled, toggle: () => setCurrent(!current) }
    return (
      <CollapsibleContext.Provider value={state}>
        <Box
          ref={ref}
          data-state={current ? 'open' : 'closed'}
          data-disabled={disabled ? '' : undefined}
          {...props}
        />
      </CollapsibleContext.Provider>
    )
  }
)
Collapsible.displayName = 'Collapsible'

const CollapsibleTrigger = forwardRef<PublicInstance, HostProps & { asChild?: boolean }>(
  (props, ref) => {
    const state = useContext(CollapsibleContext)
    return (
      <ModalPressLike
        ref={ref}
        {...props}
        disabled={state.disabled}
        aria-expanded={state.open}
        data-state={state.open ? 'open' : 'closed'}
        onPress={state.toggle}
      />
    )
  }
)
CollapsibleTrigger.displayName = 'CollapsibleTrigger'

const CollapsibleContent = forwardRef<PublicInstance, HostProps & { forceMount?: true }>(
  ({ forceMount, ...props }, ref) => {
    const state = useContext(CollapsibleContext)
    if (!state.open && !forceMount) return null
    return <Box ref={ref} data-state={state.open ? 'open' : 'closed'} {...props} />
  }
)
CollapsibleContent.displayName = 'CollapsibleContent'

export { Collapsible, CollapsibleContent, CollapsibleTrigger }
