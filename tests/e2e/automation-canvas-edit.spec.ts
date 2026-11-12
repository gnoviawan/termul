import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page, TestInfo } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, storeKey, wsRequest } from './helpers'

/**
 * Automation canvas editor (#1591, PR3) on the browser build: build a
 * three-step automation on the canvas (add steps, connect them, save), reload,
 * and find it again. The desktop run chains steps with the dangling "+",
 * drags one in from the add menu and connects by dragging a port. The phone
 * run does the same through the bottom sheet and tap-to-connect.
 *
 * Each test registers its own project and creates an empty automation through
 * the HTTP API; the canvas does the rest.
 */

test.setTimeout(120_000)

const AUTH = { Authorization: `Bearer ${E2E_TOKEN}`, 'content-type': 'application/json' }

type Saved = {
  automation: {
    revision: number
    graph: { nodes: { id: string; spec: { kind: string } }[]; edges: unknown[] }
    layout: Record<string, unknown>
  }
}

async function freshAutomation(name: string): Promise<{ projectId: string; id: string }> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const project = `proj-canvas-${randomUUID().slice(0, 8)}`
  const projectId = `e2e-${project}`
  await mkdir(join(root, project), { recursive: true })
  const api = await request.newContext()
  try {
    const registered = await api.post(`${E2E_BASE_URL}/projects`, {
      headers: AUTH,
      data: { id: projectId, name: project, path: join(root, project), color: 'blue' }
    })
    expect(registered.ok(), `project registration: ${registered.status()}`).toBe(true)
    const created = await api.post(`${E2E_BASE_URL}/api/automations`, {
      headers: AUTH,
      data: { project_id: projectId, name }
    })
    expect(created.ok(), `automation create: ${created.status()}`).toBe(true)
    const body = (await created.json()) as { data?: { id: string }; id?: string }
    const id = body.data?.id ?? body.id
    if (!id) throw new Error(`no automation id in ${JSON.stringify(body)}`)
    await wsRequest(E2E_BASE_URL, 'store_write', {
      key: storeKey('active-project'),
      value: { _version: 1, data: projectId }
    })
    return { projectId, id }
  } finally {
    await api.dispose()
  }
}

async function fetchAutomation(id: string): Promise<Saved> {
  const api = await request.newContext()
  try {
    const res = await api.get(`${E2E_BASE_URL}/api/automations/${id}`, { headers: AUTH })
    expect(res.ok()).toBe(true)
    const body = (await res.json()) as { data?: Saved } & Saved
    return body.data ?? body
  } finally {
    await api.dispose()
  }
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN,
    { timeout: 60_000 }
  )
  await page.goto(`${E2E_BASE_URL}/#/`)
}

function card(scope: Page | Locator, id: string): Locator {
  return scope.locator(`.react-flow__node[data-id="${id}"]`)
}

function handle(scope: Page | Locator, node: string, port: string): Locator {
  return scope.locator(`.react-flow__handle[data-nodeid="${node}"][data-handleid="${port}"]`)
}

/** `locator`'s box once two reads 300 ms apart agree: the canvas has stopped animating. */
async function settledBox(page: Page, locator: Locator) {
  let box = await locator.boundingBox()
  await expect
    .poll(async () => {
      const before = await locator.boundingBox()
      await page.waitForTimeout(300)
      box = await locator.boundingBox()
      return JSON.stringify(before) === JSON.stringify(box)
    })
    .toBe(true)
  return box
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(name) })
}

/** The saved graph: trigger → HTTP → Transform → Wait. */
async function expectSavedChain(id: string): Promise<void> {
  const saved = await fetchAutomation(id)
  expect(saved.automation.graph.nodes.map((node) => node.id).sort()).toEqual([
    'http',
    'transform',
    'wait'
  ])
  expect(saved.automation.graph.edges).toEqual([
    { from: 'trigger', port: 'out', to: 'http' },
    { from: 'http', port: 'out', to: 'transform' },
    { from: 'transform', port: 'out', to: 'wait' }
  ])
  expect(Object.keys(saved.automation.layout)).toEqual(
    expect.arrayContaining(['trigger', 'http', 'transform', 'wait'])
  )
}

