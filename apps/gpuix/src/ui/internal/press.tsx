/** A `<button>`-like part that runs `onPress` on click, Enter or Space; `asChild` merges into the child. */
import type { PublicInstance } from '@gpuix/react'
import { buttonProps } from '@gpuix/react/button'
import { forwardRef } from 'react'
import { Box, type HostProps, toMouseEvent } from './host'
import { Slot } from './slot'

export const ModalPressLike = forwardRef<
  PublicInstance,
  HostProps & { asChild?: boolean; disabled?: boolean; onPress(): void }
>(function ModalPressLike({ asChild, disabled = false, onPress, onClick, ...props }, ref) {
  const press: HostProps['onClick'] = (event) => {
    onClick?.(event)
    if (!event.defaultPrevented && !disabled) onPress()
  }
  if (asChild) return <Slot ref={ref} {...props} onClick={press} />
  const behavior = buttonProps({
    disabled,
    tabIndex: props.tabIndex,
    onClick: (event) => press(toMouseEvent(event))
  })
  return (
    <Box
      ref={ref}
      role="button"
      {...props}
      state={{ disabled }}
      native={{
        tabIndex: behavior.tabIndex ?? 0,
        onClick: behavior.onClick,
        onKeyDown: behavior.onKeyDown,
        onKeyUp: behavior.onKeyUp
      }}
    />
  )
})
