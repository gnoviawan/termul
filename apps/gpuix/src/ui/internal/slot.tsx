/**
 * Radix `Slot`: merge a primitive's props into its single child (`asChild`).
 * Same rules as @radix-ui/react-slot: both handlers run (child first), class
 * names concatenate, the child's style and other props win, refs merge.
 *
 * A GPUIX ui child takes the merged DOM-shaped props as they are. A DOM
 * element from shared code (`<ContextMenuTrigger asChild><div …>`) was
 * already translated to a GPUIX element when it was created, so its DOM props
 * are merged and translated again; otherwise the primitive's handlers would
 * land on the GPUIX element raw and get GPUIX payloads instead of DOM events.
 */
import type { PublicInstance } from '@gpuix/react'
import {
  cloneElement,
  forwardRef,
  isValidElement,
  type ReactElement,
  type Ref,
  useMemo
} from 'react'
import { cn } from '@/lib/utils'
import { domSource } from '../../compat/create'
import { type CompatElement, decorateInstance, trackedInstance } from '../../compat/dom-node'
import { cloneElement as cloneDomElement } from '../../compat/react'
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

/**
 * The ref of a re-translated DOM child: shared code's own ref keeps the DOM
 * node compat hands it, the primitive's ref gets the GPUIX instance (decorated,
 * so it also answers DOM calls), as every src/ui ref does.
 */
function domChildRef(
  childRef: Ref<unknown> | undefined,
  slotRef: Ref<PublicInstance>
): (node: CompatElement | null) => void {
  return (node) => {
    mergeRefs(childRef)(node)
    const instance = node ? trackedInstance(node.elementId) : undefined
    mergeRefs(slotRef)(instance ? (decorateInstance(instance) as unknown as PublicInstance) : null)
  }
}

export const Slot = forwardRef<PublicInstance, AnyProps & { children?: unknown }>(function Slot(
  { children, ...props },
  ref
) {
  if (!isValidElement(children)) throw new Error('asChild expects exactly one React element child')
  const source = domSource.get(children)
  const childRef = (source ? source.props.ref : elementRef(children)) as Ref<unknown> | undefined
  const domRef = useMemo(() => domChildRef(childRef, ref), [childRef, ref])
  const merged = mergeSlotProps(props, (source?.props ?? children.props) as AnyProps)
  if (source) {
    merged.ref = domRef
    return cloneDomElement(children, merged)
  }
  merged.ref = mergeRefs(childRef as Ref<PublicInstance> | undefined, ref)
  return cloneElement(children, merged)
})
