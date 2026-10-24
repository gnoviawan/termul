/**
 * A markdown body cut at its headings, for the GPUIX Preview. The native
 * `<markdown>` element paints a whole document and reports no block
 * positions, so the Preview renders one heading plus one `<markdown>` per
 * section: each heading then has a box to scroll to and to test against the
 * viewport, which the outline needs, and its margins can follow the web
 * document's rhythm instead of the element's single block gap.
 *
 * Headings come from the outline's own parser (`parseMarkdownHeadings`), so
 * a section line is the line the outline jumps to.
 */

import { parseMarkdownHeadings } from '@/hooks/use-toc-headings'

export interface MarkdownSection {
  /** 1-based line of the heading that opens the section; 0 for the text before the first heading. */
  line: number
  heading: { level: number; text: string } | null
  /** The markdown between this heading and the next. */
  body: string
}

export function splitMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n')
  const headings = parseMarkdownHeadings(markdown)
  const sections: MarkdownSection[] = []
  const lead = lines
    .slice(0, headings.length > 0 ? (headings[0].line ?? 1) - 1 : lines.length)
    .join('\n')
  if (lead.trim()) sections.push({ line: 0, heading: null, body: lead })
  headings.forEach((heading, index) => {
    const line = heading.line ?? 1
    const setext = !/^ {0,3}#/.test(lines[line - 1] ?? '')
    const bodyStart = line + (setext ? 1 : 0)
    const next = headings[index + 1]?.line
    const bodyEnd = next === undefined ? lines.length : next - 1
    sections.push({
      line,
      heading: { level: heading.level, text: heading.text },
      body: lines.slice(bodyStart, bodyEnd).join('\n')
    })
  })
  return sections
}
