import { describe, test, expect } from 'vitest'
import { parseExitCode } from './exit-code-tracker'

describe('parseExitCode', () => {
  describe('OSC 133;D pattern', () => {
    test('parses exit code 0 from OSC sequence', () => {
      const data = 'some output\x1b]133;D;0\x07more output'
      expect(parseExitCode(data)).toBe(0)
    })

    test('parses non-zero exit code from OSC sequence', () => {
      const data = '\x1b]133;D;1\x07'
      expect(parseExitCode(data)).toBe(1)
    })

    test('parses large exit code from OSC sequence', () => {
      const data = '\x1b]133;D;127\x07'
      expect(parseExitCode(data)).toBe(127)
    })

    test('parses exit code 255 from OSC sequence', () => {
      const data = '\x1b]133;D;255\x07'
      expect(parseExitCode(data)).toBe(255)
    })

    test('returns 0 for OSC sequence without exit code', () => {
      const data = '\x1b]133;D;\x07'
      expect(parseExitCode(data)).toBe(0)
    })

    test('returns 0 for OSC sequence with D only', () => {
      const data = '\x1b]133;D\x07'
      expect(parseExitCode(data)).toBe(0)
    })
  })

  describe('Custom marker pattern', () => {
    test('parses exit code 0 from marker', () => {
      const data = 'prompt__TERMUL_EXIT__0__command'
      expect(parseExitCode(data)).toBe(0)
    })

    test('parses non-zero exit code from marker', () => {
      const data = '__TERMUL_EXIT__1__'
      expect(parseExitCode(data)).toBe(1)
    })

    test('parses large exit code from marker', () => {
      const data = '__TERMUL_EXIT__127__'
      expect(parseExitCode(data)).toBe(127)
    })
  })

  describe('No match cases', () => {
    test('returns null for data without exit code', () => {
      const data = 'regular terminal output'
      expect(parseExitCode(data)).toBeNull()
    })

    test('returns null for empty string', () => {
      expect(parseExitCode('')).toBeNull()
    })

    test('returns null for partial OSC sequence', () => {
      const data = '\x1b]133;'
      expect(parseExitCode(data)).toBeNull()
    })

    test('returns null for different OSC command', () => {
      const data = '\x1b]0;Window Title\x07'
      expect(parseExitCode(data)).toBeNull()
    })
  })

  describe('Priority', () => {
    test('OSC pattern takes priority over marker pattern', () => {
      const data = '__TERMUL_EXIT__1__\x1b]133;D;0\x07'
      expect(parseExitCode(data)).toBe(0)
    })

    test('OSC pattern before marker in string still takes priority', () => {
      const data = '\x1b]133;D;2\x07__TERMUL_EXIT__5__'
      expect(parseExitCode(data)).toBe(2)
    })
  })

  describe('Edge cases', () => {
    test('handles exit code at end of long output', () => {
      const longOutput = 'x'.repeat(1000) + '\x1b]133;D;0\x07'
      expect(parseExitCode(longOutput)).toBe(0)
    })

    test('handles multiple exit codes - returns first OSC match', () => {
      const data = '\x1b]133;D;1\x07\x1b]133;D;2\x07'
      expect(parseExitCode(data)).toBe(1)
    })
  })
})
