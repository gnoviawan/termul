/** Types shared by the Bun-typed scene entry and the app-typed scene boot. */

import type { ClientConfig } from '../../../src/client-config'

export interface SceneBox {
  x: number
  y: number
  width: number
}

export interface SceneStart {
  configId: string
  projectId: string
  cwd: string
}

export interface ComposerSceneOptions {
  start: SceneStart
  box: SceneBox
  onSession(sessionId: string): void
  onRenderer(renderer: { registerFont?(data: Uint8Array): void }): void
}

export type ComposerSceneBoot = (config: ClientConfig, options: ComposerSceneOptions) => void
