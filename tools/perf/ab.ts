/**
 * Interleaved A/B runner: alternates two app exes (A, B, A, B, ...) through
 * the same scenario so warmup, caches and machine drift favor neither, then
 * prints median and range per metric plus the error and work counts that
 * say whether each run did the work it claims.
 *
 *   node tools/perf/ab.ts --a <exeA> --b <exeB> --runs 5 -- stream-storm --seed 42
 *
 * Writes the per-run summaries to tools/perf/results/ab-<stamp>.json.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RESULTS_ROOT, restoreDevAppData, TOOLKIT_ROOT } from './runner/launch.ts'
import type { PerfRunResult } from './types.ts'

const METRICS: Array<{ key: string; unit: 'MB' | 'count' | 'ms' }> = [
  { key: 'endAppPrivateBytes', unit: 'MB' },
  { key: 'endRendererPrivateBytes', unit: 'MB' },
  { key: 'endGpuPrivateBytes', unit: 'MB' },
  { key: 'endHostPrivateBytes', unit: 'MB' },
  { key: 'endOtherChildPrivateBytes', unit: 'MB' },
  { key: 'endHeapAfterGcBytes', unit: 'MB' },
  { key: 'endDomNodes', unit: 'count' },
  { key: 'droppedFrameCount', unit: 'count' },
  { key: 'totalLoafBlockingMs', unit: 'ms' },
  { key: 'interactionMaxMs', unit: 'ms' },
  { key: 'agentUpdatesEmitted', unit: 'count' },
  { key: 'appLogErrorLines', unit: 'count' }
]

interface Side {
  exe: string
}

interface AbArgs {
  a: Side
  b: Side
  runs: number
  /** Per-run limit; a soak needs more than the default. */
  timeoutMs: number
  scenario: string[]
}

function positiveInt(flag: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`)
  }
  return value
}

function parseArgs(argv: string[]): AbArgs {
  const sep = argv.indexOf('--')
  const own = sep === -1 ? argv : argv.slice(0, sep)
  const scenario = sep === -1 ? ['stream-storm'] : argv.slice(sep + 1)
  const get = (flag: string): string | undefined => {
    const i = own.indexOf(flag)
    return i === -1 ? undefined : own[i + 1]
  }
  const a = get('--a')
  const b = get('--b')
  if (!a || !b)
    throw new Error(
      'usage: node tools/perf/ab.ts --a <exe> --b <exe> [--runs N] [--timeout-min M] -- <scenario> [flags]'
    )
  return {
    a: { exe: a },
    b: { exe: b },
    runs: positiveInt('--runs', get('--runs'), 5),
    timeoutMs: positiveInt('--timeout-min', get('--timeout-min'), 15) * 60 * 1000,
    scenario
  }
}

function stopAppsFrom(exe: string): void {
  const target = path.resolve(exe).replace(/'/g, "''")
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${target}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }`
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true
  })
}

function runOnce(side: Side, scenario: string[], timeoutMs: number): PerfRunResult | null {
  const args = [path.join(TOOLKIT_ROOT, 'cli.ts'), ...scenario, '--exe', side.exe]
  const proc = spawnSync('node', args, { encoding: 'utf8', timeout: timeoutMs })
  if (proc.signal) {
    // The killed runner never reached its teardown: stop the app it spawned
    // before the next run starts, and put the developer's app data back.
    stopAppsFrom(side.exe)
    restoreDevAppData()
    console.log(`  run exceeded ${timeoutMs / 60000} min and was stopped`)
  }
  const runId = /run (\S+) (ok|FAILED)/.exec(proc.stdout ?? '')?.[1]
  if (!runId) {
    console.log(`  no run id; exit ${proc.status}: ${(proc.stderr ?? '').slice(-300)}`)
    return null
  }
  return JSON.parse(readFileSync(path.join(RESULTS_ROOT, runId, 'result.json'), 'utf8'))
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function format(value: number, unit: string): string {
  if (unit === 'MB') return `${(value / 1e6).toFixed(0)}`
  return `${Math.round(value)}`
}

const { a, b, runs, timeoutMs, scenario } = parseArgs(process.argv.slice(2))
const sides: Record<'A' | 'B', PerfRunResult[]> = { A: [], B: [] }
for (let i = 0; i < runs; i++) {
  for (const [label, side] of [
    ['A', a],
    ['B', b]
  ] as const) {
    const result = runOnce(side, scenario, timeoutMs)
    const status = result ? result.meta.status : 'missing'
    console.log(`run ${i + 1}/${runs} ${label} ${status} ${result?.meta.runId ?? ''}`)
    if (result && result.meta.status === 'ok') sides[label].push(result)
  }
}

const describe = (side: Side): string => side.exe
console.log(`\nA = ${describe(a)}\nB = ${describe(b)}\nscenario: ${scenario.join(' ')}`)
console.log(`ok runs: A ${sides.A.length}/${runs}, B ${sides.B.length}/${runs}\n`)
console.log(
  'metric'.padEnd(28),
  'A median [range]'.padEnd(24),
  'B median [range]'.padEnd(24),
  'delta'
)
for (const { key, unit } of METRICS) {
  const cell = (results: PerfRunResult[]): { text: string; med: number | null } => {
    const xs = results.map((r) => r.summary[key]).filter((x): x is number => typeof x === 'number')
    if (xs.length === 0) return { text: 'n/a', med: null }
    const med = median(xs)
    return {
      text: `${format(med, unit)} [${format(Math.min(...xs), unit)}..${format(Math.max(...xs), unit)}]`,
      med
    }
  }
  const ca = cell(sides.A)
  const cb = cell(sides.B)
  const delta =
    ca.med !== null && cb.med !== null && ca.med !== 0
      ? `${(((cb.med - ca.med) / ca.med) * 100).toFixed(1)}%`
      : ''
  console.log(`${key} (${unit})`.padEnd(28), ca.text.padEnd(24), cb.text.padEnd(24), delta)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const out = path.join(RESULTS_ROOT, `ab-${stamp}.json`)
writeFileSync(
  out,
  JSON.stringify(
    {
      a,
      b,
      scenario,
      runs: {
        A: sides.A.map((r) => ({ runId: r.meta.runId, summary: r.summary })),
        B: sides.B.map((r) => ({ runId: r.meta.runId, summary: r.summary }))
      }
    },
    null,
    2
  )
)
console.log(`\nwrote ${out}`)
