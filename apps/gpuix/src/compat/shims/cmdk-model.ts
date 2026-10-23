/** The parts of the cmdk stand-in that are plain data: part-class splitting and the filter. */

export type Part = 'group-heading' | 'group' | 'group-items' | 'item' | 'input' | 'list' | 'empty' | 'separator'
export type PartClasses = Partial<Record<Part, string>>

const PART_VARIANT = /^\[&_\[cmdk-([a-z-]+)\]\]:(.+)$/

/** Split `[&_[cmdk-x]]:cls` tokens out of a className: the element keeps the rest. */
export function splitPartClasses(className: string | undefined): { own: string; parts: PartClasses } {
  const own: string[] = []
  const parts: PartClasses = {}
  for (const token of (className ?? '').split(/\s+/).filter(Boolean)) {
    const match = token.match(PART_VARIANT)
    if (!match) {
      own.push(token)
      continue
    }
    const part = match[1] as Part
    parts[part] = parts[part] ? `${parts[part]} ${match[2]}` : match[2]
  }
  return { own: own.join(' '), parts }
}

/** cmdk's ranking, reduced to what decides visibility: substring, then in-order letters. */
export function defaultFilter(value: string, search: string, keywords: readonly string[] = []): number {
  const haystack = `${value} ${keywords.join(' ')}`.toLowerCase()
  const needle = search.trim().toLowerCase()
  if (!needle || haystack.includes(needle)) return 1
  let at = 0
  for (const char of needle) {
    at = haystack.indexOf(char, at)
    if (at < 0) return 0
    at++
  }
  return 0.5
}
