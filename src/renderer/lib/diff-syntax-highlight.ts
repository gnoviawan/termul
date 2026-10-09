import type { Highlighter, Tag } from '@lezer/highlight'
import { highlightTree, tags } from '@lezer/highlight'
import { getLastAppliedColorThemeId } from '@/lib/themes/apply-color-theme'
import { getColorThemeDefinition } from '@/lib/themes/bundled-themes'
import { resolveSyntaxColors } from '@/lib/themes/resolve-syntax'
import type { ResolvedSyntaxColors } from '@/lib/themes/types'
import { detectLanguage } from '@/stores/editor-store'

export interface TokenSpan {
  start: number
  end: number
  color: string
}

// Each Tag's `.set` array contains itself and all parent tags in decreasing
// specificity, so walking `.set` gives the most specific match first.
const tagColorKeys = new Map<Tag, keyof ResolvedSyntaxColors>()
tagColorKeys.set(tags.function(tags.definition(tags.variableName)), 'function')
tagColorKeys.set(tags.function(tags.variableName), 'function')
tagColorKeys.set(tags.definition(tags.variableName), 'definition')
tagColorKeys.set(tags.variableName, 'variable')
tagColorKeys.set(tags.keyword, 'keyword')
tagColorKeys.set(tags.comment, 'comment')
tagColorKeys.set(tags.lineComment, 'comment')
tagColorKeys.set(tags.blockComment, 'comment')
tagColorKeys.set(tags.string, 'string')
tagColorKeys.set(tags.special(tags.string), 'string')
tagColorKeys.set(tags.number, 'number')
tagColorKeys.set(tags.integer, 'number')
tagColorKeys.set(tags.float, 'number')
tagColorKeys.set(tags.bool, 'bool')
tagColorKeys.set(tags.null, 'bool')
tagColorKeys.set(tags.typeName, 'type')
tagColorKeys.set(tags.className, 'type')
tagColorKeys.set(tags.propertyName, 'property')
tagColorKeys.set(tags.operator, 'operator')
tagColorKeys.set(tags.punctuation, 'punctuation')
tagColorKeys.set(tags.meta, 'keyword')
tagColorKeys.set(tags.regexp, 'string')
tagColorKeys.set(tags.tagName, 'tag')
tagColorKeys.set(tags.attributeName, 'attributeName')
tagColorKeys.set(tags.attributeValue, 'attributeValue')
tagColorKeys.set(tags.heading, 'heading')
tagColorKeys.set(tags.link, 'link')

const tokenCache = new Map<string, TokenSpan[]>()
const TOKEN_CACHE_LIMIT = 2000

let cachedThemeId = getLastAppliedColorThemeId()
let cachedSyntax: ResolvedSyntaxColors = resolveSyntaxColors(getColorThemeDefinition(cachedThemeId))

function activeSyntaxColors(): ResolvedSyntaxColors {
  const themeId = getLastAppliedColorThemeId()
  if (themeId !== cachedThemeId) {
    cachedThemeId = themeId
    cachedSyntax = resolveSyntaxColors(getColorThemeDefinition(themeId))
    tokenCache.clear()
  }
  return cachedSyntax
}

const diffHighlighter: Highlighter = {
  style(tagSet: readonly Tag[]): string | null {
    const colors = activeSyntaxColors()
    for (const t of tagSet) {
      for (const ancestor of t.set) {
        const key = tagColorKeys.get(ancestor)
        if (key) return `color:${colors[key]}`
      }
    }
    return null
  }
}

interface ParserEntry {
  parser: { parse: (text: string) => unknown }
  ready: boolean
}

const parserCache = new Map<string, ParserEntry | null>()
const pendingLoads = new Map<string, Promise<ParserEntry | null>>()

