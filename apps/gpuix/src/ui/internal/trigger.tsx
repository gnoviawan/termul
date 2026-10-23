/**
 * The trigger part every overlay shares: a `<button>`-like Box (or the
 * `asChild` child) whose instance the Root keeps, so content can be portalled
 * into it and focus can return to it.
 */
import type { PublicInstance } from '@gpuix/react'
import { buttonProps } from '@gpuix/react/button'
import { forwardRef, type Ref, useCallback } from 'react'
import { Box, type HostProps, mergeRefs, toMouseEvent } from './host'
import type { OverlayState } from './overlay'
import { Slot } from './slot'

export interface TriggerProps extends HostProps {
  asChild?: boolean
  disabled?: boolean
}

export function useTriggerRef(overlay: OverlayState, forwarded: Ref<PublicInstance>) {
  const { setTrigger } = overlay
  return useCallback(
    (instance: PublicInstance | null) => {
      mergeRefs(forwarded)(instance)
      setTrigger(instance)
    },
    [forwarded, setTrigger]
  )
}

export const TriggerBase = forwardRef<PublicInstance, TriggerProps & { overlay: OverlayState }>(
  function TriggerBase({ overlay, asChild, disabled = false, ...props }, forwarded) {
    const ref = useTriggerRef(overlay, forwarded)
    const state = overlay.open ? 'open' : 'closed'
    if (asChild)
      return <Slot ref={ref} {...props} data-state={state} aria-expanded={overlay.open} />
    const { onClick, ...rest } = props
    // Enter on key down and Space on key up click it, like the <button> Radix renders.
    const behavior = buttonProps({
      disabled,
      tabIndex: props.tabIndex,
      onClick: (event) => onClick?.(toMouseEvent(event))
    })
    return (
      <Box
        ref={ref}
        role="button"
        {...rest}
        data-state={state}
        aria-expanded={overlay.open}
        state={{ disabled }}
        native={{
          tabIndex: behavior.tabIndex ?? 0,
          onClick: behavior.onClick,
          onKeyDown: behavior.onKeyDown,
          onKeyUp: behavior.onKeyUp
        }}
      />
    )
  }
)
