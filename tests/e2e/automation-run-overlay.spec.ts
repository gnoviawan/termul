import { randomUUID } from 'node:crypto'
import type { Locator, Page, TestInfo } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { AUTH, freshAutomation, signIn } from './automation-helpers'
import { E2E_BASE_URL } from './helpers'

/**
 * Automation run overlay (#1591, PR6) on the browser build: a real run of a
 * two-step automation (a transform, then a fail step) finishes in well under
 * a second, and the run view draws it on the canvas: each card's status, the
 * step list, the stop reason, and the transform's output in the inspector.
 *
 * Each test sets the graph up through the HTTP API, approves it, runs it and
 * waits for the run to settle, then opens it from the automation's run list.
 */

test.setTimeout(120_000)

type Unwrapped<T> = { data?: T } & T

async function api<T>(method: 'get' | 'post', path: string, data?: unknown): Promise<T> {
  const ctx = await request.newContext()
  try {
    const res = await ctx[method](`${E2E_BASE_URL}${path}`, { headers: AUTH, data })
    expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true)
    const body = (await res.json()) as Unwrapped<T>
    return body.data ?? body
  } finally {
    await ctx.dispose()
  }
}

/** Shape (transform) then Stop (fail), approved and run once; resolves when the run settled. */
async function finishedRun(name: string): Promise<void> {
  const { id } = await freshAutomation(name)
  const head = await api<{ automation: { revision: number } }>('get', `/api/automations/${id}`)
  const saved = await api<{ automation: { revision: number } }>(
    'post',
    `/api/automations/${id}/ops`,
    {
      base_revision: head.automation.revision,
      ops: [
        {
          op: 'add_node',
          node: {
            id: 'shape',
            label: 'Shape',
            spec: {
              kind: 'transform',
              fields: [{ name: 'greeting', value: 'hello {{trigger.kind}}' }]
            }
          }
        },
        {
          op: 'add_node',
          node: { id: 'stop', label: 'Stop', spec: { kind: 'fail', message: 'Stopped on purpose' } }
        },
        { op: 'connect', edge: { from: 'trigger', port: 'out', to: 'shape' } },
        { op: 'connect', edge: { from: 'shape', port: 'out', to: 'stop' } }
      ]
    }
  )
  await api('post', `/api/automations/${id}/approve`, { revision: saved.automation.revision })
  await api('post', `/api/automations/${id}/run`)
  await expect
    .poll(
      async () =>
        (await api<{ status: string }[]>('get', `/api/automations/${id}/runs`))[0]?.status,
      { timeout: 30_000 }
    )
    .toBe('failed')
}

function card(scope: Page | Locator, id: string): Locator {
  return scope.locator(`.react-flow__node[data-id="${id}"]`)
}

async function expectCardStatus(scope: Locator, id: string, status: string): Promise<void> {
  await expect(card(scope, id).getByTestId('card-status')).toHaveAttribute('title', status)
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(name) })
}

async function expectFinishedRun(view: Locator): Promise<void> {
  await expect(view.getByRole('heading', { level: 3, name: 'Failed' })).toBeVisible()
  await expect(view.getByText('Stopped on purpose').first()).toBeVisible()
  await expectCardStatus(view, 'trigger', 'Succeeded')
  await expectCardStatus(view, 'shape', 'Succeeded')
  await expectCardStatus(view, 'stop', 'Failed')
  // The run opens with the failed step in view.
  await expect(card(view, 'stop')).toBeInViewport({ ratio: 0.99 })
  const rows = view.getByRole('list', { name: 'Steps' }).getByRole('button')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toHaveAccessibleName('Manual, Trigger, Succeeded')
  await expect(rows.nth(1)).toHaveAccessibleName(/^Shape, Transform, Succeeded, \d+ ms$/)
  await expect(rows.nth(2)).toHaveAccessibleName(/^Stop, Fail, Failed, \d+ ms$/)
  await expect(view.getByRole('button', { name: 'Cancel run' })).toHaveCount(0)
}

test.describe('desktop browser', () => {
  test('opens a finished run on the canvas with statuses and the step output', async ({
    page
  }, info) => {
    const name = `Run desktop ${randomUUID().slice(0, 4)}`
    await finishedRun(name)
    await signIn(page)
    await page.getByRole('button', { name: 'Automations' }).first().click()
    await page.getByRole('button', { name: new RegExp(name) }).click()
    await page.getByRole('button', { name: /^Failed/ }).click()

    const view = page.getByTestId('automation-run')
    await expectFinishedRun(view)
    await shot(page, info, 'run-desktop.png')

    await view.getByRole('button', { name: /^Shape,/ }).click()
    const inspector = view.getByTestId('automation-inspector')
    await expect(inspector.getByTestId('inspector-status')).toHaveText('Succeeded')
    await expect(inspector.getByRole('region', { name: 'Output' })).toContainText(
      '"greeting": "hello manual"'
    )
    await card(view, 'stop').click()
    await expect(inspector.getByText('Stopped on purpose')).toBeVisible()
    await shot(page, info, 'run-desktop-inspector.png')

    await view.getByRole('button', { name: 'Back to the automation' }).click()
    await expect(page.getByTestId('automation-run')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Failed/ })).toBeVisible()
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

  test('shows the same run with the step list, and the inspector as a sheet', async ({
    page
  }, info) => {
    const name = `Run phone ${randomUUID().slice(0, 4)}`
    await finishedRun(name)
    await signIn(page)
    await page.getByRole('button', { name: 'Open menu' }).tap()
    await page
      .getByRole('dialog', { name: 'Troupe', exact: true })
      .getByRole('button', { name: 'Automations' })
      .tap()
    await page.getByRole('button', { name: new RegExp(name) }).tap()
    await page.getByRole('button', { name: /^Failed/ }).tap()

    const view = page.getByTestId('automation-run')
    await expectFinishedRun(view)
    await shot(page, info, 'run-phone.png')

    await view.getByRole('button', { name: /^Shape,/ }).tap()
    const inspector = view.getByTestId('automation-inspector')
    await expect(inspector.getByRole('region', { name: 'Output' })).toContainText(
      '"greeting": "hello manual"'
    )
    // The sheet takes the step list's place.
    await expect(view.getByRole('list', { name: 'Steps' })).toHaveCount(0)
    await shot(page, info, 'run-phone-inspector.png')
  })
})
