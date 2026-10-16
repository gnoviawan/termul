/** Display helpers for remote (SFTP) file entries. */

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(1)} GB`
}

/**
 * `rwxr-xr-x` from a Unix mode. File-type bits are ignored. The backend
 * sends 0 when the server reported no permissions, so 0 yields `null`.
 */
export function formatPermissions(mode: number): string | null {
  if (!mode) return null
  const bits = mode & 0o777
  const flags = ['r', 'w', 'x']
  let out = ''
  for (let shift = 6; shift >= 0; shift -= 3) {
    const triad = (bits >> shift) & 0o7
    for (let i = 0; i < 3; i++) out += triad & (4 >> i) ? flags[i] : '-'
  }
  return out
}

/** The backend sends the Unix epoch when the server reported no time. */
function parseModified(iso: string): Date | null {
  const date = new Date(iso)
  const time = date.getTime()
  return Number.isNaN(time) || time <= 0 ? null : date
}

/**
 * Short modified time for a narrow column: the time for today, day and
 * month for this year, else the year. Empty when unknown.
 */
export function formatModified(iso: string, now: Date = new Date(), locale?: string): string {
  const date = parseModified(iso)
  if (!date) return ''
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(date)
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date)
  }
  return String(date.getFullYear())
}

/** Full modified date and time for details and tooltips. Empty when unknown. */
export function formatModifiedFull(iso: string, locale?: string): string {
  const date = parseModified(iso)
  if (!date) return ''
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
