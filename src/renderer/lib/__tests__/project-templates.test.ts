import { describe, expect, it, vi } from 'vitest'
import { filesystemApi } from '../api'
import { BUILT_IN_TEMPLATES, scaffoldProject } from '../project-templates'

vi.mock('../api', () => {
  return {
    filesystemApi: {
      createDirectory: vi.fn(),
      createFile: vi.fn()
    }
  }
})

describe('Project Templates Scaffolding', () => {
  it('defines the correct set of built-in templates', () => {
    const ids = BUILT_IN_TEMPLATES.map((t) => t.id)
    expect(ids).toContain('empty')
    expect(ids).toContain('node')
    expect(ids).toContain('rust')
    expect(ids).toContain('react')
    expect(ids).toContain('python')
  })

  it('scaffolds empty template by just creating the directory', async () => {
    const mockCreateDir = vi.mocked(filesystemApi.createDirectory)
    mockCreateDir.mockResolvedValueOnce({ success: true, data: undefined })

    const emptyTemplate = BUILT_IN_TEMPLATES.find((t) => t.id === 'empty')!
    const result = await scaffoldProject('/test/path', 'My Project', emptyTemplate)

    expect(result.success).toBe(true)
    expect(mockCreateDir).toHaveBeenCalledWith('/test/path')
    expect(filesystemApi.createFile).not.toHaveBeenCalled()
  })

  it('interpolates project name and creates directories and files for Node.js template', async () => {
    const mockCreateDir = vi.mocked(filesystemApi.createDirectory)
    const mockCreateFile = vi.mocked(filesystemApi.createFile)

    mockCreateDir.mockResolvedValue({ success: true, data: undefined })
    mockCreateFile.mockResolvedValue({ success: true, data: undefined })

    const nodeTemplate = BUILT_IN_TEMPLATES.find((t) => t.id === 'node')!
    const result = await scaffoldProject('/test/path', 'My Node Project', nodeTemplate)

    expect(result.success).toBe(true)
    // Should create base directory + subdirectories
    expect(mockCreateDir).toHaveBeenCalledWith('/test/path')
    expect(mockCreateDir).toHaveBeenCalledWith('/test/path/src')

    // Should create the defined files with interpolated name
    expect(mockCreateFile).toHaveBeenCalledWith(
      '/test/path/package.json',
      expect.stringContaining('"name": "my-node-project"')
    )
    expect(mockCreateFile).toHaveBeenCalledWith('/test/path/src/index.js', expect.any(String))
    expect(mockCreateFile).toHaveBeenCalledWith('/test/path/.gitignore', expect.any(String))
  })

  it('returns failure if directory creation fails', async () => {
    const mockCreateDir = vi.mocked(filesystemApi.createDirectory)
    mockCreateDir.mockResolvedValueOnce({
      success: false,
      error: 'Permission denied',
      code: 'PERMISSION_ERROR'
    })

    const nodeTemplate = BUILT_IN_TEMPLATES.find((t) => t.id === 'node')!
    const result = await scaffoldProject('/test/path', 'test', nodeTemplate)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Failed to create base directory')
    } else {
      expect.fail('Expected scaffolding to fail')
    }
  })
})
