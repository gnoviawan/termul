/** The bench's store: N projects, one of them renamed per update. */

import { create } from 'zustand'
import type { Project } from '@/types/project'

export const ROWS = Number(
  (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.BENCH_ROWS ?? 60
)
const COLORS = ['blue', 'green', 'purple', 'red', 'orange', 'yellow', 'pink', 'cyan'] as const

function project(i: number): Project {
  return {
    id: `bench-${i}`,
    name: `project ${i}`,
    path: `/tmp/bench/${i}`,
    color: COLORS[i % COLORS.length],
    isActive: i === 0
  } as unknown as Project
}

interface BenchState {
  projects: Project[]
  rename(index: number, name: string): void
}

export const useBenchStore = create<BenchState>((set) => ({
  projects: Array.from({ length: ROWS }, (_, i) => project(i)),
  rename: (index, name) =>
    set((state) => ({
      projects: state.projects.map((p, i) => (i === index ? ({ ...p, name } as Project) : p))
    }))
}))

export const IDLE_STATUS = { live: null, attentionCount: 0, crashed: false } as const
export const noop = (): void => {}
