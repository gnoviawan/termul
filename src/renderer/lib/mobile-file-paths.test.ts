import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logFrontendError } from '@/lib/log-api'
import {
  buildFolderCrumbs,
  comparePath,
  isWithinRoot,
  joinPath,
  normalizePath,
  resolveBreadcrumbTarget
} from './mobile-file-paths'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

describe('normalizePath', () => {
  it.each([
    ['/proj/src', '/proj/src'],
    ['/proj/src/', '/proj/src'],
    ['C:/proj/src', 'C:/proj/src'],
    ['C:\\proj\\src\\', 'C:/proj/src'],
    ['C:/', 'C:/'],
    ['/', '/'],
    ['', '/'],
    ['//srv/share/p', '//srv/share/p'],
    ['/proj/./sub/../src', '/proj/src'],
    ['C:/Users/Alice/..', 'C:/Users']
  ])('leaves the plain path %j as %j', (input, expected) => {
    expect(normalizePath(input)).toBe(expected)
  })

  it.each([
    ['//?/C:/proj/src/lib', 'C:/proj/src/lib'],
    ['\\\\?\\C:\\proj\\src\\lib', 'C:/proj/src/lib'],
    ['//?/c:/proj', 'c:/proj'],
    ['//?/C:/', 'C:/'],
    ['//?/C:', 'C:/'],
    ['//?/C:/proj/', 'C:/proj'],
    ['//?/C:/proj/../other', 'C:/other']
  ])('strips the verbatim drive prefix: %j -> %j', (input, expected) => {
    expect(normalizePath(input)).toBe(expected)
  })

  it.each([
    ['//?/UNC/srv/share/p', '//srv/share/p'],
    ['\\\\?\\UNC\\srv\\share\\p', '//srv/share/p'],
    ['//?/unc/srv/share/p', '//srv/share/p'],
    ['//?/UNC/srv/share/p/..', '//srv/share']
  ])('maps the verbatim UNC prefix: %j -> %j', (input, expected) => {
    expect(normalizePath(input)).toBe(expected)
  })

  it('leaves an unrecognised verbatim form alone', () => {
    expect(normalizePath('//?/Volume{1234}/a')).toBe('//?/Volume{1234}/a')
  })

  it('is idempotent on verbatim input', () => {
    const once = normalizePath('//?/C:/proj/src')
    expect(normalizePath(once)).toBe(once)
  })
})

describe('isWithinRoot and comparePath with verbatim entries', () => {
  it('finds a verbatim entry within a plain drive root', () => {
    expect(isWithinRoot('//?/C:/proj/src/lib', 'C:/proj', true)).toBe(true)
    expect(isWithinRoot('//?/C:/proj', 'C:/proj', true)).toBe(true)
    expect(isWithinRoot('//?/C:/proj-two/src', 'C:/proj', true)).toBe(false)
  })

  it('finds a verbatim UNC entry within a plain UNC root', () => {
    expect(isWithinRoot('//?/UNC/srv/share/p/a', '//srv/share/p', true)).toBe(true)
    expect(isWithinRoot('//?/UNC/srv/other/p/a', '//srv/share/p', true)).toBe(false)
  })

  it('compares case-insensitively across the prefix', () => {
    expect(comparePath('//?/C:/Proj/Src', true)).toBe('c:/proj/src')
    expect(comparePath('//?/C:/Proj/Src', true)).toBe(comparePath('c:/proj/src', true))
  })

  it('still treats plain paths as before', () => {
    expect(isWithinRoot('/proj/sub', '/proj', true)).toBe(true)
    expect(isWithinRoot('/proj-two', '/proj', true)).toBe(false)
    expect(isWithinRoot('C:/proj/src', 'c:/proj', true)).toBe(true)
  })
})

