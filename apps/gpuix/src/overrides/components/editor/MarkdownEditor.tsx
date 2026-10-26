/**
 * GPUIX twin of `components/editor/MarkdownEditor.tsx` (the toolbar's
 * "Preview" mode). BlockNote is a contentEditable editor and GPUIX 0.11 has
 * no rich-text element, so Preview here is native rendering laid out like the
 * web document column: each heading is a text box sized like BlockNote's, and
 * the blocks under it are one `<markdown>` (`editor/markdown-sections.ts`).
 * The outline beside it is the shared `TocPanel`, fed the body's headings;
 * a heading click scrolls its box to the top, and the heading at the top of
 * the viewport is the active one. Frontmatter stays editable through the
 * shared `FrontmatterProperties`. A click on the rendered body switches the
 * file to Source, where the native code editor edits it. Mermaid fences
 * render as their source, with a note.
 */

import { type EventPayload, type KeyEvent, type PublicInstance, useGpuix } from '@gpuix/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorTocLayout } from '@/components/editor/EditorTocLayout'
import { FrontmatterProperties } from '@/components/editor/FrontmatterProperties'
import { TocPanel, type TocVariant } from '@/components/editor/TocPanel'
import type { VisibleLineRange } from '@/hooks/use-codemirror'
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
import { type MarkdownSection, splitMarkdownSections } from '../../../editor/markdown-sections'
import { tw } from '../../../style/tw'

interface MarkdownEditorProps {
  filePath: string
  content: string
  isVisible: boolean
  readOnly?: boolean
  onChange: (content: string) => void
}

const REM = 16
/** `--markdown-document-width`. */
const DOCUMENT_WIDTH = 48 * REM
/** BlockNote's `--level` per heading level, in em of the 1rem document text. */
const HEADING_EM = [3, 2, 1.3, 1, 0.9, 0.8]
const HEADING_LINE_HEIGHT = 1.25
/** index.css `.markdown-editor` heading `letter-spacing`, in em. */
const HEADING_TRACKING = -0.018
const TEXT_LINE_HEIGHT = 1.6
/** `.bn-block-content` padding; a paragraph's is twice that. */
const BLOCK_PAD = 0.16 * REM
/**
 * BlockNote's heading margins (1.75rem / 0.35rem) and document top padding
 * (2.25rem), less what the native text boxes add over the web line boxes:
 * these land the matrix guide's headings and paragraphs within 1 px of the
 * web rows (editor.markdown, c-open).
 */
