import { describe, expect, test } from 'bun:test'
import { createRoot, flushSync, type NativeRenderer, type StyleDesc } from '@gpuix/react'
import { useState } from 'react'
import { parkHiddenPanes } from '../../src/compat/park'
import { Spinner } from '../../src/ui/spinner'

/**
 * The retained tree `applyBatch` mutates, with the semantics of GPUIX's
 * `retained_tree.rs`: append and insert detach the child from its old parent,
 * an unknown `before` appends, and destroy is recursive.
 */
class FakeTree {
  readonly nodes = new Map<
    number,
    { type: string; text?: string; style?: StyleDesc; parent?: number; children: number[] }
  >()
  root: number | null = null

  applyBatch(json: string): number[] {
    const destroyed: number[] = []
    for (const [kind, a, b, c] of JSON.parse(json) as [string, number, unknown, unknown][]) {
      if (kind === 'createElement') this.nodes.set(a, { type: b as string, children: [] })
      else if (kind === 'setRoot') this.root = a
      else if (kind === 'setText') this.node(a).text = b as string
      else if (kind === 'setStyle') this.node(a).style = b as StyleDesc
      else if (kind === 'appendChild') this.place(a, b as number, null)
      else if (kind === 'insertBefore') this.place(a, b as number, c as number)
      else if (kind === 'destroyElement') {
        this.detach(a)
        this.destroy(a, destroyed)
      }
    }
    return destroyed
  }

  /** Text reachable from the root, in tree order: what a frame builds. */
  builtText(): string[] {
    const out: string[] = []
    const walk = (id: number) => {
      const node = this.node(id)
      if (node.text !== undefined) out.push(node.text)
      for (const child of node.children) walk(child)
    }
    if (this.root !== null) walk(this.root)
    return out
  }

  private node(id: number) {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`no element ${id}`)
    return node
  }

  private detach(id: number): void {
    const parent = this.nodes.get(id)?.parent
    if (parent === undefined) return
    const siblings = this.node(parent).children
    siblings.splice(siblings.indexOf(id), 1)
  }

  private place(parent: number, child: number, before: number | null): void {
    this.detach(child)
    this.node(child).parent = parent
    const siblings = this.node(parent).children
    const at = before === null ? -1 : siblings.indexOf(before)
    siblings.splice(at === -1 ? siblings.length : at, 0, child)
  }

  private destroy(id: number, destroyed: number[]): void {
    const node = this.nodes.get(id)
    if (!node) return
    this.nodes.delete(id)
    destroyed.push(id)
    for (const child of node.children) this.destroy(child, destroyed)
  }
}

const HIDDEN: StyleDesc = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  visibility: 'hidden'
}
const SHOWN: StyleDesc = { width: '100%', height: '100%' }

let bump = () => {}
function Counter({ label }: { label: string }) {
  const [count, setCount] = useState(0)
  bump = () => setCount((n) => n + 1)
  return <text>{`${label} ${count}`}</text>
}

function Panes({ panes }: { panes: Array<{ key: string; hidden?: boolean; style?: StyleDesc }> }) {
  return (
    <div>
      {panes.map(({ key, hidden, style }) => (
        <div key={key} style={style ?? (hidden ? HIDDEN : SHOWN)}>
          <Counter label={key} />
        </div>
      ))}
    </div>
  )
}

function mount() {
  const tree = new FakeTree()
  const parking = parkHiddenPanes(tree)
  const root = createRoot(tree as unknown as NativeRenderer)
  return {
    tree,
    parking,
    render: (panes: Parameters<typeof Panes>[0]['panes']) =>
      flushSync(() => root.render(<Panes panes={panes} />)),
    root
  }
}