async function loadParser(language: string): Promise<ParserEntry | null> {
  if (parserCache.has(language)) {
    return parserCache.get(language) ?? null
  }

  if (pendingLoads.has(language)) {
    return pendingLoads.get(language)!
  }

  const promise = (async (): Promise<ParserEntry | null> => {
    try {
      let parser: unknown = null

      switch (language) {
        case 'typescript': {
          const mod = await import('@codemirror/lang-javascript')
          parser = mod.typescriptLanguage.parser
          break
        }
        case 'javascript': {
          const mod = await import('@codemirror/lang-javascript')
          parser = mod.javascriptLanguage.parser
          break
        }
        case 'json': {
          const mod = await import('@codemirror/lang-json')
          parser = mod.jsonLanguage.parser
          break
        }
        case 'css': {
          const mod = await import('@codemirror/lang-css')
          parser = mod.cssLanguage.parser
          break
        }
        case 'html': {
          const mod = await import('@codemirror/lang-html')
          parser = mod.htmlLanguage.parser
          break
        }
        case 'markdown': {
          const mod = await import('@codemirror/lang-markdown')
          parser = mod.markdownLanguage.parser
          break
        }
        case 'python': {
          const mod = await import('@codemirror/lang-python')
          parser = mod.pythonLanguage.parser
          break
        }
        case 'rust': {
          const mod = await import('@codemirror/lang-rust')
          parser = mod.rustLanguage.parser
          break
        }
        case 'yaml': {
          const mod = await import('@codemirror/lang-yaml')
          parser = mod.yamlLanguage.parser
          break
        }
        default:
          parserCache.set(language, null)
          return null
      }

      if (parser) {
        const entry: ParserEntry = {
          parser: parser as ParserEntry['parser'],
          ready: true
        }
        parserCache.set(language, entry)
        return entry
      }
    } catch {
      // Parser load failed — fall back to plain text
    }

    parserCache.set(language, null)
    return null
  })()

  pendingLoads.set(language, promise)
  const result = await promise
  pendingLoads.delete(language)
  return result
}

/**
 * Preload a parser for a language. Call this when a file is selected
 * so the parser is ready by the time rendering happens.
 */
export async function preloadParser(filePath: string): Promise<void> {
  const language = getLanguageForFile(filePath)
  if (language) {
    await loadParser(language)
  }
}

export function getLanguageForFile(filePath: string): string {
  return detectLanguage(filePath)
}

function getCachedTokens(cacheKey: string): TokenSpan[] | undefined {
  return tokenCache.get(cacheKey)
}

function setCachedTokens(cacheKey: string, spans: TokenSpan[]): void {
  if (tokenCache.size >= TOKEN_CACHE_LIMIT) {
    const firstKey = tokenCache.keys().next().value
    if (firstKey !== undefined) {
      tokenCache.delete(firstKey)
    }
  }
  tokenCache.set(cacheKey, spans)
}

function computeTokenSpans(text: string, parser: ParserEntry['parser']): TokenSpan[] {
  try {
    const tree = parser.parse(text)
    const spans: TokenSpan[] = []
    let lastEnd = 0

    highlightTree(tree as never, diffHighlighter, (from: number, to: number, classes: string) => {
      if (from > lastEnd) {
        spans.push({ start: lastEnd, end: from, color: '' })
      }
      spans.push({ start: from, end: to, color: classes })
      lastEnd = to
    })

    if (lastEnd < text.length) {
      spans.push({ start: lastEnd, end: text.length, color: '' })
    }

    return spans
  } catch {
    return []
  }
}

/**
 * Tokenize a line of text for syntax highlighting.
 * Returns TokenSpan[] with start/end positions and color strings.
 * If the parser for the language is not yet loaded, returns empty array
 * (plain text) and triggers async load in background.
 */
export function tokenizeLine(text: string, language: string): TokenSpan[] {
  if (!language || !text) return []

  const cacheKey = `${getLastAppliedColorThemeId()}\0${language}\0${text}`
  const cached = getCachedTokens(cacheKey)
  if (cached) return cached

  const entry = parserCache.get(language)
  if (entry?.ready) {
    const spans = computeTokenSpans(text, entry.parser)
    setCachedTokens(cacheKey, spans)
    return spans
  }

  // Parser not loaded yet — trigger async load, return empty for now
  if (!entry && !pendingLoads.has(language)) {
    void loadParser(language)
  }

  return []
}

/**
 * Tokenize a line of text, loading parser asynchronously if needed.
 * Returns a promise that resolves to TokenSpan[].
 */
export async function tokenizeLineAsync(text: string, language: string): Promise<TokenSpan[]> {
  if (!language || !text) return []

  const cacheKey = `${getLastAppliedColorThemeId()}\0${language}\0${text}`
  const cached = getCachedTokens(cacheKey)
  if (cached) return cached

  const entry = await loadParser(language)
  if (!entry) return []

  const spans = computeTokenSpans(text, entry.parser)
  setCachedTokens(cacheKey, spans)
  return spans
}

/**
 * Check if a parser for the given language has been resolved (either loaded
 * or determined unavailable). Returns true when no further loading will occur.
 */
export function isParserReady(language: string): boolean {
  return parserCache.has(language)
}