test.describe('desktop browser', () => {
  test('builds a three-step automation, saves it, and finds it after a reload', async ({
    page
  }, info) => {
    const name = `Canvas desktop ${randomUUID().slice(0, 4)}`
    const { id } = await freshAutomation(name)
    await signIn(page)
    await page.getByRole('button', { name: 'Automations' }).first().click()
    await page.getByRole('button', { name: new RegExp(name) }).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()

    const editor = page.getByTestId('automation-editor')
    const menu = page.getByRole('dialog', { name: 'Add a step' })
    const status = editor.getByTestId('draft-status')

    await editor.getByRole('button', { name: 'Add a step after the trigger' }).click()
    await menu.getByRole('button', { name: 'HTTP' }).click()
    await expect(card(editor, 'http')).toBeVisible()

    await editor.getByRole('button', { name: 'Add a step after HTTP' }).click()
    await expect(menu).toBeVisible()
    await shot(page, info, '02-add-menu.png')
    await menu.getByRole('button', { name: 'Transform' }).click()
    await expect(card(editor, 'transform')).toBeVisible()

    // The menu rows are the palette: drag Wait in below Transform.
    await editor.getByRole('button', { name: 'Add a step', exact: true }).click()
    const canvas = editor.getByRole('group', { name: 'Automation canvas' })
    const area = await canvas.boundingBox()
    if (!area) throw new Error('the canvas is not on screen')
    // A spot of blank canvas, clear of every card and the open menu.
    const spot = await page.evaluate(({ x, y, width, height }) => {
      for (let dy = 80; dy < height - 120; dy += 40) {
        for (let dx = 80; dx < width - 200; dx += 40) {
          const clear = [-110, 0, 110].every((ox) =>
            [-50, 0, 50].every((oy) =>
              document
                .elementFromPoint(x + dx + ox, y + dy + oy)
                ?.classList.contains('react-flow__pane')
            )
          )
          if (clear) return { x: dx, y: dy }
        }
      }
      return null
    }, area)
    if (!spot) throw new Error('no blank canvas to drop on')
    await menu.getByRole('button', { name: 'Wait' }).dragTo(canvas, { targetPosition: spot })
    await expect(menu).toBeHidden()
    await expect(card(editor, 'wait')).toBeVisible()
    await expect(status).toHaveText('Draft · 3 unsaved changes')

    // Connect Transform → Wait by dragging the port.
    // A port near the canvas edge would auto-pan the canvas under the drag: fit everything first.
    await settledBox(page, card(editor, 'wait'))
    await editor.getByRole('button', { name: 'Fit to view' }).click()
    // The canvas animates there; read the ports once they stop moving.
    const from = await settledBox(page, handle(editor, 'transform', 'out'))
    const to = await settledBox(page, handle(editor, 'wait', 'in'))
    if (!from || !to) throw new Error('ports are not on screen')
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move((from.x + to.x) / 2 + 30, (from.y + to.y) / 2, { steps: 8 })
    await expect(editor.getByRole('status')).toContainText('Connecting from Transform')
    await shot(page, info, '03-mid-connect.png')
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect(status).toHaveText('Draft · 4 unsaved changes')

    // The dry run flags the empty URL on its card.
    await card(editor, 'http').click()
    await expect(card(editor, 'http').getByTestId('card-issues')).toBeVisible()
    await shot(page, info, '01-editor.png')

    await editor.getByRole('button', { name: 'Save' }).click()
    await expect(status).toHaveText('No unsaved changes')
    await expectSavedChain(id)

    await page.reload()
    await page.getByRole('button', { name: 'Automations' }).first().click()
    await page.getByRole('button', { name: new RegExp(name) }).click()
    const steps = page.getByRole('list', { name: 'Automation steps' })
    await expect(steps).toContainText('Trigger: Run manually. Next: HTTP')
    await expect(steps).toContainText('HTTP, HTTP')
    await expect(steps).toContainText('Next: Transform')
    await expect(steps).toContainText('Next: Wait')
  })
})

test.describe('phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
  })

  test('builds the same automation with the add sheet and tap-to-connect', async ({
    page
  }, info) => {
    const name = `Canvas phone ${randomUUID().slice(0, 4)}`
    const { id } = await freshAutomation(name)
    await signIn(page)
    await page.getByRole('button', { name: 'Open menu' }).tap()
    await page
      .getByRole('dialog', { name: 'Troupe', exact: true })
      .getByRole('button', { name: 'Automations' })
      .tap()
    await page.getByRole('button', { name: new RegExp(name) }).tap()
    await page.getByRole('button', { name: 'Edit', exact: true }).tap()

    const editor = page.getByTestId('automation-editor')
    const sheet = page.getByRole('dialog', { name: 'Add a step' })
    const status = editor.getByTestId('draft-status')

    await editor.getByRole('button', { name: 'Add a step after the trigger' }).tap()
    await sheet.getByRole('button', { name: 'HTTP' }).tap()
    await expect(card(editor, 'http')).toBeVisible()
    await expect(sheet).toBeHidden()

    await editor.getByRole('button', { name: 'Add a step after HTTP' }).tap()
    await sheet.getByRole('button', { name: 'Transform' }).tap()
    await expect(sheet).toBeHidden()

    await editor.getByRole('button', { name: 'Add a step', exact: true }).tap()
    await expect(sheet).toBeVisible()
    await shot(page, info, '05-phone-add-sheet.png')
    await sheet.getByRole('button', { name: 'Wait' }).tap()
    await expect(sheet).toBeHidden()
    await expect(card(editor, 'wait')).toBeVisible()

    await handle(editor, 'transform', 'out').tap()
    const banner = editor.getByRole('status')
    await expect(banner).toContainText('Tap a node to connect')
    await expect(banner).toContainText('from Transform')
    await shot(page, info, '04-phone-connect-banner.png')
    await card(editor, 'wait').getByText('Wait', { exact: true }).first().tap()
    await expect(banner).toBeHidden()
    await expect(status).toHaveText('4 unsaved')

    await editor.getByRole('button', { name: 'Save' }).tap()
    await expect(status).toHaveText('No unsaved changes')
    await expectSavedChain(id)

    await page.reload()
    await page.getByRole('button', { name: 'Open menu' }).tap()
    await page
      .getByRole('dialog', { name: 'Troupe', exact: true })
      .getByRole('button', { name: 'Automations' })
      .tap()
    await page.getByRole('button', { name: new RegExp(name) }).tap()
    await expect(page.getByRole('list', { name: 'Automation steps' })).toContainText('Next: Wait')
  })
})
