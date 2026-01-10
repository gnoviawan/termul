import { describe, test, expect } from 'vitest'

// Constants matching the implementation
const TRUNCATE_START_LENGTH = 15
const TRUNCATE_ELLIPSIS_LENGTH = 3

// Test the pure utility functions directly without React dependencies
// We copy the function implementations here to test them in isolation
function formatPath(
  fullPath: string,
  homeDir: string | undefined,
  maxLength: number = 50
): string {
  if (!fullPath) return ''

  let formatted = fullPath

  if (homeDir) {
    // Normalize both paths to use forward slashes for comparison
    const normalizedHome = homeDir.replace(/\\/g, '/')
    const normalizedPath = fullPath.replace(/\\/g, '/')

    // Check if path starts with home dir followed by a separator or is exactly home dir
    if (
      normalizedPath === normalizedHome ||
      normalizedPath.startsWith(normalizedHome + '/')
    ) {
      formatted = '~' + normalizedPath.slice(normalizedHome.length)
    } else {
      // Keep original path but normalize slashes for display consistency
      formatted = normalizedPath
    }
  }

  // Truncate if too long
  if (formatted.length > maxLength) {
    const start = formatted.slice(0, TRUNCATE_START_LENGTH)
    const endLength = maxLength - TRUNCATE_START_LENGTH - TRUNCATE_ELLIPSIS_LENGTH
    const end = formatted.slice(-endLength)
    return `${start}...${end}`
  }

  return formatted
}

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
})
