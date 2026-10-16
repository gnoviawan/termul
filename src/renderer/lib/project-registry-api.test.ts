import { beforeEach, describe, expect, it, vi } from 'vitest'

const { transport } = vi.hoisted(() => ({
  transport: {
    addProject: vi.fn(),
    updateProject: vi.fn(),
    removeProject: vi.fn(),
    setDefaultProject: vi.fn()
  }
}))

vi.mock('@/lib/acp-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/acp-transport')>()),
  getAcpTransport: () => transport
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

import { AcpTransportError } from '@/lib/acp-transport'
import { ProjectBusyError, projectRegistryApi } from './project-registry-api'

describe('projectRegistryApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const command of Object.values(transport)) command.mockResolvedValue(undefined)
  })

  describe('add', () => {
    it('mints a project id on the client when none is given', async () => {
      transport.addProject.mockImplementation(async (project) => ({ ...project, isDefault: false }))

      const added = await projectRegistryApi.add({ name: 'App', path: '/app', color: 'blue' })

      expect(added.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
      expect(transport.addProject).toHaveBeenCalledWith({
        id: added.id,
        name: 'App',
        path: '/app',
        color: 'blue'
      })
    })

    it('keeps an existing id verbatim', async () => {
      await projectRegistryApi.add({ id: 'my-api', name: 'API', path: '/api', color: 'red' })

      expect(transport.addProject).toHaveBeenCalledWith({
        id: 'my-api',
        name: 'API',
        path: '/api',
        color: 'red'
      })
    })
  })

  describe('cascade', () => {
    it('is never sent unless the caller asks for it', async () => {
      await projectRegistryApi.remove('p1')
      await projectRegistryApi.remove('p1', { cascade: false })
      await projectRegistryApi.archive('p1')

      expect(transport.removeProject).toHaveBeenNthCalledWith(1, 'p1', undefined)
      expect(transport.removeProject).toHaveBeenNthCalledWith(2, 'p1', undefined)
      expect(transport.updateProject).toHaveBeenCalledWith('p1', { isArchived: true })
    })

    it('is sent on a remove and an archive when the caller asks for it', async () => {
      await projectRegistryApi.remove('p1', { cascade: true })
      await projectRegistryApi.archive('p1', { cascade: true })

      expect(transport.removeProject).toHaveBeenCalledWith('p1', { cascade: true })
      expect(transport.updateProject).toHaveBeenCalledWith('p1', {
        isArchived: true,
        cascade: true
      })
    })
  })

  it('restores, renames and sets the default through the transport', async () => {
    await projectRegistryApi.restore('p1')
    await projectRegistryApi.update('p1', { name: 'New', color: 'green' })
    await projectRegistryApi.setDefault('p2')

    expect(transport.updateProject).toHaveBeenCalledWith('p1', { isArchived: false })
    expect(transport.updateProject).toHaveBeenCalledWith('p1', { name: 'New', color: 'green' })
    expect(transport.setDefaultProject).toHaveBeenCalledWith('p2')
  })

  it('moves a root, sending cascade only after the caller asks for it', async () => {
    await projectRegistryApi.update('p1', { path: '/new/root' })
    await projectRegistryApi.update('p1', { path: '/new/root' }, { cascade: true })

    expect(transport.updateProject).toHaveBeenNthCalledWith(1, 'p1', { path: '/new/root' })
    expect(transport.updateProject).toHaveBeenNthCalledWith(2, 'p1', {
      path: '/new/root',
      cascade: true
    })
  })

  describe('project_busy', () => {
    it('becomes a ProjectBusyError carrying the bound sessions and terminals', async () => {
      transport.removeProject.mockRejectedValueOnce(
        new AcpTransportError('project_busy', 'busy', undefined, {
          sessions: ['s1', 's2'],
          terminals: ['t1']
        })
      )

      const refusal = await projectRegistryApi.remove('p1').catch((error: unknown) => error)

      expect(refusal).toBeInstanceOf(ProjectBusyError)
      expect(refusal).toMatchObject({ projectId: 'p1', sessions: ['s1', 's2'], terminals: ['t1'] })
    })

    it('maps an archive refusal the same way, with empty lists when the host sent none', async () => {
      transport.updateProject.mockRejectedValueOnce(new AcpTransportError('project_busy', 'busy'))

      const refusal = await projectRegistryApi.archive('p9').catch((error: unknown) => error)

      expect(refusal).toBeInstanceOf(ProjectBusyError)
      expect(refusal).toMatchObject({ projectId: 'p9', sessions: [], terminals: [] })
    })

    it('leaves every other failure untouched', async () => {
      const failure = new AcpTransportError('duplicate', 'same id, different path')
      transport.addProject.mockRejectedValueOnce(failure)

      await expect(
        projectRegistryApi.add({ id: 'p1', name: 'A', path: '/other', color: 'blue' })
      ).rejects.toBe(failure)
    })
  })
})
