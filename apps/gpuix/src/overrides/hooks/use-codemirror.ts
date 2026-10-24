/**
 * GPUIX twin of `hooks/use-codemirror.ts`. The workspace editor tab no longer
 * reaches this hook (its `CodeEditor` override paints the native `CodeView`).
 * What remains: the boot-time language preload, the shared `VisibleLineRange`
 * type, and `useCodeMirror` for the remote SFTP editor, which mounts into a
 * DOM container GPUIX cannot host, so it reports itself unavailable.
 */

import { useEffect, useMemo } from 'react'
import { logFrontendError } from '@/lib/log-api'
import { loadLanguage } from '../../editor/languages'

export interface VisibleLineRange {
  startLine: number
  endLine: number
}

let preloaded = false

export function preloadCommonLanguages(): void {
  if (preloaded) return
  preloaded = true
  for (const language of ['javascript', 'typescript', 'json']) void loadLanguage(language)
}

interface UseCodeMirrorOptions {
  filePath: string
  content: string
  language: string
  readOnly?: boolean
  onChange: (content: string) => void
  onCursorChange: (line: number, col: number) => void
  onScrollChange: (scrollTop: number) => void
  onVisibleRangeChange?: (range: VisibleLineRange) => void
  onSave?: (content: string) => void
}

interface UseCodeMirrorResult {
  view: null
  isReady: boolean
  setContent: (content: string) => void
  flushPendingContent: () => void
  scrollToLine: (lineNumber: number, highlightTerm?: string) => void
  restoreViewState: (lineNumber: number, column: number, scrollTop: number) => void
  getVisibleLineRange: () => VisibleLineRange | null
}

const noop = (): void => {}

export function useCodeMirror(
  _containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseCodeMirrorOptions
): UseCodeMirrorResult {
  useEffect(() => {
    void logFrontendError({
      level: 'warn',
      source: 'use-codemirror.gpuix',
      message: `DOM-hosted editor unavailable on GPUIX path=${options.filePath}`
    })
  }, [options.filePath])
  return useMemo(
    () => ({
      view: null,
      isReady: false,
      setContent: noop,
      flushPendingContent: noop,
      scrollToLine: noop,
      restoreViewState: noop,
      getVisibleLineRange: () => null
    }),
    []
  )
}
