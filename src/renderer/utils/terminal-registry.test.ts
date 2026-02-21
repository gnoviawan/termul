import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  registerTerminal,
  unregisterTerminal,
  getTerminal,
  extractScrollback,
  restoreScrollback,
  getRegistrySize,
  clearRegistry,
  captureScrollPosition,
  getCachedScrollPosition,
  clearScrollPosition,
  restoreScrollPosition
} from './terminal-registry'

// Mock xterm Terminal
const createMockTerminal = (lines: string[] = [], viewportY: number = 0) => {
  const mockBuffer = {
    length: lines.length,
    getLine: (index: number) =>
      index < lines.length ? { translateToString: () => lines[index] } : null,
    viewportY
  }

  return {
    buffer: {
      active: mockBuffer
    },
    write: vi.fn(),
    scrollToLine: vi.fn()
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

  describe('scroll position management', () => {
    describe('captureScrollPosition', () => {
      it('should capture scroll position from registered terminal', () => {
        const terminal = createMockTerminal(['line 1', 'line 2'], 5)
        registerTerminal('term-1', terminal)

        captureScrollPosition('term-1')

        expect(getCachedScrollPosition('term-1')).toBe(5)
      })

      it('should do nothing for unregistered terminal', () => {
        captureScrollPosition('nonexistent')

        expect(getCachedScrollPosition('nonexistent')).toBeUndefined()
      })

      it('should handle terminal without buffer.active gracefully', () => {
        const terminal = { write: vi.fn() } as unknown as import('@xterm/xterm').Terminal
        registerTerminal('term-1', terminal)

        // Should not throw
        expect(() => captureScrollPosition('term-1')).not.toThrow()
        expect(getCachedScrollPosition('term-1')).toBeUndefined()
      })

      it('should update cached position on subsequent capture', () => {
        const terminal1 = createMockTerminal([], 10)
        registerTerminal('term-1', terminal1)

        captureScrollPosition('term-1')
        expect(getCachedScrollPosition('term-1')).toBe(10)

        // Simulate scroll and re-register with new position
        unregisterTerminal('term-1')
        const terminal2 = createMockTerminal([], 20)
        registerTerminal('term-1', terminal2)

        captureScrollPosition('term-1')
        expect(getCachedScrollPosition('term-1')).toBe(20)
      })
    })

    describe('getCachedScrollPosition', () => {
      it('should return undefined when no position cached', () => {
        expect(getCachedScrollPosition('nonexistent')).toBeUndefined()
      })

      it('should return cached position', () => {
        const terminal = createMockTerminal([], 15)
        registerTerminal('term-1', terminal)
        captureScrollPosition('term-1')

        expect(getCachedScrollPosition('term-1')).toBe(15)
      })
    })

    describe('clearScrollPosition', () => {
      it('should clear cached scroll position', () => {
        const terminal = createMockTerminal([], 10)
        registerTerminal('term-1', terminal)
        captureScrollPosition('term-1')

        clearScrollPosition('term-1')

        expect(getCachedScrollPosition('term-1')).toBeUndefined()
      })

      it('should handle clearing non-existent position', () => {
        expect(() => clearScrollPosition('nonexistent')).not.toThrow()
      })
    })

    describe('restoreScrollPosition', () => {
      it('should restore scroll position and clear cache', () => {
        const terminal = createMockTerminal([], 25)
        registerTerminal('term-1', terminal)
        captureScrollPosition('term-1')

        const result = restoreScrollPosition('term-1', terminal)

        expect(result).toBe(true)
        expect(terminal.scrollToLine).toHaveBeenCalledWith(25)
        expect(getCachedScrollPosition('term-1')).toBeUndefined()
      })

      it('should return false when no cached position', () => {
        const terminal = createMockTerminal()

        const result = restoreScrollPosition('term-1', terminal)

        expect(result).toBe(false)
        expect(terminal.scrollToLine).not.toHaveBeenCalled()
      })

      it('should handle terminal without scrollToLine', () => {
        const terminal = createMockTerminal([], 10)
        registerTerminal('term-1', terminal)
        captureScrollPosition('term-1')

        // Create terminal without scrollToLine
        const terminalWithoutScroll = { write: vi.fn() } as unknown as import('@xterm/xterm').Terminal
        const result = restoreScrollPosition('term-1', terminalWithoutScroll)

        expect(result).toBe(false)
      })

      it('should clear cache even if scrollToLine throws', () => {
        const terminal = createMockTerminal([], 10)
        ;(terminal.scrollToLine as ReturnType<typeof vi.fn>).mockImplementation(() => {
          throw new Error('Scroll error')
        })
        registerTerminal('term-1', terminal)
        captureScrollPosition('term-1')

        const result = restoreScrollPosition('term-1', terminal)

        expect(result).toBe(false)
        expect(getCachedScrollPosition('term-1')).toBeUndefined()
      })
    })

    describe('independent scroll states', () => {
      it('should maintain independent scroll positions for multiple terminals', () => {
        const terminal1 = createMockTerminal([], 10)
        const terminal2 = createMockTerminal([], 20)
        const terminal3 = createMockTerminal([], 30)

        registerTerminal('term-1', terminal1)
        registerTerminal('term-2', terminal2)
        registerTerminal('term-3', terminal3)

        captureScrollPosition('term-1')
        captureScrollPosition('term-2')
        captureScrollPosition('term-3')

        expect(getCachedScrollPosition('term-1')).toBe(10)
        expect(getCachedScrollPosition('term-2')).toBe(20)
        expect(getCachedScrollPosition('term-3')).toBe(30)

        // Restore one should not affect others
        restoreScrollPosition('term-2', terminal2)

        expect(getCachedScrollPosition('term-1')).toBe(10)
        expect(getCachedScrollPosition('term-2')).toBeUndefined()
        expect(getCachedScrollPosition('term-3')).toBe(30)
      })
    })
  })
})
