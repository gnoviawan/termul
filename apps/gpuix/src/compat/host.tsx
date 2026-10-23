/**
 * The stateful host, for the few elements whose classes read state GPUIX
 * does not track: `group-*` variants, `focus:` / `focus-within:`, viewport
 * breakpoints, and the `group` element those variants watch. Everything
 * else is built directly by `createDomElement`.
 */

import { useWindowSize } from '@gpuix/react'
import {
  createContext,
  type ReactElement,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { jsx } from 'react/jsx-runtime'
import { applyRules } from '../style/tw'
import type { Condition, TwState } from '../style/variants'
import { buildElement, compatDark, type DomProps, domAttrs } from './create'
import type { Translation } from './translate'

interface GroupSnapshot {
  hovered: boolean
  focused: boolean
  attrs: Readonly<Record<string, unknown>>
}

/** A `group` element's live state. Consumers subscribe; the group itself never re-renders for it. */
class GroupStore {
  private snapshot: GroupSnapshot = { hovered: false, focused: false, attrs: {} }
  private readonly listeners = new Set<() => void>()

  get = (): GroupSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set(patch: Partial<GroupSnapshot>): void {
    const next = { ...this.snapshot, ...patch }
    if (next.hovered === this.snapshot.hovered && next.focused === this.snapshot.focused && next.attrs === this.snapshot.attrs) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

const GroupContext = createContext<GroupStore | null>(null)
const NO_GROUP = new GroupStore()

interface Needs {
  group: boolean
  focus: boolean
  viewport: boolean
}

const needsCache = new WeakMap<Translation, Needs>()

function needsOf(tr: Translation): Needs {
  let needs = needsCache.get(tr)
  if (needs) return needs
  needs = { group: false, focus: false, viewport: false }
  const visit = (c: Condition) => {
    if (c.kind === 'viewport') needs!.viewport = true
    else if (c.kind === 'attr' && c.scope === 'group') needs!.group = true
    else if (c.kind === 'flag' && c.flag.startsWith('group')) needs!.group = true
    else if (c.kind === 'flag' && (c.flag === 'focus' || c.flag === 'focusWithin')) needs!.focus = true
  }
  for (const rule of tr.compiled.rules) rule.when.forEach(visit)
  needsCache.set(tr, needs)
  return needs
}

const noSubscribe = () => () => {}

export interface CompatHostProps {
  tag: string
  tr: Translation
  dom: DomProps
  domKey: string | undefined
  isStatic: boolean
}

function CompatHost({ tag, tr, dom, domKey, isStatic }: CompatHostProps): ReactElement {
  const needs = needsOf(tr)
  const parentGroup = useContext(GroupContext) ?? NO_GROUP
  const group = useSyncExternalStore(needs.group ? parentGroup.subscribe : noSubscribe, parentGroup.get)
  const [focus, setFocus] = useState({ self: false, within: false })
  const width = useWindowSize().width
  const ownStore = useRef<GroupStore | null>(null)
  if (tr.group !== null && !ownStore.current) ownStore.current = new GroupStore()
  const store = ownStore.current

  const attrs = domAttrs(dom)
  const disabled = Boolean(dom.disabled)
  const attrsKey = store ? JSON.stringify(attrs) : ''
  useLayoutEffect(() => {
    store?.set({ attrs })
  }, [attrsKey])

  const state: TwState = {
    disabled,
    attrs: attrs as TwState['attrs'],
    focus: focus.self,
    focusWithin: focus.within,
    groupHover: group.hovered,
    groupFocus: group.focused,
    groupFocusVisible: group.focused,
    groupAttrs: group.attrs as TwState['groupAttrs'],
    viewportWidth: width
  }
  const style = tr.compiled.rules.length
    ? applyRules({ ...tr.compiled, base: tr.base }, state, compatDark())
    : tr.base

  const handlers = useMemo(() => {
    const out: Record<string, unknown> = {}
    const user = dom as Record<string, ((e: unknown) => void) | undefined>
    if (needs.focus || store) {
      out.onFocus = (e: { target: unknown; currentTarget: unknown }) => {
        const self = e.target === e.currentTarget
        setFocus((f) => (f.self === (f.self || self) && f.within ? f : { self: f.self || self, within: true }))
        store?.set({ focused: true })
        user.onFocus?.(e)
      }
      out.onBlur = (e: unknown) => {
        setFocus({ self: false, within: false })
        store?.set({ focused: false })
        user.onBlur?.(e)
      }
    }
    if (store) {
      out.onMouseEnter = (e: unknown) => {
        store.set({ hovered: true })
        user.onMouseEnter?.(e)
      }
      out.onMouseLeave = (e: unknown) => {
        store.set({ hovered: false })
        user.onMouseLeave?.(e)
      }
    }
    return out
  }, [dom, needs.focus, store])

  const built = buildElement(tag, tr, dom, undefined, isStatic, { style, handlers })
  if (!store) return built
  return jsx(GroupContext.Provider, { value: store, children: built })
}

export function hostElement(
  tag: string,
  tr: Translation,
  dom: DomProps,
  key: string | undefined,
  isStatic: boolean
): ReactElement {
  return jsx(CompatHost, { tag, tr, dom, domKey: key, isStatic }, key)
}
