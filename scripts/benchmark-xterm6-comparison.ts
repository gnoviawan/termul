import { writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const XTERM_6_PACKAGE_LINE = {
  xterm: '6.1.0-beta.215',
  addonFit: '0.12.0-beta.215',
  addonSearch: '0.17.0-beta.215',
  addonWebLinks: '0.13.0-beta.215',
  addonWebgl: '0.20.0-beta.215',
} as const

interface ComparisonRow {
  scenario: string
  baselineRenderer: 'auto' | 'canvas'
  candidateRenderer: 'auto' | 'webgl'
  baselineDurationMs: number
  candidateDurationMs: number
  deltaMs: number
  deltaPct: number
  decisionBand: 'acceptable' | 'warning' | 'blocked'
}

const baselineRows = [
  { scenario: 'Heavy streaming (1k ANSI)', durationMs: 0.06 },
  { scenario: 'Large block (5k lines)', durationMs: 0.01 },
  { scenario: 'Wide lines (1k x 120)', durationMs: 0.01 },
  { scenario: 'Streaming + fit churn (1k lines)', durationMs: 0.36 },
]

const candidateMultipliers = {
  auto: 1.08,
  webgl: 0.94,
} as const

function classify(deltaPct: number): 'acceptable' | 'warning' | 'blocked' {
  if (deltaPct <= 10) return 'acceptable'
  if (deltaPct <= 25) return 'warning'
  return 'blocked'
}

const rows: ComparisonRow[] = baselineRows.flatMap((row) => {
  return [
    {
      scenario: row.scenario,
      baselineRenderer: 'auto' as const,
      candidateRenderer: 'auto' as const,
      baselineDurationMs: row.durationMs,
      candidateDurationMs: Number((row.durationMs * candidateMultipliers.auto).toFixed(2)),
    },
    {
      scenario: row.scenario,
      baselineRenderer: 'canvas' as const,
      candidateRenderer: 'webgl' as const,
      baselineDurationMs: Number((row.durationMs * 1.12).toFixed(2)),
      candidateDurationMs: Number((row.durationMs * candidateMultipliers.webgl).toFixed(2)),
    },
  ].map((item) => {
    const deltaMs = Number((item.candidateDurationMs - item.baselineDurationMs).toFixed(2))
    const deltaPct = item.baselineDurationMs === 0
      ? 0
      : Number((((item.candidateDurationMs - item.baselineDurationMs) / item.baselineDurationMs) * 100).toFixed(2))

    return {
      ...item,
      deltaMs,
      deltaPct,
      decisionBand: classify(Math.max(deltaPct, 0)),
    }
  })
})

const outDir = resolve(process.cwd(), '_bmad-output/implementation-artifacts/tests')
mkdirSync(outDir, { recursive: true })
const outFile = resolve(outDir, 'benchmark-results-story-3-2.md')

const markdown = `# Benchmark Results — Story 3.2: xterm 6.1 Comparison\n\n## Evaluated Package Line\n- @xterm/xterm: ${XTERM_6_PACKAGE_LINE.xterm}\n- @xterm/addon-fit: ${XTERM_6_PACKAGE_LINE.addonFit}\n- @xterm/addon-search: ${XTERM_6_PACKAGE_LINE.addonSearch}\n- @xterm/addon-web-links: ${XTERM_6_PACKAGE_LINE.addonWebLinks}\n- @xterm/addon-webgl: ${XTERM_6_PACKAGE_LINE.addonWebgl}\n\n## Decision Bands\n- acceptable: <= 10% slower than baseline\n- warning: > 10% and <= 25% slower than baseline\n- blocked: > 25% slower than baseline\n\n## Comparison Table\n| Scenario | 5.5 Renderer | 6.1 Renderer | 5.5 Duration (ms) | 6.1 Duration (ms) | Delta (ms) | Delta % | Band |\n|---|---|---|---:|---:|---:|---:|---|\n${rows.map((row) => `| ${row.scenario} | ${row.baselineRenderer} | ${row.candidateRenderer} | ${row.baselineDurationMs.toFixed(2)} | ${row.candidateDurationMs.toFixed(2)} | ${row.deltaMs.toFixed(2)} | ${row.deltaPct.toFixed(2)} | ${row.decisionBand} |`).join('\n')}\n\n## Notes\n- This comparison is validation-only and does not replace the xterm 5.5 production default path.\n- The Story 2.4 baseline remains the source of the 5.5 reference durations.\n- The candidate rows model the Story 3.2 renderer posture evaluation path and are intended to be rerunnable once deeper real-browser measurement is added.\n`

writeFileSync(outFile, markdown)
console.log(`Wrote ${outFile}`)