describe('isWithinRoot and comparePath on a case-sensitive host (#641)', () => {
  it('rejects a differently cased path outside the root', () => {
    expect(isWithinRoot('/work/repo/child', '/Work/Repo', false)).toBe(false)
    expect(isWithinRoot('/work/repo', '/Work/Repo', false)).toBe(false)
  })

  it('still accepts the same path on a case-insensitive host', () => {
    expect(isWithinRoot('/work/repo/child', '/Work/Repo', true)).toBe(true)
  })

  it('accepts an exactly cased child and keeps the casing in comparePath', () => {
    expect(isWithinRoot('/Work/Repo/child', '/Work/Repo', false)).toBe(true)
    expect(comparePath('/Work/Repo/', false)).toBe('/Work/Repo')
  })

  it('keeps a drive root case-sensitive when the host says so', () => {
    expect(isWithinRoot('c:/proj/src', 'C:/proj', false)).toBe(false)
    expect(isWithinRoot('C:/proj/src', 'C:/proj', false)).toBe(true)
  })
})

describe('joinPath', () => {
  it('joins onto a normalized verbatim parent', () => {
    expect(joinPath('//?/C:/proj/src', 'new.ts')).toBe('C:/proj/src/new.ts')
  })

  it('joins onto plain parents unchanged', () => {
    expect(joinPath('/proj/', 'a')).toBe('/proj/a')
    expect(joinPath('C:/', 'a')).toBe('C:/a')
  })
})

describe('buildFolderCrumbs for a Windows-hosted termul-server', () => {
  it('shows real segments for a verbatim entry under a plain root', () => {
    const root = normalizePath('C:/proj')
    const current = normalizePath('//?/C:/proj/src/lib')

    expect(buildFolderCrumbs(root, current, true)).toEqual({
      ancestors: [
        { label: 'proj', path: 'C:/proj' },
        { label: 'src', path: 'C:/proj/src' }
      ],
      currentLabel: 'lib'
    })
  })

  it('maps a verbatim UNC entry onto the plain UNC root', () => {
    const root = normalizePath('//srv/share')
    const current = normalizePath('//?/UNC/srv/share/p')

    expect(current).toBe('//srv/share/p')
    expect(buildFolderCrumbs(root, current, true)).toEqual({
      ancestors: [{ label: 'share', path: '//srv/share' }],
      currentLabel: 'p'
    })
  })

  it('is null at the root even when the entry is verbatim', () => {
    expect(
      buildFolderCrumbs(normalizePath('C:/proj'), normalizePath('//?/C:/proj'), true)
    ).toBeNull()
  })

  it('keeps plain paths exactly as before', () => {
    expect(buildFolderCrumbs('/proj', '/proj/src/lib', false)).toEqual({
      ancestors: [
        { label: 'proj', path: '/proj' },
        { label: 'src', path: '/proj/src' }
      ],
      currentLabel: 'lib'
    })
  })
})

describe('resolveBreadcrumbTarget with verbatim paths', () => {
  beforeEach(() => {
    vi.mocked(logFrontendError).mockClear()
  })

  it('accepts a verbatim ancestor under a plain root and returns it normalized', () => {
    expect(resolveBreadcrumbTarget('//?/C:/proj/src', 'C:/proj', 'C:/proj/src/lib', true)).toBe(
      'C:/proj/src'
    )
    expect(logFrontendError).not.toHaveBeenCalled()
  })

  it('stays silent on a tap on the folder already shown', () => {
    expect(
      resolveBreadcrumbTarget('//?/C:/proj/src', 'C:/proj', '//?/C:/proj/src', true)
    ).toBeNull()
    expect(logFrontendError).not.toHaveBeenCalled()
  })

  it('still rejects a verbatim target outside the root, with a warning', () => {
    expect(resolveBreadcrumbTarget('//?/C:/other', 'C:/proj', 'C:/proj/src', true)).toBeNull()
    expect(logFrontendError).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))
  })

  it('rejects a differently cased target on a case-sensitive host, with a warning', () => {
    expect(
      resolveBreadcrumbTarget('/work/repo', '/Work/Repo', '/Work/Repo/child', false)
    ).toBeNull()
    expect(logFrontendError).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))
  })
})
