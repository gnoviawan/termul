import { defineConfig, devices } from 'playwright/test'

/**
 * Real-browser smoke for the design-system canvas (`design-system/`).
 *
 * Run it with `bun run test:smoke:canvas`. It starts its own Vite dev server for
 * the canvas, so nothing needs to be built first. Install the browser once
 * with `bun run playwright install chromium`.
 *
 * The port defaults to 5198 so it never collides with a `bun run design:dev`
 * on 5199. Override it with CANVAS_SMOKE_PORT. The server is never reused: a
 * busy port fails the run instead of testing someone else's checkout.
 */
const port = Number(process.env.CANVAS_SMOKE_PORT ?? 5198)
const baseURL = `http://localhost:${port}`

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 }
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
    }
  ],
  webServer: {
    command: `bun run design:dev --port ${port} --strictPort`,
    cwd: '../..',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe'
  },
  outputDir: './.playwright-out'
})
