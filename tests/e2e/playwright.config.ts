import { defineConfig, devices } from 'playwright/test'

/**
 * E2E tests for the termul-server web client (long-running agent survival
 * across chat close, tab switch, project switch, and browser reload).
 *
 * Requires from the environment (the global-setup enforces these):
 * - A freshly built `dist-web/` (bun run build:web).
 * - A release `termul-server` binary at src-tauri/target/release/termul-server
 *   (cargo build --release --bin termul-server --features standalone-server).
 *
 * The suite is NOT self-starting: global-setup spawns one isolated server
 * (loopback, throwaway state dir) and seeds a deterministic fake ACP agent
 * that streams `agent_message_chunk` updates at ~1/s for DURATION_SEC —
 * long-running chats without a network LLM.
 *
 * Retries stay 0 even in CI: every spec shares ONE live server + workspace
 * and the fake-agent sessions persist per project for the whole run, so a
 * retried test would re-enter state its first attempt created (reopening a
 * chat that already streamed, double-launching prompts). Flakiness must be
 * fixed deterministically, not retried away.
 */
const port = Number(process.env.E2E_PORT ?? 8188)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  globalSetup: './global-setup',
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // One worker: a single shared termul-server instance holds all live
  // sessions; parallel browser contexts are created inside tests where the
  // scenario needs them (tab switching), the rest stays sequential.
  workers: 1,
  reporter: [['list']],
  // Chat turns stream for tens of seconds — transcript assertions need the
  // headroom (default expect timeout is 5s).
  expect: { timeout: 30_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    actionTimeout: 15_000
  },
  projects: [
    {
      name: 'chromium',
      // Project-level `use` merges per property over the top-level `use`,
      // and device descriptors carry their own viewport — strip it so the
      // 1440x900 viewport above actually applies.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
    }
  ],
  outputDir: './.playwright-out'
})
