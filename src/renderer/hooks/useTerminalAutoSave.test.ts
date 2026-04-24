import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  serializeTerminalsForProject,
  setTerminalRestoreInProgress,
  isTerminalRestoreInProgress,
  syncScrollbackToStore,
  saveTerminalLayout
} from './useTerminalAutoSave'
import { extractScrollback } from '../utils/terminal-registry'
import { useTerminalStore } from '../stores/terminal-store'
import type { Terminal } from '@/types/project'
import type { PersistedTerminal } from '../../shared/types/persistence.types'

// Mock terminal-registry
vi.mock('../utils/terminal-registry', () => ({
  extractScrollback: vi.fn((terminalId: string) => {
    // Return mock scrollback for testing
    if (terminalId === '1' || terminalId === 'pty-1') return ['line 1', 'line 2']
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

  describe('setTerminalRestoreInProgress', () => {
    it('only clears restore state for the matching owner', () => {
      setTerminalRestoreInProgress('proj-1', true, 'owner-a')
      expect(isTerminalRestoreInProgress()).toBe(true)

      setTerminalRestoreInProgress('proj-1', false, 'owner-b')
      expect(isTerminalRestoreInProgress()).toBe(true)

      setTerminalRestoreInProgress('proj-1', false, 'owner-a')
      expect(isTerminalRestoreInProgress()).toBe(false)
    })
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
          ptyId: 'pty-1',
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
      expect(result.terminals[0].scrollback).toEqual(['line 1', 'line 2'])
    })

    it('should prefer ptyId when extracting scrollback', () => {
      const terminals: Terminal[] = [
        {
          id: '1',
          ptyId: 'pty-1',
          name: 'Terminal 1',
          projectId: 'proj-1',
          shell: 'powershell'
        }
      ]

      serializeTerminalsForProject(terminals, 'proj-1', '1')

      expect(extractScrollback).toHaveBeenCalledWith('pty-1')
    })

    it('should prefer transcript for serialized scrollback and persistence', () => {
      const terminals: Terminal[] = [
        {
          id: '1',
          ptyId: 'pty-1',
          name: 'Terminal 1',
          projectId: 'proj-1',
          shell: 'powershell',
          transcript: 'line 3\nline 4\n'
        }
      ]

      const result = serializeTerminalsForProject(terminals, 'proj-1', '1')

      expect(result.terminals[0].scrollback).toEqual(['line 3', 'line 4'])
      expect(result.terminals[0].transcript).toBe('line 3\nline 4\n')
    })
  })

  describe('syncScrollbackToStore', () => {
    beforeEach(() => {
      useTerminalStore.setState({
        terminals: [],
        activeTerminalId: '',
        ptyIdIndex: new Map()
      })
    })

    it('should update pendingScrollback in store for each terminal', () => {
      const store = useTerminalStore.getState()
      const terminal = store.addTerminal('Terminal 1', 'proj-1', 'bash')

      const persistedTerminals: PersistedTerminal[] = [
        {
          id: terminal.id,
          name: 'Terminal 1',
          shell: 'bash',
          scrollback: ['new scrollback line 1', 'new scrollback line 2']
        }
      ]

      syncScrollbackToStore(persistedTerminals)

      const updatedTerminal = useTerminalStore
        .getState()
        .terminals.find((t) => t.id === terminal.id)
      expect(updatedTerminal?.pendingScrollback).toEqual([
        'new scrollback line 1',
        'new scrollback line 2'
      ])
    })

    it('should skip terminals with undefined scrollback', () => {
      const store = useTerminalStore.getState()
      const terminal = store.addTerminal('Terminal 1', 'proj-1', 'bash', undefined, [
        'existing scrollback'
      ])

      const persistedTerminals: PersistedTerminal[] = [
        {
          id: terminal.id,
          name: 'Terminal 1',
          shell: 'bash',
          scrollback: undefined
        }
      ]

      syncScrollbackToStore(persistedTerminals)

      const updatedTerminal = useTerminalStore
        .getState()
        .terminals.find((t) => t.id === terminal.id)
      expect(updatedTerminal?.pendingScrollback).toEqual(['existing scrollback'])
    })

    it('should handle non-existent terminal ids gracefully', () => {
      const persistedTerminals: PersistedTerminal[] = [
        {
          id: 'non-existent-id',
          name: 'Ghost Terminal',
          shell: 'bash',
          scrollback: ['some lines']
        }
      ]

      expect(() => syncScrollbackToStore(persistedTerminals)).not.toThrow()
    })
  })

  describe('saveTerminalLayout', () => {
    beforeEach(() => {
      useTerminalStore.setState({
        terminals: [],
        activeTerminalId: '',
        ptyIdIndex: new Map()
      })
    })

    it('should sync scrollback to store before writing to disk', async () => {
      const store = useTerminalStore.getState()
      const terminal = store.addTerminal('Terminal 1', 'proj-1', 'bash')
      store.setTerminalPtyId(terminal.id, 'pty-1')

      await saveTerminalLayout('proj-1')

      const updatedTerminal = useTerminalStore
        .getState()
        .terminals.find((t) => t.id === terminal.id)
      expect(updatedTerminal?.pendingScrollback).toEqual(['line 1', 'line 2'])
    })
  })
})
