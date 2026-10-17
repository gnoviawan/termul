import { type BundledLanguage, bundledLanguages, codeToTokensWithThemes } from 'shiki'
import { logFrontendError } from '@/lib/log-api'
import { getLastAppliedColorThemeId } from '@/lib/themes/apply-color-theme'
import { syntaxShikiPair } from '@/lib/themes/syntax-shiki'

/** Skip highlighting beyond these bounds; the diff renders plain instead. */
export const DIFF_HIGHLIGHT_MAX_LINES = 2000
export const DIFF_HIGHLIGHT_MAX_CHARS = 100_000

/** A single highlighted token: raw text plus per-theme colors. */
export interface DiffToken {
  content: string
  light?: string
  dark?: string
  italic?: boolean
  bold?: boolean
}

export type DiffTokenLine = DiffToken[]

// TextMate font-style bitmask (vscode-textmate FontStyle: Italic=1, Bold=2).
const FONT_STYLE_ITALIC = 1
const FONT_STYLE_BOLD = 2

const EXT_TO_LANG: Record<string, BundledLanguage> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  py: 'python',
  rb: 'ruby',
  php: 'php',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'fish',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  md: 'markdown',
  mdx: 'mdx',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  xml: 'xml',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  hs: 'haskell',
  clj: 'clojure',
  vim: 'vim',
  dockerfile: 'dockerfile',
  diff: 'diff',
  patch: 'diff'
}

const FILENAME_TO_LANG: Record<string, BundledLanguage> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile'
}

function isBundledLanguage(lang: string): lang is BundledLanguage {
  return Object.prototype.hasOwnProperty.call(bundledLanguages, lang)
}

/** Map a file path to a Shiki language id; unknown → plaintext. */
export function resolveDiffLanguage(filePath: string): BundledLanguage | 'plaintext' {
  const base = filePath.split('/').pop() ?? filePath
  const lower = base.toLowerCase()
  if (FILENAME_TO_LANG[lower]) return FILENAME_TO_LANG[lower]
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  return EXT_TO_LANG[lower.slice(dot + 1)] ?? 'plaintext'
}

/**
 * Highlight whole text to per-line tokens (dual theme). The whole text is
 * tokenized in one pass so multi-line constructs (block comments, template
 * literals) keep correct colors on every line. Returns null when over
 * budget or on any failure — the caller renders plain text instead.
 */
export async function highlightDiffText(
  text: string,
  lang: string,
  themeId: string = getLastAppliedColorThemeId()
): Promise<DiffTokenLine[] | null> {
  if (text.length > DIFF_HIGHLIGHT_MAX_CHARS) return null
  if (text.split('\n').length > DIFF_HIGHLIGHT_MAX_LINES) return null
  if (lang === 'plaintext' || !isBundledLanguage(lang)) return null
  // Strip CRs so token streams align 1:1 with diffLines() (which trims a
  // trailing CR per line). Line count is unchanged by this.
  const clean = text.replace(/\r/g, '')
  try {
    const [light, dark] = syntaxShikiPair(themeId)
    const lines = await codeToTokensWithThemes(clean, {
      lang,
      themes: { light, dark }
    })
    return lines.map((tokens) =>
      tokens.map((token) => {
        const style = token.variants.light ?? token.variants.dark
        const fontStyle = style?.fontStyle ?? 0
        return {
          content: token.content,
          light: token.variants.light?.color,
          dark: token.variants.dark?.color,
          italic: (fontStyle & FONT_STYLE_ITALIC) !== 0 ? true : undefined,
          bold: (fontStyle & FONT_STYLE_BOLD) !== 0 ? true : undefined
        } satisfies DiffToken
      })
    )
  } catch (error) {
    void logFrontendError({
      level: 'warn',
      source: 'diff-highlight.highlightDiffText',
      message: `highlight failed for lang '${lang}': ${error instanceof Error ? error.message : String(error)}`
    })
    return null
  }
}
