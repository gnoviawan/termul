/**
 * Languages of the GPUIX code editor.
 *
 * Two sides per editor language id (the ids `editor-store` derives from a
 * file extension):
 * - the Lezer `LanguageSupport` the web editor loads, for Enter indentation,
 *   comment toggling and chunk boundaries (`chunks.ts`); and
 * - the grammar alias native `<code>` highlights with (Syntect in Rust).
 *   Astro has no native grammar and paints with the HTML one.
 */

import type { LanguageSupport } from '@codemirror/language'
import { logFrontendError } from '@/lib/log-api'

const cache = new Map<string, Promise<LanguageSupport | null>>()

async function load(language: string, jsx: boolean): Promise<LanguageSupport | null> {
  switch (language) {
    case 'javascript':
    case 'typescript': {
      const { javascript } = await import('@codemirror/lang-javascript')
      return javascript({ typescript: language === 'typescript', jsx })
    }
    case 'json':
      return (await import('@codemirror/lang-json')).json()
    case 'css':
      return (await import('@codemirror/lang-css')).css()
    case 'html':
      return (await import('@codemirror/lang-html')).html()
    case 'astro':
      return (await import('@/lib/codemirror-lang-astro')).astro()
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown()
    case 'python':
      return (await import('@codemirror/lang-python')).python()
    case 'rust':
      return (await import('@codemirror/lang-rust')).rust()
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml()
    default:
      return null
  }
}

/** The Lezer language for an editor language id, or null for plain text. Cached; never rejects. */
export function loadLanguage(language: string, jsx = true): Promise<LanguageSupport | null> {
  const key = `${language}:${jsx}`
  let pending = cache.get(key)
  if (!pending) {
    pending = load(language, jsx).catch((error: unknown) => {
      void logFrontendError({
        level: 'warn',
        source: 'gpuix-editor.loadLanguage',
        message: `syntax language failed to load lang=${language} (${String(error)})`
      })
      return null
    })
    cache.set(key, pending)
  }
  return pending
}

const NATIVE_GRAMMAR: Readonly<Record<string, string>> = {
  javascript: 'javascript',
  typescript: 'typescript',
  json: 'json',
  css: 'css',
  html: 'html',
  astro: 'html',
  markdown: 'markdown',
  python: 'python',
  rust: 'rust',
  yaml: 'yaml',
  toml: 'toml'
}

/** The `<code language>` alias for a file, or undefined for plain text. */
export function nativeGrammar(language: string, filePath: string): string | undefined {
  if (language === 'typescript' && /\.tsx$/i.test(filePath)) return 'tsx'
  if (language === 'javascript' && /\.jsx$/i.test(filePath)) return 'jsx'
  return NATIVE_GRAMMAR[language]
}
