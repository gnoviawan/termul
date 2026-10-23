/**
 * GPUIX twin of `components/editor/MarkdownEditor.tsx` (the toolbar's
 * "Preview" mode). BlockNote is a contentEditable editor and GPUIX 0.11 has
 * no rich-text element, so Preview here is the native `<markdown>` rendering
 * of the body, laid out like the web document column. Frontmatter stays
 * editable through the shared `FrontmatterProperties`. A click on the
 * rendered body switches the file to Source, where the native code editor
 * edits it. Mermaid fences render as their source, with a note.
 */

import type { KeyEvent } from '@gpuix/react'
import { useCallback, useEffect, useMemo } from 'react'
import { FrontmatterProperties } from '@/components/editor/FrontmatterProperties'
import {
  registerEditorContentFlusher,
  unregisterEditorContentFlusher
} from '@/lib/editor-content-flush'
import { logFrontendError } from '@/lib/log-api'
import {
  composeFullMarkdown,
  type FrontmatterMap,
  splitFrontmatter
} from '@/lib/markdown-frontmatter'
import { useColorTheme } from '@/stores/app-settings-store'
import { useEditorStore } from '@/stores/editor-store'
import { transcriptThemes } from '../../../chat/theme'
import { tw } from '../../../style/tw'

interface MarkdownEditorProps {
  filePath: string
  content: string
  isVisible: boolean
  readOnly?: boolean
  onChange: (content: string) => void
}

const DOCUMENT_WIDTH = 768
const DOCUMENT_GUTTER = 40
const MERMAID_FENCE = /^```\s*mermaid\b/m

export function MarkdownEditor({
  filePath,
  content,
  isVisible,
  readOnly = false,
  onChange
}: MarkdownEditorProps): React.JSX.Element {
  const parsed = useMemo(() => splitFrontmatter(content), [content])

  // Nothing is buffered here: every edit already went to the store.
  useEffect(() => {
    registerEditorContentFlusher(filePath, () => {})
    return () => unregisterEditorContentFlusher(filePath)
  }, [filePath])

  const onFrontmatterChange = useCallback(
    (next: FrontmatterMap) => {
      if (readOnly) return
      const full = composeFullMarkdown(true, next, parsed.body)
      if (full !== null) onChange(full)
    },
    [onChange, parsed.body, readOnly]
  )

  const editSource = useCallback(() => {
    if (!isVisible) return
    void logFrontendError({
      level: 'info',
      source: 'gpuix-editor.markdown',
      message: 'preview click switches to source'
    })
    useEditorStore.getState().setViewMode(filePath, 'code')
  }, [filePath, isVisible])

  const themeId = useColorTheme()
  const theme = useMemo(() => {
    const prose = transcriptThemes(themeId).prose
    return {
      ...prose,
      metrics: {
        ...prose.metrics,
        mdTextSize: 16,
        mdLineHeight: 25.6,
        mdHeadingSizes: [32, 24, 20, 17.6],
        mdHeadingLineHeights: [40, 30, 25, 22]
      }
    }
  }, [themeId])

  return (
    // biome-ignore lint/a11y/useSemanticElements: GPUIX has no <button>; the scroll container is the click target
    <div
      testId="markdown-preview"
      style={{
        ...tw('h-full w-full bg-background'),
        overflow: 'scroll',
        scrollbarColor: '#ffffff22'
      }}
      role="button"
      aria-label="Edit source"
      tabIndex={0}
      onClick={editSource}
      onKeyDown={(event: KeyEvent) => {
        if (event.key === 'enter' || event.key === 'space') editSource()
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingBottom: 80
        }}
      >
        {parsed.hasFrontmatter ? (
          <div style={{ width: '100%', opacity: readOnly ? 0.6 : 1 }}>
            <FrontmatterProperties data={parsed.data} onChange={onFrontmatterChange} />
          </div>
        ) : null}
        <div
          style={{
            width: '100%',
            maxWidth: DOCUMENT_WIDTH + 2 * DOCUMENT_GUTTER,
            paddingLeft: DOCUMENT_GUTTER,
            paddingRight: DOCUMENT_GUTTER,
            paddingTop: 36,
            cursor: 'text'
          }}
        >
          {MERMAID_FENCE.test(parsed.body) ? (
            <text style={{ ...tw('text-xs text-muted-foreground'), marginBottom: 12 }}>
              Mermaid diagrams show as source in this client.
            </text>
          ) : null}
          <markdown source={parsed.body} theme={theme} />
        </div>
      </div>
    </div>
  )
}
