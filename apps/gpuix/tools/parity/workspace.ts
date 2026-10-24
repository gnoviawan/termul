/**
 * The `workspace` parity scenario: the real app shell in both clients, driven
 * through the same steps against one seeded server, shot full-frame and per
 * region after each step.
 *
 * A step's actions run in the web client first. A click on a labelled button
 * is replayed in GPUIX at the point where the web client painted that button,
 * so the click also checks that GPUIX put it in the same place. Regions are
 * measured in the web client and the same rectangles are cropped from both
 * frames.
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from 'playwright'
import { cropPng, type DiffResult, diffPngs, type Rect } from './diff'
import { addProject, type TestServer } from './server'
import { READY_TIMEOUT_MS, withGpuix } from './shoot-gpuix'

type GpuixApp = Parameters<Parameters<typeof withGpuix>[1]>[0]['app']

import { withWeb } from './shoot-web'

export type Action =
  | { kind: 'click-testid'; testId: string }
  | { kind: 'click-button'; label: string }
  | { kind: 'press'; key: 'Control+k' | 'Escape' }
  | { kind: 'gone'; text: string }

export interface Step {
  name: string
  actions: Action[]
  /** Texts both clients paint once the step's state is on screen (async data included). */
  ready: string[]
}

export interface Region {
  name: string
  /** Selector in the web client. */
  selector: string
}

/** Playwright key names -> GPUI keystrokes. */
const GPUI_KEYS: Record<Extract<Action, { kind: 'press' }>['key'], string> = {
  'Control+k': 'ctrl-k',
  Escape: 'escape'
}

export const WORKSPACE_PROJECTS = [
  { id: 'parity-alpha', name: 'alpha', git: true },
  { id: 'parity-beta', name: 'beta', git: false }
] as const

export const WORKSPACE_STEPS: Step[] = [
  { name: 'a-dashboard-alpha', actions: [], ready: ['What should we do in alpha?', 'main', '+3'] },
  {
    name: 'b-dashboard-beta',
    actions: [{ kind: 'click-testid', testId: 'project-item-parity-beta' }],
    ready: ['What should we do in beta?']
  },
  {
    name: 'c-settings',
    actions: [{ kind: 'click-button', label: 'Settings' }],
    ready: ['Interface zoom']
  },
  {
    name: 'd-command-palette',
    actions: [
      { kind: 'click-button', label: 'Close Preferences' },
      { kind: 'gone', text: 'Interface zoom' },
      { kind: 'press', key: 'Control+k' }
    ],
    ready: ['App Preferences']
  }
]

export const WORKSPACE_REGIONS: Region[] = [
  { name: 'rail', selector: '[data-testid="shell-rail"]' },
  { name: 'main', selector: '[data-testid="shell-row"] main' },
  { name: 'statusbar', selector: '[data-status-bar]' }
]

function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(
    ['git', '-c', 'user.name=parity', '-c', 'user.email=parity@example.invalid', ...args],
    {
      cwd,
      stdout: 'ignore',
      stderr: 'pipe'
    }
  )
  if (proc.exitCode !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
}

/** alpha is a git repo with one commit, a modified file and an untracked one; beta is a plain folder. */
export async function seedWorkspace(server: TestServer): Promise<void> {
  for (const project of WORKSPACE_PROJECTS) {
    const dir = path.join(server.stateDir, 'projects', project.name)
    await addProject(server, { id: project.id, name: project.name, path: dir, color: 'blue' })
    if (!project.git) continue
    await Bun.write(path.join(dir, 'README.md'), '# alpha\n')
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'initial')
    await Bun.write(path.join(dir, 'README.md'), '# alpha\n\nA changed line.\n')
    await Bun.write(path.join(dir, 'notes.txt'), 'untracked\n')
  }
}

async function webAction(page: Page, action: Action): Promise<Rect | null> {
  switch (action.kind) {
    case 'click-testid':
      await page.getByTestId(action.testId).first().click()
      return null
    case 'click-button': {
      const button = page.getByRole('button', { name: action.label, exact: true }).first()
      const box = await button.boundingBox()
      if (!box) throw new Error(`web: button "${action.label}" has no box`)
      await button.click()
      return box
    }
    case 'press':
      await page.keyboard.press(action.key)
      return null
    case 'gone':
      await page
        .getByText(action.text, { exact: true })
        .first()
        .waitFor({ state: 'hidden', timeout: READY_TIMEOUT_MS })
      return null
  }
}

