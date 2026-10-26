/**
 * The stateful host, for the few elements whose classes read state GPUIX
 * does not track: `group-*` and `peer-*` variants, `focus:` /
 * `focus-within:`, viewport breakpoints, and the `group` and `peer` elements
 * those variants watch (`peer.ts` links a peer to its later siblings).
 * Everything else is built directly by `createDomElement`.
 *
 * A `group-*` consumer created in the same render as its group (the usual
 * `<div className="group">…<span className="group-hover:…">` in one
 * component) is resolved by the group: the group walks the elements it built
 * and builds those consumers with its own state, so a row re-render runs one
 * host instead of one per consumer. Consumers below a component or another
 * stateful host subscribe to the group through context, as before.
 */

import type { StyleDesc } from '@gpuix/react'
import {
  cloneElement,
  createContext,
  isValidElement,
  type ReactElement,
  type ReactNode,
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
import { buildElement, compatDark, type DomProps, domAttrs, domSource } from './create'
import { ownPeerLink, type PeerSnapshot, type PeerStore, readPeerLink } from './peer'
import type { Translation } from './translate'
import { subscribeViewport, viewportWidth } from './viewport'

type GroupSnapshot = PeerSnapshot

function attrValues(attrs: Readonly<Record<string, unknown>>, names: string[]): string {
  let out = ''
  for (const name of names) out += `|${String(attrs[name])}`
  return out
}

/** A `group` or `peer` element's live state. Consumers subscribe; a peer never re-renders for it. */
class GroupStore implements PeerStore {
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
  peer: boolean
  focus: boolean
  viewport: boolean
  /** Attributes the rules read, on the element itself and on its group. */
  selfAttrs: string[]
  groupAttrs: string[]
  peerAttrs: string[]
}

const needsCache = new WeakMap<Translation, Needs>()

function needsOf(tr: Translation): Needs {
  let needs = needsCache.get(tr)
  if (needs) return needs
  const out: Needs = { group: false, peer: false, focus: false, viewport: false, selfAttrs: [], groupAttrs: [], peerAttrs: [] }
  const visit = (c: Condition) => {
    if (c.kind === 'viewport') out.viewport = true
    else if (c.kind === 'attr' && c.scope === 'group') {
      out.group = true
      if (!out.groupAttrs.includes(c.attr)) out.groupAttrs.push(c.attr)
    } else if (c.kind === 'attr' && c.scope === 'peer') {
      out.peer = true
      if (!out.peerAttrs.includes(c.attr)) out.peerAttrs.push(c.attr)
    } else if (c.kind === 'attr' && !out.selfAttrs.includes(c.attr)) out.selfAttrs.push(c.attr)
    else if (c.kind === 'flag' && c.flag.startsWith('group')) out.group = true
    else if (c.kind === 'flag' && c.flag.startsWith('peer')) out.peer = true
    else if (c.kind === 'flag' && (c.flag === 'focus' || c.flag === 'focusWithin')) out.focus = true
  }
  for (const rule of tr.compiled.rules) rule.when.forEach(visit)
  needs = out
  needsCache.set(tr, needs)
  return needs
}

/** Whether the translation has `focus:` or `focus-within:` rules: its element must track focus. */
export function readsFocus(tr: Translation): boolean {
  return needsOf(tr).focus
}

const styleCache = new WeakMap<Translation, Map<string, StyleDesc>>()

/**
 * The resolved style for one state. A host re-renders with its parent, so the
 * same state recurs; returning the same object also lets GPUIX skip the
 * style diff.
 */
function hostStyle(tr: Translation, needs: Needs, state: TwState, dark: boolean): StyleDesc {
  if (tr.compiled.rules.length === 0) return tr.base
  const flags = [dark, state.disabled, state.focus, state.focusWithin, state.groupHover, state.groupFocus, state.peerHover, state.peerFocus]
  const key =
    flags.map((flag) => (flag ? '1' : '0')).join('') +
    `${needs.viewport ? state.viewportWidth : ''}${attrValues(state.attrs ?? {}, needs.selfAttrs)}` +
    attrValues(state.groupAttrs ?? {}, needs.groupAttrs) +
    attrValues(state.peerAttrs ?? {}, needs.peerAttrs)
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

/** Consumers that read only their group's state (no focus or viewport rules of their own). */
function groupOnly(tr: Translation): boolean {
  const needs = needsOf(tr)
  return needs.group && !needs.peer && !needs.focus && !needs.viewport && tr.group === null && !tr.peer
}

/** A consumer's element as its own `CompatHost` would build it for this group state. */
function consumerElement(props: CompatHostProps, key: string | null, group: GroupSnapshot): ReactElement {
  const { tag, tr, dom, isStatic, font } = props
  const attrs = domAttrs(dom)
  const state: TwState = {
    disabled: Boolean(dom.disabled),
    attrs: attrs as TwState['attrs'],
    focus: false,
    focusWithin: false,
    groupHover: group.hovered,
    groupFocus: group.focused,
    groupFocusVisible: group.focused,
    groupAttrs: group.attrs as TwState['groupAttrs']
  }
  const style = hostStyle(tr, needsOf(tr), state, compatDark())
  const built = buildElement(tag, tr, dom, key ?? undefined, isStatic, { style, handlers: NO_HANDLERS, nativeStyle: font })
  domSource.set(built, { tag, props: dom, key: key ?? undefined })
  return claimConsumers(built, group) as ReactElement
}

const NO_HANDLERS: Record<string, unknown> = {}

/**
 * Replace the group-only consumers in built GPUIX elements with their own
 * built elements. Layout already ran with the consumer as an opaque host, so
 * the tree is the one the consumer's `CompatHost` would have rendered. The
 * walk stops at components and other hosts (they render their children
 * later) and at nested groups. Returns `node` itself when nothing changed.
 */
function claimConsumers(node: ReactNode, group: GroupSnapshot): ReactNode {
  if (Array.isArray(node)) {
    let out: ReactNode[] | null = null
    for (let i = 0; i < node.length; i++) {
      const next = claimConsumers(node[i], group)
      if (next !== node[i]) (out ??= node.slice())[i] = next
    }
    return out ?? node
  }
  if (!isValidElement(node)) return node
  if (node.type === CompatHost) {
    const host = node.props as CompatHostProps
    return groupOnly(host.tr) ? consumerElement(host, node.key, group) : node
  }
  const props = node.props as { children?: ReactNode }
  if (typeof node.type !== 'string' || props.children === undefined) return node
  const children = claimConsumers(props.children, group)
  return children === props.children ? node : cloneElement(node, { children } as { children: ReactNode })
}

export interface CompatHostProps {
  tag: string
  tr: Translation
  dom: DomProps
  domKey: string | undefined
  isStatic: boolean
  /** The line height an inherited font resolves to (`font.tsx`). */
  font?: StyleDesc
}

function CompatHost({ tag, tr, dom, domKey, isStatic, font }: CompatHostProps): ReactElement {
  const needs = needsOf(tr)
  const parentGroup = useContext(GroupContext) ?? NO_GROUP
  useSyncExternalStore(needs.group ? parentGroup.subscribe : noSubscribe, () => parentGroup.keyFor(needs.groupAttrs))
  const group = parentGroup.get()
  const peerStore = (needs.peer ? readPeerLink(dom)?.store : null) ?? NO_GROUP
  useSyncExternalStore(needs.peer ? peerStore.subscribe : noSubscribe, () => peerStore.keyFor(needs.peerAttrs))
  const peer = peerStore.get()
  const [focus, setFocus] = useState({ self: false, within: false })
  const width = useSyncExternalStore(needs.viewport ? subscribeViewport : noSubscribe, viewportWidth)
  const attrs = domAttrs(dom)
  const tracked = tr.group !== null || tr.peer
  const attrsKey = tracked ? JSON.stringify(attrs) : ''
  const ownStore = useRef<GroupStore | null>(null)
  if (tracked && !ownStore.current) ownStore.current = new GroupStore(attrs, attrsKey)
  const store = ownStore.current
  const published = tr.peer ? ownPeerLink(dom) : undefined
  if (published && store) published.store = store
  // The group re-renders for its own hover and focus: it builds the consumers in its children.
  const groupStore = tr.group !== null ? store : null
  useSyncExternalStore(groupStore ? groupStore.subscribe : noSubscribe, () => (groupStore ? groupStore.keyFor([]) : ''))
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
    peerHover: peer.hovered,
    peerFocus: peer.focused,
    peerAttrs: peer.attrs as TwState['peerAttrs'],
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

  const built = buildElement(tag, tr, dom, undefined, isStatic, { style, handlers, nativeStyle: font })
  if (!groupStore) return built
  return jsx(GroupContext.Provider, { value: groupStore, children: claimConsumers(built, { ...groupStore.get(), attrs }) })
}

export function hostElement(
  tag: string,
  tr: Translation,
  dom: DomProps,
  key: string | undefined,
  isStatic: boolean,
  font?: StyleDesc
): ReactElement {
  return jsx(CompatHost, { tag, tr, dom, domKey: key, isStatic, font }, key)
}
