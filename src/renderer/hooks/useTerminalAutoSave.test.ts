import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { serializeTerminalsForProject } from './useTerminalAutoSave'
import type { Terminal } from '@/types/project'

// Mock terminal-registry
vi.mock('../utils/terminal-registry', () => ({
  extractScrollback: vi.fn((terminalId: string) => {
    // Return mock scrollback for testing
    if (terminalId === '1') return ['line 1', 'line 2']
    return undefined
  })
}))

// Mock window.api
const mockWriteDebounced = vi.fn().mockResolvedValue({ success: true })
const mockRead = vi.fn()
const mockWrite = vi.fn().mockResolvedValue({ success: true })

vi.stubGlobal('window', {
  api: {
    persistence: {
      read: mockRead,
      write: mockWrite,
      writeDebounced: mockWriteDebounced,
      delete: vi.fn()
    }
  }
})

describe('useTerminalAutoSave', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('serializeTerminalsForProject', () => {
    it('should serialize terminals for a specific project', () => {
      const terminals: Terminal[] = [
        { id: '1', name: 'Terminal 1', projectId: 'proj-1', shell: 'powershell', cwd: '/path/1' },
        { id: '2', name: 'Terminal 2', projectId: 'proj-1', shell: 'bash' },
        { id: '3', name: 'Terminal 3', projectId: 'proj-2', shell: 'zsh' }
      ]

      const result = serializeTerminalsForProject(terminals, 'proj-1', '1')

      expect(result.activeTerminalId).toBe('1')
      expect(result.terminals).toHaveLength(2)
      expect(result.terminals[0]).toEqual({
        id: '1',
        name: 'Terminal 1',
        shell: 'powershell',
        cwd: '/path/1',
        scrollback: ['line 1', 'line 2']
      })
      expect(result.terminals[1]).toEqual({
        id: '2',
        name: 'Terminal 2',
        shell: 'bash',
        cwd: undefined,
        scrollback: undefined
      })
      expect(result.updatedAt).toBeDefined()
    })

    it('should set activeTerminalId to null when active terminal not in project', () => {
      const terminals: Terminal[] = [
        { id: '1', name: 'Terminal 1', projectId: 'proj-1', shell: 'powershell' }
      ]

      const result = serializeTerminalsForProject(terminals, 'proj-1', 'non-existent')

      expect(result.activeTerminalId).toBeNull()
    })

    it('should return empty terminals array for non-existent project', () => {
      const terminals: Terminal[] = [
        { id: '1', name: 'Terminal 1', projectId: 'proj-1', shell: 'powershell' }
      ]

      const result = serializeTerminalsForProject(terminals, 'proj-999', '1')

      expect(result.terminals).toHaveLength(0)
      expect(result.activeTerminalId).toBeNull()
    })

    it('should include ISO timestamp in updatedAt', () => {
      const terminals: Terminal[] = []
      const before = new Date().toISOString()

      const result = serializeTerminalsForProject(terminals, 'proj-1', '')

      const after = new Date().toISOString()
      expect(result.updatedAt >= before).toBe(true)
      expect(result.updatedAt <= after).toBe(true)
    })

    it('should not include output field in serialized terminals but include scrollback', () => {
      const terminals: Terminal[] = [
        {
          id: '1',
          name: 'Terminal 1',
          projectId: 'proj-1',
          shell: 'powershell',
          output: [{ type: 'output', content: 'some output' }]
        }
      ]

      const result = serializeTerminalsForProject(terminals, 'proj-1', '1')

      expect(result.terminals[0]).not.toHaveProperty('output')
      expect(result.terminals[0]).not.toHaveProperty('projectId')
      expect(result.terminals[0]).not.toHaveProperty('isActive')
      // scrollback should be included from the registry
      expect(result.terminals[0].scrollback).toEqual(['line 1', 'line 2'])
    })
  })
})
