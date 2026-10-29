import { type MediaKind, mediaKindForPath } from './media-kind'
import { basename } from './path-basename'

/**
 * How an editor tab shows a file, decided by extension before any read. SVG is
 * `text`: it keeps the editable source, with a rendered preview toggle.
 */
export type EditorFileKind = 'text' | MediaKind

/** Text files with a rendered preview: `code` is the source, `preview` the rendering. */
export type EditorViewMode = 'code' | 'preview'

function extensionOf(filePath: string): string {
  const name = basename(filePath)
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0) return ''
  return name.slice(dotIndex + 1).toLowerCase()
}

export function editorFileKindForPath(filePath: string): EditorFileKind {
  if (extensionOf(filePath) === 'svg') return 'text'
  return mediaKindForPath(filePath) ?? 'text'
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'css',
  html: 'html',
  htm: 'html',
  astro: 'astro',
  md: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
  py: 'python',
  rs: 'rust',
  go: 'go',
  toml: 'toml'
}

export function detectLanguage(filePath: string): string {
  const ext = extensionOf(filePath)
  return Object.hasOwn(LANGUAGE_BY_EXTENSION, ext) ? LANGUAGE_BY_EXTENSION[ext] : ''
}

/** The rendered preview a text file offers next to its source, if any. */
export function textPreviewForPath(filePath: string): 'markdown' | 'svg' | null {
  const ext = extensionOf(filePath)
  if (ext === 'md') return 'markdown'
  if (ext === 'svg') return 'svg'
  return null
}

export function getDefaultViewMode(filePath: string): EditorViewMode {
  return textPreviewForPath(filePath) ? 'preview' : 'code'
}
