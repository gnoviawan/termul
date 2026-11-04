/**
 * Who keeps detached DOM alive? Reads a V8 heap snapshot (`--heap-snapshot`
 * on a scenario run writes one) and prints:
 *  - detached DOM nodes by class, with their total self size;
 *  - the strong edges from live objects into the detached set, grouped by
 *    holder and edge name: these entry points are what to cut.
 *
 *   node --max-old-space-size=8192 tools/perf/heap-retainers.ts <file.heapsnapshot>
 */

import { readFileSync } from 'node:fs'

interface Snapshot {
  snapshot: {
    meta: {
      node_fields: string[]
      node_types: [string[], ...unknown[]]
      edge_fields: string[]
      edge_types: [string[], ...unknown[]]
    }
  }
  nodes: number[]
  edges: number[]
  strings: string[]
}

const file = process.argv[2]
if (!file) throw new Error('usage: node tools/perf/heap-retainers.ts <file.heapsnapshot>')
const snap = JSON.parse(readFileSync(file, 'utf8')) as Snapshot
const { meta } = snap.snapshot
const nodeFieldCount = meta.node_fields.length
const edgeFieldCount = meta.edge_fields.length
const NAME = meta.node_fields.indexOf('name')
const SELF = meta.node_fields.indexOf('self_size')
const EDGE_COUNT = meta.node_fields.indexOf('edge_count')
const DETACHED = meta.node_fields.indexOf('detachedness')
const EDGE_TYPE = meta.edge_fields.indexOf('type')
const EDGE_NAME = meta.edge_fields.indexOf('name_or_index')
const EDGE_TO = meta.edge_fields.indexOf('to_node')
const edgeTypes = meta.edge_types[0]
const nodeCount = snap.nodes.length / nodeFieldCount

const nameOf = (n: number): string => snap.strings[snap.nodes[n * nodeFieldCount + NAME]]
const TYPE = meta.node_fields.indexOf('type')
const nodeTypes = meta.node_types[0]
const typeOf = (n: number): string => nodeTypes[snap.nodes[n * nodeFieldCount + TYPE]]
// Name-based detection only for DOM objects: strings like "Detached HEAD" are not nodes.
const isDetached = (n: number): boolean =>
  (DETACHED !== -1 && snap.nodes[n * nodeFieldCount + DETACHED] === 2) ||
  (typeOf(n) !== 'string' &&
    typeOf(n) !== 'concatenated string' &&
    nameOf(n).startsWith('Detached '))

const detached = new Uint8Array(nodeCount)
const byClass = new Map<string, { count: number; bytes: number }>()
for (let n = 0; n < nodeCount; n++) {
  if (!isDetached(n)) continue
  detached[n] = 1
  const key = nameOf(n).split(' ').slice(0, 2).join(' ')
  const row = byClass.get(key) ?? { count: 0, bytes: 0 }
  row.count++
  row.bytes += snap.nodes[n * nodeFieldCount + SELF]
  byClass.set(key, row)
}

// Shortest strong path from the GC roots to each node, as DevTools shows it.
const firstEdge = new Uint32Array(nodeCount + 1)
{
  let e = 0
  for (let n = 0; n < nodeCount; n++) {
    firstEdge[n] = e
    e += snap.nodes[n * nodeFieldCount + EDGE_COUNT] * edgeFieldCount
  }
  firstEdge[nodeCount] = e
}
const parent = new Int32Array(nodeCount).fill(-1)
const parentEdge = new Int32Array(nodeCount).fill(-1)
parent[0] = 0
const queue = new Uint32Array(nodeCount)
let tail = 0
queue[tail++] = 0
for (let head = 0; head < tail; head++) {
  const n = queue[head]
  // Paths stop at the first detached node: the question is who holds the entry.
  if (detached[n] === 1) continue
  for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += edgeFieldCount) {
    const type = edgeTypes[snap.edges[e + EDGE_TYPE]]
    if (type === 'weak' || type === 'shortcut') continue
    const to = snap.edges[e + EDGE_TO] / nodeFieldCount
    if (parent[to] !== -1) continue
    parent[to] = n
    parentEdge[to] = e
    queue[tail++] = to
  }
}
const edgeLabel = (e: number): string => {
  const type = edgeTypes[snap.edges[e + EDGE_TYPE]]
  const raw = snap.edges[e + EDGE_NAME]
  return type === 'element' || type === 'hidden' ? `[${raw}]` : String(snap.strings[raw] ?? raw)
}
const pathTo = (target: number): string[] => {
  const steps: string[] = []
  for (let n = target; n !== 0 && steps.length < 40; n = parent[n]) {
    steps.push(`${nameOf(n).slice(0, 50)} <-${edgeLabel(parentEdge[n])}-`)
  }
  return steps
}
// Each entry point into the detached set keeps a whole removed subtree alive
// (parent and child pointers are strong). Flood the detached set from every
// entry and charge each detached node to the first entry chain that reaches it.
const groups = new Map<string, { entries: number; held: number; sample: number }>()
const owner = new Int32Array(nodeCount).fill(-1)
const keys: string[] = []
const flood: number[] = []
for (let n = 0; n < nodeCount; n++) {
  if (detached[n] !== 1 || parent[n] === -1 || detached[parent[n]] === 1) continue
  const key = pathTo(n).slice(1, 5).join(' ')
  let group = groups.get(key)
  if (!group) {
    group = { entries: 0, held: 0, sample: n }
    groups.set(key, group)
    keys.push(key)
  }
  group.entries++
  owner[n] = keys.indexOf(key)
  flood.push(n)
}
for (let head = 0; head < flood.length; head++) {
  const n = flood[head]
  for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += edgeFieldCount) {
    const type = edgeTypes[snap.edges[e + EDGE_TYPE]]
    if (type === 'weak' || type === 'shortcut') continue
    const to = snap.edges[e + EDGE_TO] / nodeFieldCount
    if (detached[to] !== 1 || owner[to] !== -1) continue
    owner[to] = owner[n]
    flood.push(to)
  }
}
let unreachable = 0
for (let n = 0; n < nodeCount; n++) {
  if (detached[n] !== 1) continue
  if (owner[n] === -1) unreachable++
  else (groups.get(keys[owner[n]]) as { held: number }).held++
}

const totalDetached = [...byClass.values()].reduce((sum, row) => sum + row.count, 0)
console.log(`nodes ${nodeCount}, detached DOM ${totalDetached}`)
console.log('\ndetached by class (count, self MB):')
for (const [key, row] of [...byClass.entries()]
  .sort((a, b) => b[1].count - a[1].count)
  .slice(0, 15)) {
  console.log(
    `  ${String(row.count).padStart(7)}  ${(row.bytes / 1e6).toFixed(2).padStart(7)}  ${key}`
  )
}
console.log(`\ndetached nodes held by no live chain (garbage awaiting GC): ${unreachable}`)
console.log('\nholder chains, by detached nodes they keep alive:')
for (const [, group] of [...groups.entries()].sort((a, b) => b[1].held - a[1].held).slice(0, 8)) {
  console.log(`\n  keeps ${group.held} detached nodes via ${group.entries} entries, e.g.:`)
  for (const step of pathTo(group.sample).slice(0, 14)) console.log(`      ${step}`)
}
