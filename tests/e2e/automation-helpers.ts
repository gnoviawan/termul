import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright/test'
import { expect, request } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, storeKey, wsRequest } from './helpers'

/** Shared by the automation canvas specs: an empty automation in a fresh project, and sign-in. */

export const AUTH = { Authorization: `Bearer ${E2E_TOKEN}`, 'content-type': 'application/json' }

/** Registers a project, creates an empty automation in it, and makes it the active project. */
export async function freshAutomation(name: string): Promise<{ projectId: string; id: string }> {
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

export async function signIn(page: Page): Promise<void> {
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN,
    { timeout: 60_000 }
  )
  await page.goto(`${E2E_BASE_URL}/#/`)
}