/** Poll until `text` is painted (`present`) or gone. Any number of matches counts as painted. */
async function gpuixText(app: GpuixApp, text: string, present: boolean): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while ((await app.getByText(text).count()) > 0 !== present) {
    if (Date.now() > deadline)
      throw new Error(`gpuix: "${text}" ${present ? 'never painted' : 'still painted'}`)
    await Bun.sleep(100)
  }
}

async function regionRects(page: Page): Promise<Record<string, Rect | null>> {
  const out: Record<string, Rect | null> = {}
  for (const region of WORKSPACE_REGIONS) {
    out[region.name] = await page.locator(region.selector).first().boundingBox()
  }
  return out
}

export interface StepResult {
  step: string
  web: string
  gpuix: string
  full: DiffResult
  regions: { name: string; rect: Rect; diff: DiffResult; web: string; gpuix: string }[]
}

export interface WorkspaceRun {
  server: TestServer
  entry: string
  outDir: string
  clientStateDir: string
  width: number
  height: number
}

/** Drive both clients through {@link WORKSPACE_STEPS} and diff every frame and region. */
export async function runWorkspace(opts: WorkspaceRun): Promise<StepResult[]> {
  const size = { width: opts.width, height: opts.height }
  const clickPoints = new Map<string, Rect>()
  const rects = new Map<string, Record<string, Rect | null>>()
  const shot = (step: string, client: 'web' | 'gpuix') =>
    path.join(opts.outDir, step, `${client}.png`)
  for (const step of WORKSPACE_STEPS)
    await mkdir(path.join(opts.outDir, step.name), { recursive: true })

  await withWeb({ server: opts.server, ...size }, async ({ page, grab }) => {
    for (const step of WORKSPACE_STEPS) {
      for (const [i, action] of step.actions.entries()) {
        const box = await webAction(page, action)
        if (box) clickPoints.set(`${step.name}/${i}`, box)
      }
      for (const text of step.ready) {
        await page
          .getByText(text, { exact: true })
          .first()
          .waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS })
      }
      rects.set(step.name, await regionRects(page))
      await grab(shot(step.name, 'web'))
    }
  })

  await withGpuix(
    { server: opts.server, entry: opts.entry, clientStateDir: opts.clientStateDir, ...size },
    async ({ app, grab }) => {
      for (const step of WORKSPACE_STEPS) {
        for (const [i, action] of step.actions.entries()) {
          if (action.kind === 'click-testid') await app.getByTestId(action.testId).click()
          else if (action.kind === 'press')
            await app.call('keystrokes', { keys: GPUI_KEYS[action.key] })
          else if (action.kind === 'gone') await gpuixText(app, action.text, false)
          else {
            const box = clickPoints.get(`${step.name}/${i}`)
            if (!box) throw new Error(`no web position for "${action.label}"`)
            await app.mouse.click({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
          }
        }
        for (const text of step.ready) await gpuixText(app, text, true)
        await grab(shot(step.name, 'gpuix'))
      }
    }
  )

  return WORKSPACE_STEPS.map((step) => {
    const dir = path.join(opts.outDir, step.name)
    const web = shot(step.name, 'web')
    const gpuix = shot(step.name, 'gpuix')
    const full = diffPngs(web, gpuix, path.join(dir, 'diff.png'))
    const regions = WORKSPACE_REGIONS.flatMap((region) => {
      const rect = rects.get(step.name)?.[region.name]
      if (!rect) return []
      const files = Object.fromEntries(
        (['web', 'gpuix', 'diff'] as const).map((kind) => [
          kind,
          path.join(dir, `${region.name}-${kind}.png`)
        ])
      ) as Record<'web' | 'gpuix' | 'diff', string>
      cropPng(web, rect, files.web)
      cropPng(gpuix, rect, files.gpuix)
      return [
        {
          name: region.name,
          rect,
          diff: diffPngs(files.web, files.gpuix, files.diff),
          web: files.web,
          gpuix: files.gpuix
        }
      ]
    })
    return { step: step.name, web, gpuix, full, regions }
  })
}
