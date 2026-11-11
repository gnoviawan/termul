import { describe, expect, test, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ systemApi: {}, terminalApi: {} }))
vi.mock('@/stores/terminal-store', () => ({ useTerminalStore: vi.fn() }))

import { formatPath } from './use-cwd'

describe('formatPath', () => {
  test('returns empty string for empty path', () => {
    expect(formatPath('', undefined)).toBe('')
  })

  test('returns path unchanged when no home dir provided', () => {
    expect(formatPath('/some/path/here', undefined)).toBe('/some/path/here')
  })

  test('replaces home directory with ~ on Unix', () => {
    expect(formatPath('/home/user/projects/test', '/home/user')).toBe('~/projects/test')
  })

  test('replaces home directory with ~ on Windows', () => {
    expect(formatPath('C:\\Users\\John\\Documents\\project', 'C:\\Users\\John')).toBe(
      '~/Documents/project'
    )
  })

  test('handles Windows paths with forward slashes after home dir replacement', () => {
    const result = formatPath('C:\\Users\\John\\test', 'C:\\Users\\John')
    expect(result).toBe('~/test')
  })

  test('truncates long paths with ellipsis', () => {
    const longPath = '/a/very/long/path/that/exceeds/the/maximum/length/limit/for/display'
    const result = formatPath(longPath, undefined, 40)
    expect(result.length).toBeLessThanOrEqual(40)
    expect(result).toContain('...')
  })

  test('keeps short paths intact', () => {
    const shortPath = '/short/path'
    expect(formatPath(shortPath, undefined, 50)).toBe(shortPath)
  })

  test('uses default maxLength of 50', () => {
    const exactlyFifty = 'a'.repeat(50)
    const fiftyOne = 'a'.repeat(51)
    expect(formatPath(exactlyFifty, undefined)).toBe(exactlyFifty)
    expect(formatPath(fiftyOne, undefined)).toContain('...')
  })

  test('does not replace partial home dir matches', () => {
    expect(formatPath('/home/username/projects', '/home/user')).toBe('/home/username/projects')
  })

  test('handles exact home dir path', () => {
    expect(formatPath('/home/user', '/home/user')).toBe('~')
  })

  test('normalizes Windows paths to forward slashes', () => {
    const result = formatPath('C:\\Users\\Other\\Documents', 'C:\\Users\\John')
    expect(result).toBe('C:/Users/Other/Documents')
  })

  describe('Windows verbatim prefix', () => {
    test('drops the backslash verbatim prefix and keeps the separators', () => {
      expect(formatPath(String.raw`\\?\D:\proj`, undefined)).toBe(String.raw`D:\proj`)
    })

    test('drops the forward-slash verbatim prefix and keeps the separators', () => {
      expect(formatPath('//?/D:/proj', undefined)).toBe('D:/proj')
    })

    test('shows a verbatim UNC path as a plain UNC path', () => {
      expect(formatPath(String.raw`\\?\UNC\srv\share\proj`, undefined)).toBe(
        String.raw`\\srv\share\proj`
      )
      expect(formatPath('//?/UNC/srv/share/proj', undefined)).toBe('//srv/share/proj')
    })

    test('keeps a volume GUID path whole', () => {
      const volume = String.raw`\\?\Volume{0b1c2d3e-0000-0000-0000-100000000000}\proj`
      expect(formatPath(volume, undefined, 200)).toBe(volume)
    })

    test('still abbreviates the home directory under a verbatim path', () => {
      expect(formatPath(String.raw`\\?\C:\Users\John\proj`, String.raw`C:\Users\John`)).toBe(
        '~/proj'
      )
    })
  })
})
