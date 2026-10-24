/**
 * Prints the headline metrics of one or more aggregate.json files as a
 * Markdown table, one column per file.
 *
 *   bun run perf:report <label>=<dir> [<label>=<dir> ...]   (from apps/gpuix)
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

interface Cell {
  median: number
  min: number
  max: number
  n: number
}
type Aggregate = { scenarios: Record<string, { okRuns: number; metrics: Record<string, Cell> }> }

const HEADLINE: Record<string, string[]> = {
  idle: [
    'startup.projectListMs',
    'startup.launcherReadyMs',
    'measure.proc.total.pssMedianMB',
    'measure.proc.total.rssMedianMB',
    'measure.proc.page-renderer.pssMedianMB',
    'measure.proc.total.cpuMeanPct',
    'measure.proc.page-renderer.cpuMeanPct',
    'measure.proc.gpu-process.cpuMeanPct',
    'measure.page.fps',
    'measure.screen.fps',
    'measure.bytesDownKBps',
    'measure.machine.foreignCpuPct'
  ],
  'stream-storm': [
    'startup.projectListMs',
    'startup.launcherReadyMs',
    'startup.proc.total.pssMedianMB',
    'chat.firstStartMs',
    'chat.startUnderLoadP50Ms',
    'chat.startUnderLoadMaxMs',
    'chat.typeUnderLoadP50Ms',
    'chat.openUnderLoadP50Ms',
    'chatsOpen',
    'chat.switches',
    'measure.proc.total.pssMedianMB',
    'measure.proc.total.rssMedianMB',
    'measure.proc.page-renderer.pssMedianMB',
    'measure.proc.page-renderer.rssMedianMB',
    'measure.proc.total.cpuMeanPct',
    'measure.proc.page-renderer.cpuMeanPct',
    'measure.proc.gpu-process.cpuMeanPct',
    'measure.screen.fps',
    'measure.screen.gapP50Ms',
    'measure.screen.gapP95Ms',
    'measure.page.fps',
    'measure.page.frameP50Ms',
    'measure.page.frameP95Ms',
    'measure.page.framesOver50Ms',
    'measure.page.longtaskMsPerSec',
    'measure.page.loafBlockingMs',
    'measure.page.heapEndMB',
    'measure.page.domNodes',
    'measure.bytesDownKBps',
    'measure.server.cpuMeanPct',
    'measure.machine.foreignCpuPct',
    'sustained-stream.screen.fps',
    'sustained-stream.screen.gapP95Ms',
    'sustained-stream.page.fps',
    'sustained-stream.page.frameP95Ms',
    'sustained-stream.page.longtaskMsPerSec',
    'sustained-stream.proc.total.cpuMeanPct'
  ],
  'pty-flood': [
    'startup.projectListMs',
    'startup.launcherReadyMs',
    'measure.proc.total.pssMedianMB',
    'measure.proc.total.rssMedianMB',
    'measure.proc.page-renderer.pssMedianMB',
    'measure.proc.page-renderer.rssMedianMB',
    'measure.proc.total.cpuMeanPct',
    'measure.proc.page-renderer.cpuMeanPct',
    'measure.proc.gpu-process.cpuMeanPct',
    'measure.screen.fps',
    'measure.screen.gapP50Ms',
    'measure.screen.gapP95Ms',
    'measure.page.fps',
    'measure.page.frameP95Ms',
    'measure.page.longtaskMsPerSec',
    'measure.bytesDownKBps',
    'measure.server.cpuMeanPct',
    'measure.machine.foreignCpuPct',
    'probe.pacedLinesPerSecPerTerminal',
    'probe.pacedRttP50Ms',
    'probe.pacedRttP95Ms',
    'probe.pacedTimeouts',
    'probe.burstMB',
    'probe.burstTotalMs',
    'probe.burstMBps',
    'burst.proc.total.cpuMeanPct',
    'burst.screen.fps',
    'burst.page.longtaskMsPerSec'
  ]
}

const columns = Bun.argv.slice(2).map((arg) => {
  const [label, dir] = arg.includes('=') ? arg.split('=') : [path.basename(arg), arg]
  return {
    label,
    agg: JSON.parse(readFileSync(path.join(dir, 'aggregate.json'), 'utf8')) as Aggregate
  }
})

const fmt = (c: Cell | undefined) => (c ? `${c.median} (${c.min} to ${c.max})` : 'n/a')

for (const [scenario, keys] of Object.entries(HEADLINE)) {
  if (!columns.some((c) => c.agg.scenarios[scenario])) continue
  const runs = columns.map((c) => c.agg.scenarios[scenario]?.okRuns ?? 0).join(', ')
  console.log(`\n### ${scenario} (ok runs per column: ${runs})\n`)
  console.log(`| Metric | ${columns.map((c) => c.label).join(' | ')} |`)
  console.log(`|---|${columns.map(() => '---').join('|')}|`)
  for (const key of keys) {
    console.log(
      `| \`${key}\` | ${columns.map((c) => fmt(c.agg.scenarios[scenario]?.metrics[key])).join(' | ')} |`
    )
  }
}
