/**
 * Per-run cells of an `ab.ts` result set as a Markdown table: one column per
 * label, each cell the runs in order, so a reader sees spread, not only a
 * median. `-` marks a run that did not record the metric.
 *
 *   bun tools/perf/ab-table.ts <set-dir> [label ...]   (from apps/gpuix)
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

interface RunRecord {
  meta: { run: number; status: string; load1Before: number }
  metrics: Record<string, number>
  errors: string[]
  notes: {
    chatsOpen?: number
    census?: Record<string, { reachable: number; listCulled: number }>
    threads?: Record<string, Array<{ thread: string; cpuPct: number }>>
  }
}

const [setDir, ...wanted] = Bun.argv.slice(2)
if (!setDir) throw new Error('usage: ab-table.ts <set-dir> [label ...]')
const labels = wanted.length ? wanted : readdirSync(setDir).filter((d) => !d.startsWith('.'))

const records = new Map<string, RunRecord[]>()
for (const label of labels) {
  const dir = path.join(setDir, label)
  const runs = readdirSync(dir)
    .filter((f) => /-run\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as RunRecord)
    .sort((a, b) => a.meta.run - b.meta.run)
  records.set(label, runs)
}

const thread = (r: RunRecord, name: string) =>
  r.notes.threads?.measure?.find((t) => t.thread === `app:${name}`)?.cpuPct
const metric = (key: string) => (r: RunRecord) => r.metrics[key]

const ROWS: Array<[string, (r: RunRecord) => number | string | undefined]> = [
  ['Run status', (r) => r.meta.status],
  ['Errors (lost chat starts, timeouts)', (r) => r.errors.length],
  ['Chats open at the end', (r) => r.notes.chatsOpen],
  ['Frames on screen, measure (fps)', metric('measure.screen.fps')],
  [
    'Frames on screen, sustained stream with chat switches (fps)',
    metric('sustained-stream.screen.fps')
  ],
  ['Chat start while others stream, p50 (ms)', metric('chat.startUnderLoadP50Ms')],
  ['Typing a 13-character prompt, p50 (ms)', metric('chat.typeUnderLoadP50Ms')],
  ['`gpuix-ui` CPU, measure (% of a core)', (r) => thread(r, 'gpuix-ui')],
  ['`llvmpipe` CPU, measure (% of a core)', (r) => thread(r, 'llvmpipe-N')],
  ['Client CPU, measure (% of a core)', metric('measure.proc.total.cpuMeanPct')],
  ['Client PSS, measure, median (MB)', metric('measure.proc.total.pssMedianMB')],
  ['Client PSS, measure, peak (MB)', metric('measure.proc.total.pssMaxMB')],
  ['Elements reachable from the root, measure', metric('measure.tree.reachable')],
  [
    'Of those, built (not culled by a list)',
    (r) => {
      const census = r.notes.census?.measure
      return census ? census.reachable - census.listCulled : undefined
    }
  ],
  ['Mutation JSON sent, measure (KB/s)', metric('measure.ui.batchKBPerS')],
  ['Load average at start', (r) => r.meta.load1Before]
]

const fmt = (v: number | string | undefined) =>
  v === undefined ? '-' : typeof v === 'number' ? `${Math.round(v * 10) / 10}` : v

console.log(`| Metric | ${labels.join(' | ')} |`)
console.log(`|---|${labels.map(() => '---').join('|')}|`)
for (const [name, read] of ROWS) {
  const cells = labels.map((label) =>
    (records.get(label) ?? []).map((r) => fmt(read(r))).join(', ')
  )
  console.log(`| ${name} | ${cells.join(' | ')} |`)
}
const crashes = labels.map(
  (label) =>
    (records.get(label) ?? []).filter((r) => r.errors.some((e) => /app crashed/.test(e))).length
)
console.log(`| Runs with a crash | ${crashes.join(' | ')} |`)
