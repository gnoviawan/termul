import { css } from '@codemirror/lang-css'
import { htmlLanguage } from '@codemirror/lang-html'
import { javascript, tsxLanguage, typescriptLanguage } from '@codemirror/lang-javascript'
import { defineLanguageFacet, Language, LanguageSupport } from '@codemirror/language'
import { type Input, Parser, type PartialParse, parseMixed, type TreeFragment } from '@lezer/common'

/**
 * Component script between the opening and closing `---` fences.
 * `contentFrom` / `contentTo` bound the script. `fenceTo` is the first
 * index after the closing fence line.
 */
interface FrontmatterSpan {
  contentFrom: number
  contentTo: number
  fenceTo: number
}

/**
 * Astro component script: a `---` line at the start of the file and a
 * later `---` line. Matches the component-script fence in the Astro docs.
 * Returns null when the file has no closed fence.
 */
export function findFrontmatter(text: string): FrontmatterSpan | null {
  let contentFrom = 0
  if (text.startsWith('---\r\n')) contentFrom = 5
  else if (text.startsWith('---\n')) contentFrom = 4
  else return null

  let i = contentFrom
  while (i <= text.length) {
    const nl = text.indexOf('\n', i)
    const end = nl < 0 ? text.length : nl
    let line = text.slice(i, end)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line === '---') {
      return { contentFrom, contentTo: i, fenceTo: nl < 0 ? text.length : nl + 1 }
    }
    if (nl < 0) return null
    i = nl + 1
  }
  return null
}

function skipString(text: string, start: number): number {
  const quote = text[start]
  let i = start + 1
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
      const end = matchBrace(text, i + 1)
      if (end < 0) return text.length
      i = end + 1
      continue
    }
    if (text[i] === quote) return i + 1
    if (quote !== '`' && (text[i] === '\n' || text[i] === '\r')) return i
    i++
  }
  return text.length
}

/** Index of the `}` that closes the `{` at `open`, or -1 when it is missing. */
function matchBrace(text: string, open: number): number {
  let depth = 0
  let i = open
  while (i < text.length) {
    const c = text[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(text, i)
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      if (nl < 0) return -1
      i = nl
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) return -1
      i = end + 2
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

function expressionRanges(text: string, base: number): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open < 0) break
    const close = matchBrace(text, open)
    if (close < 0) {
      if (open + 1 < text.length) ranges.push({ from: base + open + 1, to: base + text.length })
      break
    }
    if (close > open + 1) ranges.push({ from: base + open + 1, to: base + close })
    i = close + 1
  }
  return ranges
}

const expressionParser = tsxLanguage.parser.configure({ top: 'SingleExpression' })

const frontmatterCache = new WeakMap<object, FrontmatterSpan | null>()

function frontmatterFor(input: Input): FrontmatterSpan | null {
  const key = input as object
  const cached = frontmatterCache.get(key)
  if (cached !== undefined) return cached
  const span = findFrontmatter(input.read(0, input.length))
  frontmatterCache.set(key, span)
  return span
}

function braceOverlay(text: string): boolean {
  return text.startsWith('{') && text.endsWith('}') && text.length > 2
}

/**
 * HTML (self-closing tags, script, style) plus two Astro regions:
 * the component script, and `{expressions}` in the template.
 */
const mixedParser = htmlLanguage.configure({
  dialect: 'selfClosing',
  wrap: parseMixed((node, input) => {
    const frontmatter = frontmatterFor(input)
    if (
      node.name === 'Document' &&
      frontmatter &&
      frontmatter.contentTo > frontmatter.contentFrom
    ) {
      return {
        parser: typescriptLanguage.parser,
        overlay: [{ from: frontmatter.contentFrom, to: frontmatter.contentTo }]
      }
    }

    if (node.name === 'Text') {
      let from = node.from
      const to = node.to
      if (frontmatter && from < frontmatter.fenceTo) from = Math.max(from, frontmatter.fenceTo)
      if (from >= to) return null
      const ranges = expressionRanges(input.read(from, to), from)
      if (ranges.length === 0) return null
      return { parser: expressionParser, overlay: ranges }
    }

    if (node.name === 'AttributeName' || node.name === 'UnquotedAttributeValue') {
      const text = input.read(node.from, node.to)
      if (!braceOverlay(text)) return null
      return {
        parser: expressionParser,
        overlay: [{ from: node.from + 1, to: node.to - 1 }]
      }
    }

    return null
  })
}).parser

/** Use the TypeScript parser for a fence-free line that is not markup. */
function parserFor(text: string): Parser {
  if (text.startsWith('---') || text.includes('<')) return mixedParser
  return typescriptLanguage.parser
}

class AstroParser extends Parser {
  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[]
  ): PartialParse {
    const sample = input.read(0, Math.min(input.length, 1_000_000))
    return parserFor(sample).startParse(input, fragments, ranges)
  }
}

const astroLanguage = new Language(
  defineLanguageFacet({
    commentTokens: { line: '//', block: { open: '<!--', close: '-->' } }
  }),
  new AstroParser(),
  [],
  'astro'
)

/** CodeMirror language support for `.astro` components. */
export function astro(): LanguageSupport {
  return new LanguageSupport(astroLanguage, [
    javascript({ typescript: true, jsx: true }).support,
    css().support
  ])
}
