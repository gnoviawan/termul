/**
 * Interleaved A/B of GPUIX bundles (and Chromium) under one scenario set.
 * Each variant is `label=gpuix:<dist dir>` or `label=chromium`. Run `r` does
 * one run of every variant, in reverse order on even runs, through `run.ts`.
 * Each record lands in `<out>/<label>/` with `meta.client` set to the label,
 * so `runs-report.ts <out>` and `report.ts label=<out>/<label>` compare them.
 *
 *   bun tools/perf/ab.ts --variants base=gpuix:dist-sbase,park=gpuix:dist,chromium=chromium \
 *     --runs 5 --out <dir> -- --scenarios stream-storm --page-metrics off --port 8192 ...
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const argv = Bun.argv.slice(2)
const split = argv.indexOf('--')
const own = split === -1 ? argv : argv.slice(0, split)
const passThrough = split === -1 ? [] : argv.slice(split + 1)
const flag = (name: string, fallback?: string): string => {
  const at = own.indexOf(`--${name}`)
  const value = at === -1 ? fallback : own[at + 1]
  if (value === undefined) throw new Error(`missing --${name}`)
  return value
}

const variants = flag('variants')
  .split(',')
  .map((spec) => {
    const [label, target] = spec.split('=')
    const [client, dist] = target.split(':')
    if (client !== 'gpuix' && client !== 'chromium') throw new Error(`bad variant ${spec}`)
    return { label, client, dist }
  })
const runs = Number(flag('runs', '5'))
const out = path.resolve(flag('out'))

for (let run = 1; run <= runs; run++) {
  const order = run % 2 === 0 ? [...variants].reverse() : variants
  for (const v of order) {
    const scratchOut = path.join(out, '.scratch', `${v.label}-${run}`)
    const args = ['tools/perf/run.ts', '--client', v.client, '--runs', '1', '--out', scratchOut, ...passThrough]
    if (v.dist) args.push('--gpuix-dist', v.dist)
    console.log(`[ab] run ${run}/${runs} ${v.label}`)
    const child = Bun.spawn(['bun', ...args], { stdout: 'inherit', stderr: 'inherit' })
    await child.exited
    const dir = path.join(out, v.label)
    mkdirSync(dir, { recursive: true })
    for (const file of readdirSync(scratchOut).filter((f) => /-run1\.json$/.test(f))) {
      const record = JSON.parse(readFileSync(path.join(scratchOut, file), 'utf8'))
      record.meta.client = v.label
      record.meta.run = run
      writeFileSync(path.join(dir, file.replace('-run1.json', `-run${run}.json`)), JSON.stringify(record))
    }
    rmSync(scratchOut, { recursive: true, force: true })
  }
}
rmSync(path.join(out, '.scratch'), { recursive: true, force: true })
console.log(`[ab] wrote ${out}`)
