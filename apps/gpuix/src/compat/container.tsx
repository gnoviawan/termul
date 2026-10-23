/**
 * Tailwind container queries (`@container` and `@[35rem]:flex-row`). GPUIX has
 * no container queries, and a class string is translated once, so an element
 * whose classes name one renders through `ContainerHost`: a `@container`
 * element measures its own width and provides it, and each `@[w]:` variant
 * below it is kept or dropped against the nearest container's width before
 * the string is translated. The first frame renders as if the container were
 * narrow (no width yet), then settles once the container reports its size.
 *
 * Named containers (`@container/name`, `@[w]/name:`) are not used by Termul
 * and resolve against the nearest container.
 */

import { type ReactElement, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { createDomElement, type DomProps, domSource } from './create'
import type { CompatElement } from './dom-node'
import { hostElement } from './host'
import { CompatResizeObserver } from './resize'

const ROOT_FONT_SIZE = 16
const CONTAINER = /(^|\s)@container(\/[\w-]+)?(?=\s|$)/
const QUERY = /^@\[(\d*\.?\d+)(px|rem)\](?:\/[\w-]+)?:(.+)$/
const CONTAINER_TOKEN = /^@(?:\[|container)/

/** Width of the nearest `@container` ancestor; `null` until it has been measured. */
const ContainerWidth = createContext<number | null>(null)

export function hasContainerClasses(className: unknown): className is string {
  return typeof className === 'string' && className.includes('@') && className.split(/\s+/).some((t) => CONTAINER_TOKEN.test(t))
}

/**
 * The class string with `@container` removed and each `@[w]:cls` kept as `cls`
 * when the container is at least `w` wide (CSS `min-width` semantics), or
 * dropped when it is narrower or not measured yet.
 */
export function resolveContainerClasses(className: string, width: number | null): string {
  const out: string[] = []
  for (const token of className.split(/\s+/)) {
    if (!token || CONTAINER.test(token)) continue
    const query = token.match(QUERY)
    if (!query) {
      out.push(token)
      continue
    }
    const min = Number.parseFloat(query[1]) * (query[2] === 'rem' ? ROOT_FONT_SIZE : 1)
    if (width !== null && width >= min) out.push(query[3])
  }
  return out.join(' ')
}

interface ContainerHostProps {
  tag: string
  dom: DomProps
  isStatic: boolean
}

type RefProp = ((node: CompatElement | null) => unknown) | { current: unknown } | null | undefined

function ContainerHost({ tag, dom, isStatic }: ContainerHostProps): ReactElement {
  const outer = useContext(ContainerWidth)
  const className = dom.className as string
  const isContainer = CONTAINER.test(className)
  const [own, setOwn] = useState<number | null>(null)
  const observer = useRef<CompatResizeObserver | null>(null)
  const userRef = dom.ref as RefProp
  useEffect(() => () => observer.current?.disconnect(), [])
  const ref = useCallback(
    (node: CompatElement | null) => {
      if (typeof userRef === 'function') userRef(node)
      else if (userRef) userRef.current = node
      if (!isContainer) return
      observer.current?.disconnect()
      observer.current = null
      if (!node) return
      const next = new CompatResizeObserver((entries) => {
        const width = entries[entries.length - 1]?.borderBoxSize[0]?.inlineSize
        if (typeof width === 'number') setOwn(Math.round(width))
      })
      next.observe(node)
      observer.current = next
    },
    [userRef, isContainer]
  )
  const resolved = resolveContainerClasses(className, outer)
  const props = { ...dom, className: resolved, ...(isContainer || dom.ref != null ? { ref } : {}) }
  const element = createDomElement(tag, props as DomProps, undefined, isStatic, hostElement)
  return isContainer ? jsx(ContainerWidth.Provider, { value: own, children: element }) : element
}

/**
 * The compat element for one DOM tag: through `ContainerHost` when its classes
 * use container queries, else straight from `createDomElement`.
 */
export function compatElement(tag: string, props: DomProps, key: string | undefined, isStatic: boolean): ReactElement {
  if (!hasContainerClasses(props.className)) return createDomElement(tag, props, key, isStatic, hostElement)
  const element = jsx(ContainerHost, { tag, dom: props, isStatic }, key)
  domSource.set(element, { tag, props, key })
  return element
}