const HEADING_MARGIN_TOP = 1.75 * REM - 1
const HEADING_MARGIN_BOTTOM = 0.35 * REM - 2
const DOCUMENT_PADDING_TOP = 2.25 * REM - 12
/** Only the heading's top edge counts as reached: a jump lands it exactly at the top. */
const ACTIVE_SLOP = 4
const SCROLL_SETTLE_MS = 50
const MERMAID_FENCE = /^```\s*mermaid\b/m

/**
 * `--markdown-document-gutter`: `clamp(1.25rem, 5cqi, 3.5rem)`. The 1rem
 * container-query override never reaches the web document: a container query
 * cannot restyle its own container, and the variable is set on it.
 */
function documentGutter(columnWidth: number): number {
  return Math.min(3.5 * REM, Math.max(1.25 * REM, columnWidth * 0.05))
}

function headingStyle(level: number, first: boolean) {
  const size = REM * (HEADING_EM[Math.min(level, 6) - 1] ?? 1)
  return {
    ...tw('text-foreground'),
    fontSize: size,
    lineHeight: size * HEADING_LINE_HEIGHT,
    fontWeight: 650,
    letterSpacing: HEADING_TRACKING,
    marginTop: first ? 0 : HEADING_MARGIN_TOP,
    marginBottom: HEADING_MARGIN_BOTTOM,
    paddingTop: BLOCK_PAD,
    paddingBottom: BLOCK_PAD
  }
}

export function MarkdownEditor({
  filePath,
  content,
  isVisible,
  readOnly = false,
  onChange
}: MarkdownEditorProps): React.JSX.Element {
  const parsed = useMemo(() => splitFrontmatter(content), [content])
  const sections = useMemo(() => splitMarkdownSections(parsed.body), [parsed.body])
  const renderer = useGpuix().renderer
  const scrollerRef = useRef<PublicInstance | null>(null)
  const headingRefs = useRef(new Map<number, PublicInstance>())
  const [columnWidth, setColumnWidth] = useState(0)
  const [visibleRange, setVisibleRange] = useState<VisibleLineRange | undefined>()

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

  /** Each heading's top relative to the viewport's top, in document order. */
  const headingOffsets = useCallback((): Array<{ line: number; top: number }> => {
    const scroller = scrollerRef.current
    const box = scroller && renderer?.getElementBounds?.(scroller.id)
    if (!box) return []
    const offsets: Array<{ line: number; top: number }> = []
    for (const section of sections) {
      const node = section.heading ? headingRefs.current.get(section.line) : undefined
      const bounds = node && renderer?.getElementBounds?.(node.id)
      if (bounds) offsets.push({ line: section.line, top: bounds.y - box.y })
    }
    return offsets
  }, [renderer, sections])

  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updateActiveHeading = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => {
      const reached = headingOffsets().filter((offset) => offset.top <= ACTIVE_SLOP)
      const line = reached.at(-1)?.line ?? 1
      setVisibleRange((previous) =>
        previous?.startLine === line ? previous : { startLine: line, endLine: line }
      )
    }, SCROLL_SETTLE_MS)
  }, [headingOffsets])
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current)
    },
    []
  )

  const scrollToLine = useCallback(
    (line: number) => {
      const scroller = scrollerRef.current
      const target = headingOffsets().find((offset) => offset.line === line)
      if (!scroller || !target || !renderer?.scrollTo) return
      const scrollTop = -(renderer.getScrollOffset?.(scroller.id)?.[1] ?? 0)
      // `scrollTo` sets the native offset, which is negative once the content has moved up.
      renderer.scrollTo(scroller.id, 0, -Math.max(0, scrollTop + target.top))
      updateActiveHeading()
    },
    [headingOffsets, renderer, updateActiveHeading]
  )

  const themeId = useColorTheme()
  const theme = useMemo(() => {
    const prose = transcriptThemes(themeId).prose
    return {
      ...prose,
      metrics: {
        ...prose.metrics,
        mdTextSize: REM,
        mdLineHeight: REM * TEXT_LINE_HEIGHT,
        mdBlockGap: 4 * BLOCK_PAD
      }
    }
  }, [themeId])

  const gutter = documentGutter(columnWidth)
  const renderSection = (section: MarkdownSection, index: number) => (
    <div key={`${section.line}:${index}`} style={{ display: 'flex', flexDirection: 'column' }}>
      {section.heading ? (
        <text
          ref={(node: PublicInstance | null) => {
            if (node) headingRefs.current.set(section.line, node)
            else headingRefs.current.delete(section.line)
          }}
          style={headingStyle(section.heading.level, index === 0)}
        >
          {section.heading.text}
        </text>
      ) : null}
      {section.body.trim() ? (
        <div style={{ paddingTop: 2 * BLOCK_PAD, paddingBottom: 2 * BLOCK_PAD }}>
          <markdown source={section.body} theme={theme} />
        </div>
      ) : null}
    </div>
  )

  return (
    <EditorTocLayout
      isVisible={isVisible}
      renderOutline={(variant: TocVariant) => (
        <TocPanel
          variant={variant}
          filePath={filePath}
          editorMode="codemirror"
          codemirror={{
            content: parsed.body,
            scrollToLine,
            visibleRange,
            scrollElement: null,
            isLoading: false
          }}
        />
      )}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: GPUIX has no <button>; the scroll container is the click target */}
      <div
        ref={scrollerRef}
        testId="markdown-preview"
        style={{
          ...tw('h-full min-w-0 flex-1 bg-background'),
          overflow: 'scroll',
          scrollbarColor: '#ffffff22'
        }}
        role="button"
        aria-label="Edit source"
        tabIndex={0}
        onClick={editSource}
        onLayout={(event: EventPayload) => {
          if (event.width !== undefined && event.width !== columnWidth) setColumnWidth(event.width)
        }}
        onScrollChange={updateActiveHeading}
        onKeyDown={(event: KeyEvent) => {
          if (event.key === 'enter' || event.key === 'space') editSource()
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingBottom: 5 * REM
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
              maxWidth: DOCUMENT_WIDTH + 2 * gutter,
              paddingLeft: gutter,
              paddingRight: gutter,
              paddingTop: DOCUMENT_PADDING_TOP,
              paddingBottom: REM,
              cursor: 'text'
            }}
          >
            {MERMAID_FENCE.test(parsed.body) ? (
              <text style={{ ...tw('text-xs text-muted-foreground'), marginBottom: 12 }}>
                Mermaid diagrams show as source in this client.
              </text>
            ) : null}
            {sections.map(renderSection)}
          </div>
        </div>
      </div>
    </EditorTocLayout>
  )
}
