import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { descendants } from './proc-sampler.ts'

const CLK_TCK = Number(execFileSync('getconf', ['CLK_TCK']).toString().trim()) || 100

/** utime+stime ticks per thread of every process under `rootPid`, keyed `pid/tid`. */
export interface ThreadSnapshot {
  t: number
  ticks: Map<string, { comm: string; ticks: number }>
}

export function snapshotThreads(rootPid: number): ThreadSnapshot {
  const ticks = new Map<string, { comm: string; ticks: number }>()
  for (const pid of descendants(rootPid)) {
    let tids: string[]
    try {
      tids = readdirSync(`/proc/${pid}/task`)
    } catch {
      continue
    }
    for (const tid of tids) {
      try {
        const raw = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8')
        const comm = raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')'))
        const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
        ticks.set(`${pid}/${tid}`, { comm, ticks: Number(fields[11]) + Number(fields[12]) })
      } catch {
        // thread exited between listing and reading
      }
    }
  }
  return { t: Date.now(), ticks }
}

/**
 * CPU per thread name over the window between two snapshots, in percent of
 * one core, summed over threads that share a name (Chromium's eight
 * `llvmpipe-N` become one line each; same names in different processes are
 * kept apart by `role`). Reading /proc twice per phase costs the client nothing.
 */
export function threadCpu(
  before: ThreadSnapshot,
  after: ThreadSnapshot,
  roleOfPid: (pid: number) => string,
  top = 12
): Array<{ thread: string; cpuPct: number }> {
  const seconds = (after.t - before.t) / 1000
  const byName = new Map<string, number>()
  for (const [key, cur] of after.ticks) {
    // A thread born inside the window spent all its ticks there.
    const prev = before.ticks.get(key)?.ticks ?? 0
    const pid = Number(key.slice(0, key.indexOf('/')))
    const name = `${roleOfPid(pid)}:${cur.comm.replace(/\d+$/, 'N')}`
    byName.set(name, (byName.get(name) ?? 0) + (cur.ticks - prev) / CLK_TCK)
  }
  return [...byName]
    .map(([thread, s]) => ({ thread, cpuPct: Math.round((s / seconds) * 1000) / 10 }))
    .filter((r) => r.cpuPct > 0)
    .sort((a, b) => b.cpuPct - a.cpuPct)
    .slice(0, top)
}