describe('parkHiddenPanes', () => {
  test('a hidden full-bleed pane leaves the built tree and keeps its React state', () => {
    const { tree, parking, render } = mount()
    render([{ key: 'a' }, { key: 'chat' }])
    flushSync(() => bump())
    expect(tree.builtText()).toEqual(['a 0', 'chat 1'])

    render([{ key: 'a' }, { key: 'chat', hidden: true }])
    expect(tree.builtText()).toEqual(['a 0'])
    expect(parking.parked()).toBe(1)

    flushSync(() => bump())
    render([{ key: 'a' }, { key: 'chat' }])
    expect(tree.builtText()).toEqual(['a 0', 'chat 2'])
    expect(parking.parked()).toBe(0)
  })

  test('siblings placed around a parked pane keep React order when it returns', () => {
    const { tree, render } = mount()
    render([{ key: 'a' }, { key: 'chat', hidden: true }, { key: 'c' }])
    render([{ key: 'a' }, { key: 'b' }, { key: 'chat', hidden: true }, { key: 'c' }])
    render([{ key: 'a' }, { key: 'b' }, { key: 'chat' }, { key: 'c' }])
    expect(tree.builtText()).toEqual(['a 0', 'b 0', 'chat 0', 'c 0'])
  })

  test('a parked pane React moves comes back at its new place', () => {
    const { tree, render } = mount()
    render([{ key: 'a' }, { key: 'b' }, { key: 'chat', hidden: true }, { key: 'c' }])
    render([{ key: 'a' }, { key: 'c' }, { key: 'b' }, { key: 'chat', hidden: true }])
    render([{ key: 'a' }, { key: 'c' }, { key: 'b' }, { key: 'chat' }])
    expect(tree.builtText()).toEqual(['a 0', 'c 0', 'b 0', 'chat 0'])
  })

  test('a pane mounted hidden is parked from its first batch', () => {
    const { tree, render } = mount()
    render([{ key: 'a' }, { key: 'chat', hidden: true }])
    expect(tree.builtText()).toEqual(['a 0'])
  })

  test('unmounting a parked pane frees it and its placeholder', () => {
    const { tree, render, root } = mount()
    render([{ key: 'a' }])
    const before = tree.nodes.size
    render([{ key: 'a' }, { key: 'chat', hidden: true }])
    render([{ key: 'a' }])
    // The park root stays for the next hidden pane.
    expect(tree.nodes.size).toBe(before + 1)
    root.unmount()
  })

  test('unmounting an ancestor of a parked pane frees the pane too', () => {
    const { tree, parking, render, root } = mount()
    render([{ key: 'a' }, { key: 'chat', hidden: true }])
    const destroyed: number[] = []
    const native = tree.applyBatch.bind(tree)
    const parked = [...tree.nodes].filter(([, node]) => node.text === 'chat 0').map(([id]) => id)
    tree.applyBatch = (json) => {
      const ids = native(json)
      destroyed.push(...ids)
      return ids
    }
    flushSync(() => root.render(<text>gone</text>))
    expect([...tree.nodes.values()].map((node) => node.text).filter(Boolean)).toEqual(['gone'])
    expect(destroyed).toEqual(expect.arrayContaining(parked))
    expect(parking.parked()).toBe(0)
  })

  test('a spinner in a parked pane stops sending frames until the pane shows', async () => {
    const tree = new FakeTree()
    const parking = parkHiddenPanes(tree)
    let sources = 0
    const native = tree.applyBatch.bind(tree)
    tree.applyBatch = (json) => {
      for (const op of JSON.parse(json) as unknown[][])
        if (op[0] === 'setCustomProp' && op[2] === 'source') sources++
      return native(json)
    }
    const root = createRoot(tree as unknown as NativeRenderer)
    const show = (hidden: boolean) =>
      flushSync(() =>
        root.render(
          <div>
            <div style={hidden ? HIDDEN : SHOWN}>
              <Spinner />
            </div>
          </div>
        )
      )
    show(true)
    sources = 0
    await Bun.sleep(150)
    expect(sources).toBe(0)
    show(false)
    await Bun.sleep(150)
    expect(sources).toBeGreaterThan(3)
    root.unmount()
    parking.uninstall()
  })

  test('a hidden element that takes room in its parent stays in the tree', () => {
    const { tree, render } = mount()
    render([{ key: 'a' }, { key: 'icon', style: { visibility: 'hidden' } }])
    expect(tree.builtText()).toEqual(['a 0', 'icon 0'])
  })
})
