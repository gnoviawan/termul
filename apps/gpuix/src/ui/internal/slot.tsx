/**
 * Radix `Slot`: merge a primitive's props into its single child (`asChild`).
 * Children here are GPUIX ui components, so the merged props stay DOM-shaped.
 * Same rules as @radix-ui/react-slot: both handlers run (child first), class
 * names concatenate, the child's style and other props win, refs merge.
 */
import type { PublicInstance } from '@gpuix/react'
import { cloneElement, forwardRef, isValidElement, type ReactElement, type Ref } from 'react'
import { cn } from '@/lib/utils'
import { mergeRefs } from './host'

type AnyProps = Record<string, unknown>

function elementRef(element: ReactElement): Ref<PublicInstance> | undefined {
  const props = element.props as AnyProps
  if (props.ref) return props.ref as Ref<PublicInstance>
  return (element as unknown as { ref?: Ref<PublicInstance> }).ref
}

function mergeSlotProps(slot: AnyProps, child: AnyProps): AnyProps {
  const merged: AnyProps = { ...slot, ...child }
  for (const key of Object.keys(slot)) {
    const a = slot[key]
    const b = child[key]
    if (/^on[A-Z]/.test(key) && typeof a === 'function' && typeof b === 'function') {
      merged[key] = (...args: unknown[]) => {
        b(...args)
        a(...args)
      }
    }
  }
  if (slot.className || child.className)
    merged.className = cn(slot.className as string, child.className as string)
  if (slot.style && child.style)
    merged.style = { ...(slot.style as object), ...(child.style as object) }
  return merged
}

export const Slot = forwardRef<PublicInstance, AnyProps & { children?: unknown }>(function Slot(
  { children, ...props },
  ref
) {
  if (!isValidElement(children)) throw new Error('asChild expects exactly one React element child')
  const merged = mergeSlotProps(props, children.props as AnyProps)
  merged.ref = mergeRefs(elementRef(children), ref)
  return cloneElement(children, merged)
})
