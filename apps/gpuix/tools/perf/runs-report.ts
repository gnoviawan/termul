/**
 * Per-run load and per-thread CPU of a multi-client result set, as Markdown.
 * `report.ts` prints the aggregate medians; this prints what explains them.
 *
 *   bun tools/perf/runs-report.ts <set-dir> [phase ...]   (from apps/gpuix)
 *
 * <set-dir> holds one directory per client (`run.ts --client a,b`).
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { median } from './stats.ts'

interface RunRecord {
  meta: {
    scenario: string
    run: number
    client: string
    status: string
    preRunBusyPct: number
    quietWaitS: number
    load1Before: number
  }
  metrics: Record<string, number>
  errors: string[]
  notes: { threads?: Record<string, Array<{ thread: string; cpuPct: number }>> }
}

const [setDir, ...phaseArgs] = Bun.argv.slice(2)
if (!setDir) throw new Error('usage: runs-report.ts <set-dir> [phase ...]')
const phases = phaseArgs.length ? phaseArgs : ['measure']

const runs: RunRecord[] = []
for (const client of readdirSync(setDir)) {
  const dir = path.join(setDir, client)
  for (const file of readdirSync(dir)) {
    if (/-run\d+\.json$/.test(file))
      runs.push(JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as RunRecord)
  }
}
runs.sort(
  (a, b) =>
    a.meta.run - b.meta.run ||
    a.meta.scenario.localeCompare(b.meta.scenario) ||
    a.meta.client.localeCompare(b.meta.client)
)

console.log('### Load and errors per run\n')
console.log(
  '| Run | Scenario | Client | Status | Pre-run busy | Gate wait | load1 | Foreign CPU, measure | Errors |'
)
console.log('|---|---|---|---|---|---|---|---|---|')
for (const r of runs) {
  const m = r.meta
  const errors = r.errors.map((e) => e.split('\n')[0].slice(0, 90)).join('; ') || 'none'
  console.log(
    `| ${m.run} | ${m.scenario} | ${m.client} | ${m.status} | ${m.preRunBusyPct}% | ${m.quietWaitS} s | ${m.load1Before.toFixed(1)} | ${r.metrics['measure.machine.foreignCpuPct'] ?? 'n/a'}% | ${errors} |`
  )
}

for (const phase of phases) {
  const groups = new Map<string, RunRecord[]>()
  for (const r of runs) {
    if (r.meta.status !== 'ok' || !r.notes.threads?.[phase]) continue
    const key = `${r.meta.scenario} / ${r.meta.client}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  if (!groups.size) continue
  console.log(`\n### Thread CPU in the \`${phase}\` phase, median of ok runs (% of one core)\n`)
  for (const [key, group] of groups) {
    const byThread = new Map<string, number[]>()
    for (const r of group) {
      for (const t of r.notes.threads?.[phase] ?? [])
        byThread.set(t.thread, [...(byThread.get(t.thread) ?? []), t.cpuPct])
    }
    const rows = [...byThread]
      // A thread missing from a run's top list counts as 0 there.
      .map(([thread, v]) => ({
        thread,
        cpu: median([...v, ...Array(group.length - v.length).fill(0)])
      }))
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, 6)
    console.log(
      `- ${key} (${group.length} runs): ${rows.map((r) => `\`${r.thread}\` ${r.cpu}`).join(', ')}`
    )
  }
}
