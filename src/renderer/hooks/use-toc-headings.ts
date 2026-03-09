import { useMemo } from 'react'

export interface TocHeading {
  id: string
  level: number
  text: string
  line?: number
  blockId?: string
}

const ATX_HEADING_PATTERN = /^ {0,3}(#{1,6})[ \t]+(.+)$/
const SETEXT_HEADING_PATTERN = /^ {0,3}(=+|-+)[ \t]*$/
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/

function normalizeAtxHeadingText(text: string): string {
  return text.replace(/[ \t]+#+[ \t]*$/, '').trim()
}

function getFenceInfo(line: string): { marker: '`' | '~'; length: number } | null {
  const match = FENCE_PATTERN.exec(line)
  if (!match) {
    return null
  }

  const marker = match[1][0] as '`' | '~'

  return {
    marker,
    length: match[1].length
  }
}

function isFenceClosingLine(
  line: string,
  activeFence: { marker: '`' | '~'; length: number }
): boolean {
  const trimmedLine = line.trim()
  if (!trimmedLine) {
    return false
  }

  if (!trimmedLine.startsWith(activeFence.marker)) {
    return false
  }

  const markerCount = trimmedLine.match(new RegExp(`^\\${activeFence.marker}+`))?.[0].length ?? 0
  if (markerCount < activeFence.length) {
    return false
  }

  return trimmedLine.slice(markerCount).trim().length === 0
}

export function parseMarkdownHeadings(content: string): TocHeading[] {
  const lines = content.split('\n')
  const headings: TocHeading[] = []
  let activeFence: { marker: '`' | '~'; length: number } | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const lineContent = lines[index]

    if (activeFence) {
      if (isFenceClosingLine(lineContent, activeFence)) {
        activeFence = null
      }
      continue
    }

    const fenceInfo = getFenceInfo(lineContent)
    if (fenceInfo) {
      activeFence = fenceInfo
      continue
    }

    const atxMatch = ATX_HEADING_PATTERN.exec(lineContent)
    if (atxMatch) {
      const text = normalizeAtxHeadingText(atxMatch[2])
      const line = index + 1

      if (text) {
        headings.push({
          id: `heading-line-${line}`,
          level: atxMatch[1].length,
          text,
          line
        })
      }

      continue
    }

    const setextMatch = SETEXT_HEADING_PATTERN.exec(lineContent)
    if (!setextMatch || index === 0) {
      continue
    }

    const previousRawLine = lines[index - 1] ?? ''
    const previousLine = previousRawLine.trim()
    if (!previousLine || ATX_HEADING_PATTERN.test(previousRawLine) || previousRawLine.startsWith('    ')) {
      continue
    }

    const line = index
    headings.push({
      id: `heading-line-${line}`,
      level: setextMatch[1][0] === '=' ? 1 : 2,
      text: previousLine,
      line
    })
  }

  return headings
}

export function filterTocHeadings(headings: TocHeading[], maxLevel: number): TocHeading[] {
  return headings.filter((heading) => heading.level <= maxLevel)
}

interface UseTocHeadingsOptions {
  content: string
  maxLevel: number
}

interface UseTocHeadingsResult {
  headings: TocHeading[]
}

export function useTocHeadings({ content, maxLevel }: UseTocHeadingsOptions): UseTocHeadingsResult {
  const headings = useMemo(() => {
    return filterTocHeadings(parseMarkdownHeadings(content), maxLevel)
  }, [content, maxLevel])

  return { headings }
}
