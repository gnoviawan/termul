import { vi } from 'vitest'

const mockMatch = vi.fn((list: string[], pattern: string | string[]) => {
  if (typeof pattern === 'string') {
    return list.filter((item) => {
      const regex = new RegExp(
        '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.')
      )
      return regex.test(item)
    })
  }
  return list
})

const mockIsMatch = vi.fn((str: string, pattern: string | string[]) => {
  if (typeof pattern === 'string') {
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.')
    )
    return regex.test(str)
  }
  return false
})

export const match = mockMatch
export const isMatch = mockIsMatch
export const matcher = vi.fn((pattern: string) => {
  const regex = new RegExp(
    '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.')
  )
  return (str: string) => regex.test(str)
})
export const scan = vi.fn((pattern: string) => [pattern])
export const parse = vi.fn((pattern: string) => ({ pattern }))
export const makeRe = vi.fn((pattern: string) => {
  const regex = new RegExp(
    '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.')
  )
  return regex
})
export const any: any[] = []
export const parseNoExt = vi.fn(() => ({}))
export const contains = vi.fn(() => false)
export const matchKeys = vi.fn(() => [])
export const filter = mockMatch
export const sep = '/'
export const isWindows = false
export const unixify = vi.fn((s: string) => s.replace(/\\/g, '/'))
export const braceExpand = vi.fn((s: string) => [s])
export const expand = vi.fn((s: string) => [s])
export const globstar = vi.fn(() => '**')

// Default export
export default {
  match: mockMatch,
  isMatch: mockIsMatch,
  matcher,
  scan,
  parse,
  makeRe,
  any,
  parseNoExt,
  contains,
  matchKeys,
  filter: mockMatch,
  sep,
  isWindows,
  unixify,
  braceExpand,
  expand,
  globstar
}
