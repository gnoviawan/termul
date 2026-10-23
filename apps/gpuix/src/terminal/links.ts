/**
 * The DOM terminal's link provider without xterm's hover machinery: the URL
 * and file path matches the shared builders find on a buffer line, hit-tested
 * against one cell. Ranges are 1-based and inclusive, like xterm's `ILink`.
 */
import { buildTerminalPathLinks } from '@/lib/file-path-links'
import { buildTerminalUrlLinks } from '@/lib/terminal-url-links'

export type TerminalLink = { kind: 'url' | 'path'; text: string }

const ignore = (): void => {}

/** The link covering zero-based `col` of `line`, URLs first like the DOM provider. */
export function linkAt(line: string, col: number): TerminalLink | null {
  const x = col + 1
  const covers = (link: { range: { start: { x: number }; end: { x: number } } }) =>
    link.range.start.x <= x && x <= link.range.end.x
  const url = buildTerminalUrlLinks(line, 1, ignore).find(covers)
  if (url) return { kind: 'url', text: url.text }
  const path = buildTerminalPathLinks(line, 1, ignore).find(covers)
  return path ? { kind: 'path', text: path.text } : null
}
