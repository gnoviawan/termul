import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  registerTerminal,
  unregisterTerminal,
  getTerminal,
  extractScrollback,
  restoreScrollback,
  getRegistrySize,
  clearRegistry
} from './terminal-registry'

// Mock xterm Terminal
const createMockTerminal = (lines: string[] = []) => {
  const mockBuffer = {
    length: lines.length,
    getLine: (index: number) =>
      index < lines.length ? { translateToString: () => lines[index] } : null
  }

  return {
    buffer: {
      active: mockBuffer
    },
    write: vi.fn()
  } as unknown as import('@xterm/xterm').Terminal
}

describe('terminal-registry', () => {
  beforeEach(() => {
    clearRegistry()
  })

  describe('registerTerminal / unregisterTerminal', () => {
    it('should register and retrieve a terminal', () => {
      const terminal = createMockTerminal()
      registerTerminal('term-1', terminal)

      expect(getTerminal('term-1')).toBe(terminal)
      expect(getRegistrySize()).toBe(1)
    })

    it('should unregister a terminal', () => {
      const terminal = createMockTerminal()
      registerTerminal('term-1', terminal)
      unregisterTerminal('term-1')

      expect(getTerminal('term-1')).toBeUndefined()
      expect(getRegistrySize()).toBe(0)
    })

    it('should handle multiple terminals', () => {
      const terminal1 = createMockTerminal()
      const terminal2 = createMockTerminal()

      registerTerminal('term-1', terminal1)
      registerTerminal('term-2', terminal2)

      expect(getRegistrySize()).toBe(2)
      expect(getTerminal('term-1')).toBe(terminal1)
      expect(getTerminal('term-2')).toBe(terminal2)
    })
  })

  describe('extractScrollback', () => {
    it('should return undefined for unregistered terminal', () => {
      expect(extractScrollback('nonexistent')).toBeUndefined()
    })

    it('should extract lines from terminal buffer', () => {
      const lines = ['line 1', 'line 2', 'line 3']
      const terminal = createMockTerminal(lines)
      registerTerminal('term-1', terminal)

      const scrollback = extractScrollback('term-1')

      expect(scrollback).toEqual(['line 1', 'line 2', 'line 3'])
    })

    it('should trim trailing empty lines', () => {
      const lines = ['line 1', 'line 2', '', '  ', '']
      const terminal = createMockTerminal(lines)
      registerTerminal('term-1', terminal)

      const scrollback = extractScrollback('term-1')

      expect(scrollback).toEqual(['line 1', 'line 2'])
    })

    it('should return undefined for empty buffer', () => {
      const terminal = createMockTerminal([])
      registerTerminal('term-1', terminal)

      expect(extractScrollback('term-1')).toBeUndefined()
    })

    it('should respect maxLines limit', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
      const terminal = createMockTerminal(lines)
      registerTerminal('term-1', terminal)

      const scrollback = extractScrollback('term-1', 10)

      expect(scrollback?.length).toBe(10)
      expect(scrollback?.[0]).toBe('line 91')
      expect(scrollback?.[9]).toBe('line 100')
    })
  })

  describe('restoreScrollback', () => {
    it('should write scrollback content to terminal', () => {
      const terminal = createMockTerminal()
      const scrollback = ['line 1', 'line 2', 'line 3']

      restoreScrollback(terminal, scrollback)

      expect(terminal.write).toHaveBeenCalledWith('line 1\r\nline 2\r\nline 3\r\n')
    })

    it('should not write if scrollback is empty', () => {
      const terminal = createMockTerminal()

      restoreScrollback(terminal, [])

      expect(terminal.write).not.toHaveBeenCalled()
    })

    it('should handle undefined scrollback', () => {
      const terminal = createMockTerminal()

      restoreScrollback(terminal, undefined as unknown as string[])

      expect(terminal.write).not.toHaveBeenCalled()
    })
  })
})
