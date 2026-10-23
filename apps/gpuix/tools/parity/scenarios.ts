/**
 * Parity scenarios: one seeded server state and the test ids that must be
 * painted before either client is shot. The web client marks elements with
 * `data-testid`, the GPUIX client with `testId`; a scenario names the ids both
 * share.
 */

import path from 'node:path'
import { addProject, type TestServer } from './server'

export interface Scenario {
  name: string
  seed(server: TestServer): Promise<void>
  /** Test ids present in both clients once the state is on screen. */
  readyTestIds: string[]
}

export const SEEDED_PROJECTS = [
  { id: 'parity-alpha', name: 'alpha' },
  { id: 'parity-beta', name: 'beta' }
] as const

export const SCENARIOS: Record<string, Scenario> = {
  projects: {
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
  }
}
