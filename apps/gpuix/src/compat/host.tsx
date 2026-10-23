/**
 * The stateful host, for the few elements whose classes read state GPUIX
 * does not track: `group-*` variants, `focus:` / `focus-within:`, viewport
 * breakpoints, and the `group` element those variants watch. Everything
 * else is built directly by `createDomElement`.
 */

import type { StyleDesc } from '@gpuix/react'
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
import { subscribeViewport, viewportWidth } from './viewport'

interface GroupSnapshot {
  hovered: boolean
  focused: boolean
  attrs: Readonly<Record<string, unknown>>
}

function attrValues(attrs: Readonly<Record<string, unknown>>, names: string[]): string {
  let out = ''
  for (const name of names) out += `|${String(attrs[name])}`
  return out
}

/** A `group` element's live state. Consumers subscribe; the group itself never re-renders for it. */
class GroupStore {
  private snapshot: GroupSnapshot
  private attrsKey: string
  private readonly listeners = new Set<() => void>()

  constructor(attrs: Readonly<Record<string, unknown>> = {}, attrsKey = '{}') {
    this.snapshot = { hovered: false, focused: false, attrs }
    this.attrsKey = attrsKey
  }

  /** New attributes notify consumers only when they differ by value. */
  setAttrs(attrs: Readonly<Record<string, unknown>>, key: string): void {
    if (key === this.attrsKey) return
    this.attrsKey = key
    this.set({ attrs })
  }

  get = (): GroupSnapshot => this.snapshot

  /** What a consumer reads, as a value: it re-renders only when this changes. */
  keyFor(attrNames: string[]): string {
    const { hovered, focused, attrs } = this.snapshot
    return `${hovered ? 1 : 0}${focused ? 1 : 0}${attrValues(attrs, attrNames)}`
  }

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
  /** Attributes the rules read, on the element itself and on its group. */
  selfAttrs: string[]
  groupAttrs: string[]
}

const needsCache = new WeakMap<Translation, Needs>()

function needsOf(tr: Translation): Needs {
  let needs = needsCache.get(tr)
  if (needs) return needs
  const out: Needs = { group: false, focus: false, viewport: false, selfAttrs: [], groupAttrs: [] }
  const visit = (c: Condition) => {
    if (c.kind === 'viewport') out.viewport = true
    else if (c.kind === 'attr' && c.scope === 'group') {
      out.group = true
      if (!out.groupAttrs.includes(c.attr)) out.groupAttrs.push(c.attr)
    } else if (c.kind === 'attr' && !out.selfAttrs.includes(c.attr)) out.selfAttrs.push(c.attr)
    else if (c.kind === 'flag' && c.flag.startsWith('group')) out.group = true
    else if (c.kind === 'flag' && (c.flag === 'focus' || c.flag === 'focusWithin')) out.focus = true
  }
  for (const rule of tr.compiled.rules) rule.when.forEach(visit)
  needs = out
  needsCache.set(tr, needs)
  return needs
}

const styleCache = new WeakMap<Translation, Map<string, StyleDesc>>()

/**
 * The resolved style for one state. A host re-renders with its parent, so the
 * same state recurs; returning the same object also lets GPUIX skip the
 * style diff.
 */
function hostStyle(tr: Translation, needs: Needs, state: TwState, dark: boolean): StyleDesc {
  if (tr.compiled.rules.length === 0) return tr.base
  const flags = [dark, state.disabled, state.focus, state.focusWithin, state.groupHover, state.groupFocus]
  const key =
    flags.map((flag) => (flag ? '1' : '0')).join('') +
    `${needs.viewport ? state.viewportWidth : ''}${attrValues(state.attrs ?? {}, needs.selfAttrs)}` +
    attrValues(state.groupAttrs ?? {}, needs.groupAttrs)
  let byState = styleCache.get(tr)
  if (!byState) {
    byState = new Map()
    styleCache.set(tr, byState)
  }
  let style = byState.get(key)
  if (!style) {
    style = applyRules({ ...tr.compiled, base: tr.base }, state, dark)
    byState.set(key, style)
  }
  return style
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
  useSyncExternalStore(needs.group ? parentGroup.subscribe : noSubscribe, () => parentGroup.keyFor(needs.groupAttrs))
  const group = parentGroup.get()
  const [focus, setFocus] = useState({ self: false, within: false })
  const width = useSyncExternalStore(needs.viewport ? subscribeViewport : noSubscribe, viewportWidth)
  const attrs = domAttrs(dom)
  const attrsKey = tr.group !== null ? JSON.stringify(attrs) : ''
  const ownStore = useRef<GroupStore | null>(null)
  if (tr.group !== null && !ownStore.current) ownStore.current = new GroupStore(attrs, attrsKey)
  const store = ownStore.current
  const disabled = Boolean(dom.disabled)
  useLayoutEffect(() => {
    store?.setAttrs(attrs, attrsKey)
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
  const style = hostStyle(tr, needs, state, compatDark())

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
