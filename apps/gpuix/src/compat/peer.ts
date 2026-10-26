/**
 * CSS `peer`: `.peer:focus-within ~ .x`. A `peer-*` rule reads the state of
 * an earlier sibling marked `peer`. Siblings share no React context, so the
 * parent links them when it builds its children: a consumer's DOM props map
 * to the link of its nearest earlier peer, and the peer's `CompatHost` puts
 * its store in that link when it renders, which React does before it renders
 * any later sibling.
 */

import { Fragment, isValidElement, type ReactNode } from 'react'
import type { Condition } from '../style/variants'
import type { Translation } from './translate'

export interface PeerSnapshot {
  hovered: boolean
  focused: boolean
  attrs: Readonly<Record<string, unknown>>
}

export interface PeerStore {
  get(): PeerSnapshot
  keyFor(attrNames: string[]): string
  subscribe(listener: () => void): () => void
}

export interface PeerLink {
  store: PeerStore | null
}

interface Marked {
  dom: object
  peer: boolean
  reads: boolean
}

const marked = new WeakMap<object, Marked>()
/** The link a `peer` element publishes its store in, by its DOM props. */
const owned = new WeakMap<object, PeerLink>()
/** The link of the nearest earlier peer, by a consumer's DOM props. */
const read = new WeakMap<object, PeerLink>()
const readsCache = new WeakMap<Translation, boolean>()
let anyPeer = false

const peerCondition = (c: Condition) =>
  (c.kind === 'attr' && c.scope === 'peer') || (c.kind === 'flag' && c.flag.startsWith('peer'))

function readsPeer(tr: Translation): boolean {
  let reads = readsCache.get(tr)
  if (reads === undefined) {
    reads = tr.compiled.rules.some((rule) => rule.when.some(peerCondition))
    readsCache.set(tr, reads)
  }
  return reads
}

/** Record that `element` is a peer or reads one, so its parent can link it. */
export function markPeer(element: object, tr: Translation, dom: object): void {
  const reads = readsPeer(tr)
  if (!tr.peer && !reads) return
  anyPeer = true
  marked.set(element, { dom, peer: tr.peer, reads })
}

/** Link each consumer among `children` to its nearest earlier peer sibling. */
export function linkPeers(children: ReactNode): void {
  if (!anyPeer) return
  let link: PeerLink | null = null
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (!isValidElement(node)) return
    if (node.type === Fragment) {
      visit((node.props as { children?: ReactNode }).children)
      return
    }
    const mark = marked.get(node)
    if (!mark) return
    if (mark.reads && link) read.set(mark.dom, link)
    if (mark.peer) {
      link = owned.get(mark.dom) ?? { store: null }
      owned.set(mark.dom, link)
    }
  }
  visit(children)
}

export function ownPeerLink(dom: object): PeerLink | undefined {
  return owned.get(dom)
}

export function readPeerLink(dom: object): PeerLink | undefined {
  return read.get(dom)
}
