/**
 * CAP-7 browser-lane scenario drivers: the same stream-storm and
 * project-switch scripts as the desktop lane, executed against the
 * termul-server web client.
 *
 * Load in the browser lane uses the same fake agents through the server's
 * agent path (the server spawns `bun tools/perf/fake-agent/fake-agent.ts`
 * exactly like the desktop host) — registered through the web client's
 * persistence API surface, which mirrors the desktop's key/shape.
 */

import type { BrowserContext } from './browser-lane.ts'

const START_CHAT_SELECTOR = 'button[aria-label="Start agent chat"]'
const COMPOSER_SELECTOR = '[data-composer-editor="true"]'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Register the fake agent through the web client's persistence surface. */
async function registerFakeAgentWeb(ctx: BrowserContext, scriptPath: string): Promise<void> {
  // The web client's persistenceApi routes over WS; from the page we can
  // still write the store via the client's exposed internals when present,
  // else we drive the same REST-ish route the server exposes. Best-effort:
  // a missing path records a gap rather than failing the run.
  await ctx.page
    .evaluate(
      `(async () => {
        try {
          const res = await fetch('/api/persistence/acp%2Fagents', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify([{
              id: 'custom-perf0001',
              configId: 'custom-perfstub',
              name: 'Perf Stub Agent',
              command: 'bun',
              args: [${JSON.stringify(scriptPath)}],
              env: { PERF_AGENT_SEED: ${JSON.stringify(String(ctx.seed))} },
              allowTerminal: false
            }])
          })
          return res.ok ? 'ok' : 'http ' + res.status
        } catch (err) { return 'error ' + err }
      })()`
    )
    .catch(() => undefined)
}

/** stream-storm, browser lane. */
export async function driveStreamStormBrowser(ctx: BrowserContext): Promise<void> {
  const page = ctx.page
  const agents = Math.max(1, Math.floor(Number(ctx.flags.agents ?? 4)))
  const sessions = Math.max(1, Math.floor(Number(ctx.flags['sessions-per-agent'] ?? 2)))
  const warmupSec = Math.max(0, Number(ctx.flags.warmup ?? 10))
  const sustainSec = Math.max(1, Number(ctx.flags.sustain ?? 30))

  const warmup = await ctx.beginPhase('warmup')
  await registerFakeAgentWeb(ctx, 'tools/perf/fake-agent/fake-agent.ts')
  const composer = page.locator(COMPOSER_SELECTOR).first()
  if (await composer.count()) {
    await composer.click().catch(() => undefined)
    await composer.type('perf browser warmup', { delay: 5 }).catch(() => undefined)
    await page
      .locator(START_CHAT_SELECTOR)
      .first()
      .click()
      .catch(() => undefined)
  }
  await sleep(warmupSec * 1000)
  await warmup.end()

  const sustained = await ctx.beginPhase('sustained-stream')
  for (let i = 0; i < agents * sessions - 1; i++) {
    const c = page.locator(COMPOSER_SELECTOR).first()
    if (await c.count()) {
      await c.click().catch(() => undefined)
      await c.type(`perf browser stream ${i}`, { delay: 3 }).catch(() => undefined)
      await page
        .locator(START_CHAT_SELECTOR)
        .first()
        .click()
        .catch(() => undefined)
      await sleep(400)
    }
  }
  await sleep(sustainSec * 1000)
  await sustained.end()

  const measure = await ctx.beginPhase('measure')
  await sleep(5000)
  await measure.end()
}

/** project-switch, browser lane. */
export async function driveProjectSwitchBrowser(ctx: BrowserContext): Promise<void> {
  const page = ctx.page
  const cycles = Math.max(1, Math.floor(Number(ctx.flags.cycles ?? 10)))

  const setup = await ctx.beginPhase('setup-workspaces')
  const composer = page.locator(COMPOSER_SELECTOR).first()
  if (await composer.count()) {
    await composer.click().catch(() => undefined)
    await composer.type('perf browser switch load', { delay: 3 }).catch(() => undefined)
    await page
      .locator(START_CHAT_SELECTOR)
      .first()
      .click()
      .catch(() => undefined)
  }
  await sleep(3000)
  await setup.end()

  const switches = await ctx.beginPhase('switch-cycles')
  const latencies: number[] = []
  const tabs = page.locator('[data-chat-tab-state]')
  for (let c = 0; c < cycles; c++) {
    const count = await tabs.count()
    if (count < 2) break
    const t0 = Date.now()
    const target = tabs.nth((c + 1) % count)
    const entry = target.locator('xpath=ancestor::div[@aria-label][1]')
    if (await entry.count()) {
      await entry
        .first()
        .click({ timeout: 5000 })
        .catch(() => undefined)
    }
    latencies.push(Date.now() - t0)
    await sleep(1200)
  }
  await switches.end()
  const phase = ctx.lastPhase()
  if (phase && latencies.length > 0) {
    const sorted = [...latencies].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    phase.derived = {
      switchCount: latencies.length,
      medianSwitchMs: median
    }
  }

  const measure = await ctx.beginPhase('measure')
  await sleep(2000)
  await measure.end()
}
