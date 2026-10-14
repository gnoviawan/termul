import { describe, expect, it } from 'vitest'
import { formatModified, formatModifiedFull, formatPermissions, formatSize } from './sftp-format'

describe('formatSize', () => {
  it('scales bytes to the largest whole unit', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(5 * 1048576)).toBe('5.0 MB')
    expect(formatSize(3 * 1073741824)).toBe('3.0 GB')
  })
})

describe('formatPermissions', () => {
  it('renders the rwx triads and ignores the file-type bits', () => {
    expect(formatPermissions(0o755)).toBe('rwxr-xr-x')
    expect(formatPermissions(0o100644)).toBe('rw-r--r--')
    expect(formatPermissions(0o40700)).toBe('rwx------')
  })

  it('is null when the server reported no mode', () => {
    expect(formatPermissions(0)).toBeNull()
  })
})

describe('formatModified', () => {
  const now = new Date(2026, 9, 14, 15, 0)

  it('shows the time for today', () => {
    const iso = new Date(2026, 9, 14, 14, 2).toISOString()
    expect(formatModified(iso, now, 'en-GB')).toBe('14:02')
  })

  it('shows day and month for this year', () => {
    const iso = new Date(2026, 9, 12, 9, 0).toISOString()
    expect(formatModified(iso, now, 'en-GB')).toBe('12 Oct')
  })

  it('shows the year for older files', () => {
    const iso = new Date(2024, 2, 1).toISOString()
    expect(formatModified(iso, now, 'en-GB')).toBe('2024')
  })

  it('is empty for the epoch the backend sends when the time is unknown', () => {
    expect(formatModified('1970-01-01T00:00:00Z', now)).toBe('')
    expect(formatModifiedFull('1970-01-01T00:00:00+00:00')).toBe('')
    expect(formatModified('not a date', now)).toBe('')
  })
})

describe('formatModifiedFull', () => {
  it('includes the date and the time', () => {
    const iso = new Date(2026, 9, 12, 14, 2).toISOString()
    expect(formatModifiedFull(iso, 'en-GB')).toBe('12 Oct 2026, 14:02')
  })
})
