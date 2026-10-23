/** Seeded server + the composer scene under Xvfb, for the e2e and the parity shots. */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { APP_DIR } from '../../../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'
import {
  grabFrame,
  LAVAPIPE_ICD,
  SCREEN_MARGIN,
  startXvfb,
  windowOrigin
} from '../../parity/shoot-gpuix'
import type { ComposerServer } from '../seed'
import { buildScene } from './build'
import type { SceneBox } from './contract'

export type GpuixApp = Awaited<ReturnType<typeof launch>>

export interface SceneSession {
  app: GpuixApp
  sessionId: string
  grab(outPath: string): Promise<void>
}

export async function withScene<T>(
  seeded: ComposerServer,
  box: SceneBox,
  body: (scene: SceneSession) => Promise<T>
): Promise<T> {
  const entry = await buildScene()
  const base = path.dirname(seeded.promptLog)
  const sessionOut = path.join(base, 'scene-session.txt')
  const xvfb = await startXvfb(WINDOW_WIDTH + SCREEN_MARGIN, WINDOW_HEIGHT + SCREEN_MARGIN)
  try {
    const app = await launch({
      command: 'bun',
      args: [entry],
      cwd: APP_DIR,
      env: {
        ...process.env,
        DISPLAY: xvfb.display,
        VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
        GPUIX_BACKGROUND: '1',
        TERMUL_SERVER_URL: seeded.server.baseUrl,
        TERMUL_SERVER_TOKEN: seeded.server.token,
        TERMUL_GPUIX_STATE_DIR: path.join(base, 'client'),
        COMPOSER_START: `${seeded.agentConfigId}|${seeded.projectId}|${seeded.root}`,
        COMPOSER_BOX: `${box.x},${box.y},${box.width}`,
        COMPOSER_DEVICE: seeded.deviceId,
        COMPOSER_SESSION_OUT: sessionOut
      }
    })
    try {
      await app.getByTestId('composer-scene-ready').waitFor({ timeoutMs: 60_000 })
      const sessionId = existsSync(sessionOut) ? readFileSync(sessionOut, 'utf8') : ''
      return await body({
        app,
        sessionId,
        grab: async (outPath) => {
          await Bun.sleep(500)
          const origin = await windowOrigin(xvfb.display, WINDOW_WIDTH, WINDOW_HEIGHT)
          await grabFrame(xvfb.display, WINDOW_WIDTH, WINDOW_HEIGHT, outPath, origin)
        }
      })
    } finally {
      await app.close()
    }
  } finally {
    xvfb.stop()
  }
}
