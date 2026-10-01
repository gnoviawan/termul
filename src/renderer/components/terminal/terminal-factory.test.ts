import { describe, expect, it, vi } from 'vitest'

// Mock xterm and addon modules before importing the factory.
// The factory imports real constructors, so we mock them at the module level.
vi.mock('@xterm/xterm', () => {
  return {
    Terminal: class MockTerminal {
      options: Record<string, unknown>
      constructor(options: Record<string, unknown>) {
        this.options = options
      }
    }
  }
})

vi.mock('@xterm/addon-fit', () => {
  return {
    FitAddon: class MockFitAddon {
      fit() {}
      proposeDimensions() {
        return { cols: 80, rows: 24 }
      }
    }
  }
})

vi.mock('@xterm/addon-search', () => {
  return {
    SearchAddon: class MockSearchAddon {
      findNext() {
        return false
      }
      findPrevious() {
        return false
      }
      clearDecorations() {}
    }
  }
})

vi.mock('@xterm/addon-web-links', () => {
  return {
    WebLinksAddon: class MockWebLinksAddon {}
  }
})

vi.mock('@xterm/addon-webgl', () => {
  return {
    WebglAddon: class MockWebglAddon {}
  }
})

import type { RendererPreference } from './terminal-factory'
// Must import after mocks are set up
import { terminalFactory } from './terminal-factory'

describe('terminalFactory', () => {
  describe('createTerminal', () => {
    it('should create a Terminal instance with default options', () => {
      const terminal = terminalFactory.createTerminal()
      expect(terminal).toBeDefined()
      expect(terminal.options).toBeDefined()
      // Default options from terminal-config
      expect(terminal.options.cursorBlink).toBe(true)
      expect(terminal.options.cursorStyle).toBe('block')
      expect(terminal.options.scrollback).toBe(10000)
    })

    it('should allow overriding default options', () => {
      const terminal = terminalFactory.createTerminal({
        scrollback: 5000,
        fontSize: 18
      })
      expect(terminal.options.scrollback).toBe(5000)
      expect(terminal.options.fontSize).toBe(18)
      // Non-overridden defaults should still be present
      expect(terminal.options.cursorBlink).toBe(true)
    })
  })

  describe('createFitAddon', () => {
    it('should create a FitAddon instance', () => {
      const addon = terminalFactory.createFitAddon()
      expect(addon).toBeDefined()
      expect(typeof addon.fit).toBe('function')
      expect(typeof addon.proposeDimensions).toBe('function')
    })
  })

  describe('createSearchAddon', () => {
    it('should create a SearchAddon instance', () => {
      const addon = terminalFactory.createSearchAddon()
      expect(addon).toBeDefined()
      expect(typeof addon.findNext).toBe('function')
    })
  })

  describe('createWebLinksAddon', () => {
    it('should create a WebLinksAddon instance', () => {
      const addon = terminalFactory.createWebLinksAddon()
      expect(addon).toBeDefined()
    })
  })

  describe('createWebglAddon', () => {
    it('should create a WebglAddon instance', () => {
      const addon = terminalFactory.createWebglAddon()
      expect(addon).toBeDefined()
    })
  })

  describe('shouldUseWebglRenderer', () => {
    it.each([
      ['auto' as RendererPreference, true],
      ['webgl' as RendererPreference, true],
      ['dom' as RendererPreference, false]
    ])("should return %s for preference '%s'", (preference, expected) => {
      expect(terminalFactory.shouldUseWebglRenderer(preference)).toBe(expected)
    })

    it("should treat 'auto' as WebGL-eligible", () => {
      expect(terminalFactory.shouldUseWebglRenderer('auto')).toBe(true)
    })

    it("should treat 'dom' as WebGL-ineligible (skip WebGL)", () => {
      expect(terminalFactory.shouldUseWebglRenderer('dom')).toBe(false)
    })

    it("should treat 'webgl' as WebGL-eligible (force WebGL)", () => {
      expect(terminalFactory.shouldUseWebglRenderer('webgl')).toBe(true)
    })

    // Story 2 mobile web shell stopgap: the shipped 'auto' default resolves
    // to the DOM renderer on mobile (WebGL paints zero pixels at DPR >= 3);
    // explicit 'webgl' and 'dom' stay honored everywhere.
    it.each([
      ['auto' as RendererPreference, false],
      ['webgl' as RendererPreference, true],
      ['dom' as RendererPreference, false]
    ])("should return %s for preference '%s' on the mobile web shell", (preference, expected) => {
      expect(terminalFactory.shouldUseWebglRenderer(preference, true)).toBe(expected)
    })

    it("should resolve 'auto' to DOM on the mobile web shell (stopgap)", () => {
      expect(terminalFactory.shouldUseWebglRenderer('auto', true)).toBe(false)
    })

    it("should honor explicit 'webgl' on the mobile web shell (user intent)", () => {
      expect(terminalFactory.shouldUseWebglRenderer('webgl', true)).toBe(true)
    })

    it("should treat 'dom' as WebGL-ineligible on the mobile web shell", () => {
      expect(terminalFactory.shouldUseWebglRenderer('dom', true)).toBe(false)
    })

    it('should default the mobile-shell flag to false (desktop call sites)', () => {
      expect(terminalFactory.shouldUseWebglRenderer('auto')).toBe(true)
      expect(terminalFactory.shouldUseWebglRenderer('webgl')).toBe(true)
      expect(terminalFactory.shouldUseWebglRenderer('dom')).toBe(false)
    })
  })
})
