/**
 * Parity scenarios: one seeded server state and the test ids that must be
 * painted before either client is shot. The web client marks elements with
 * `data-testid`, the GPUIX client with `testId`; a scenario names the ids both
 * share.
 */

import path from 'node:path'
import { addProject, type TestServer } from './server'
import { seedWorkspace } from './workspace'

/** One frame once some test ids are painted, or the multi-step `workspace` run. */
export type Scenario =
  | {
      kind: 'still'
      name: string
      seed(server: TestServer): Promise<void>
      /** Test ids present in both clients once the state is on screen. */
      readyTestIds: string[]
    }
  | { kind: 'steps'; name: string; seed(server: TestServer): Promise<void> }

export const SEEDED_PROJECTS = [
  { id: 'parity-alpha', name: 'alpha' },
  { id: 'parity-beta', name: 'beta' }
] as const

export const SCENARIOS = {
  projects: {
    kind: 'still' as const,
    name: 'projects',
    async seed(server) {
      for (const project of SEEDED_PROJECTS) {
        await addProject(server, {
          ...project,
          path: path.join(server.stateDir, 'projects', project.name),
          color: 'blue'
        })
      }
    },
    readyTestIds: SEEDED_PROJECTS.map((project) => `project-item-${project.id}`)
  },
  workspace: { kind: 'steps', name: 'workspace', seed: seedWorkspace }
} satisfies Record<string, Scenario>
