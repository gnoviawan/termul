import { codeBlockOptions } from '@blocknote/code-block'
import {
  BlockNoteEditor,
  BlockNoteSchema,
  createCodeBlockSpec,
  createExtension,
  defaultBlockSpecs
} from '@blocknote/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { mermaidBlockSpec } from '@/components/editor/mermaid-block-spec'
import { areTocHeadingsEqual, type TocHeading } from '@/hooks/use-toc-headings'
import { requestSaveEditorFile } from '@/lib/editor-save'

function convertMermaidBlocks(
  blocks: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return blocks.map((block) => {
    if (
      block.type === 'codeBlock' &&
      (block.props as Record<string, string> | undefined)?.language === 'mermaid'
    ) {
      const source = Array.isArray(block.content)
        ? block.content
            .map((c: Record<string, unknown>) => {
              if (c.type === 'text') return String(c.text ?? '')
              if (c.type === 'hardBreak') return '\n'
              return ''
            })
            .join('')
        : ''
      return {
        ...block,
        type: 'mermaid',
        props: { source },
        content: undefined
      }
    }
    if (Array.isArray(block.children) && block.children.length > 0) {
      return {
        ...block,
        children: convertMermaidBlocks(block.children as Array<Record<string, unknown>>)
      }
    }
    return block
  })
}

interface UseBlockNoteOptions {
  filePath: string
  initialMarkdown: string
  onChange: (markdown: string) => void
}

interface UseBlockNoteResult {
  editor: BlockNoteEditor<any, any, any>
  replaceContent: (markdown: string) => void
  flushPendingContent: () => Promise<void>
  /** Capture current body markdown without calling onChange (clears debounce). */
  capturePendingContent: () => Promise<string | null>
  /** Heading blocks. Keeps the same array while ids, levels and text stay the same. */
  headings: TocHeading[]
  scrollToBlock: (blockId: string) => void
}

/** Nearest ancestor whose overflow-y lets the user scroll it and that overflows. */
function findScrollContainer(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement
  while (node) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node
    }
    node = node.parentElement
  }
  return null
}

export function useBlockNote(options: UseBlockNoteOptions): UseBlockNoteResult {
  const onChangeRef = useRef(options.onChange)
  const filePathRef = useRef(options.filePath)
  const initialMarkdownRef = useRef(options.initialMarkdown)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Guard to suppress onChange during programmatic replaceBlocks calls
  const isReplacingRef = useRef(false)
  // Incrementing token to discard stale replace results
  const replaceTokenRef = useRef(0)

  onChangeRef.current = options.onChange
  filePathRef.current = options.filePath

  const saveShortcutExtension = useMemo(
    () =>
      createExtension(() => ({
        key: 'termulSaveShortcut',
        keyboardShortcuts: {
          'Mod-s': () => {
            void requestSaveEditorFile(filePathRef.current)
            return true
          }
        }
      }))(),
    []
  )

  const editor = useMemo(() => {
    const schema = BlockNoteSchema.create({
      blockSpecs: {
        ...defaultBlockSpecs,
        codeBlock: createCodeBlockSpec(codeBlockOptions),
        mermaid: mermaidBlockSpec()
      }
    })
    return BlockNoteEditor.create({
      schema,
      extensions: [saveShortcutExtension]
    })
  }, [saveShortcutExtension])

  const [headings, setHeadings] = useState<TocHeading[]>([])
  const refreshHeadings = useCallback((): void => {
    // Non-empty heading blocks at the top level of the document.
    const next: TocHeading[] = editor.document.flatMap((block) => {
      if (block.type !== 'heading') {
        return []
      }

      const level = typeof block.props.level === 'number' ? block.props.level : 1
      const text = block.content
        .flatMap((inlineContent) => {
          if (inlineContent.type === 'text') {
            return [inlineContent.text]
          }

          return []
        })
        .join('')
        .trim()

      if (!text) {
        return []
      }

      return [
        {
          id: block.id,
          blockId: block.id,
          level,
          text
        }
      ]
    })
    setHeadings((previous) => (areTocHeadingsEqual(previous, next) ? previous : next))
  }, [editor])

  const runReplace = useCallback(
    async (markdown: string, token: number): Promise<void> => {
      try {
        isReplacingRef.current = true
        const blocks = await editor.tryParseMarkdownToBlocks(markdown)
        if (token !== replaceTokenRef.current) return
        const processedBlocks = convertMermaidBlocks(blocks as Array<Record<string, unknown>>)
        if (token !== replaceTokenRef.current) return
        editor.replaceBlocks(editor.document, processedBlocks)
        refreshHeadings()
      } catch {
        // Failed to parse markdown
      } finally {
        if (token === replaceTokenRef.current) {
          requestAnimationFrame(() => {
            isReplacingRef.current = false
          })
        }
      }
    },
    [editor, refreshHeadings]
  )

  // Load initial markdown content
  // biome-ignore lint/correctness/useExhaustiveDependencies: editor identity is stable; deps track content only
  useEffect(() => {
    const token = ++replaceTokenRef.current
    void runReplace(initialMarkdownRef.current, token)
  }, [editor, runReplace])

  // Set up change listener
  useEffect(() => {
    const unsubscribe = editor.onChange(async () => {
      // The outline follows every edit; `runReplace` refreshes it after a replace.
      refreshHeadings()
      // Skip onChange events triggered by programmatic content replacement
      if (isReplacingRef.current) return

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      debounceTimerRef.current = setTimeout(async () => {
        if (isReplacingRef.current) return
        try {
          const markdown = await editor.blocksToMarkdownLossy(editor.document)
          onChangeRef.current(markdown)
        } catch {
          // Failed to convert to markdown
        }
      }, 300)
    })

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      if (typeof unsubscribe === 'function') {
        unsubscribe()
      }
    }
  }, [editor, refreshHeadings])

  const replaceContent = useCallback(
    async (markdown: string) => {
      const token = ++replaceTokenRef.current
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      await runReplace(markdown, token)
    },
    [runReplace]
  )

  const capturePendingContent = useCallback(async (): Promise<string | null> => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    if (isReplacingRef.current) return null
    try {
      return await editor.blocksToMarkdownLossy(editor.document)
    } catch {
      return null
    }
  }, [editor])

  const flushPendingContent = useCallback(async (): Promise<void> => {
    const markdown = await capturePendingContent()
    if (markdown === null) return
    onChangeRef.current(markdown)
  }, [capturePendingContent])

  const scrollToBlock = useCallback(
    (blockId: string): void => {
      const targetElement = editor.domElement?.querySelector<HTMLElement>(
        `[data-node-type="blockContainer"][data-id="${CSS.escape(blockId)}"]`
      )

      if (!targetElement) {
        return
      }

      try {
        editor.setTextCursorPosition(blockId, 'start')
        editor.focus()

        requestAnimationFrame(() => {
          try {
            // Scroll only the editor's own scroller. `scrollIntoView` also
            // scrolls every clipping ancestor, and an `overflow-hidden`
            // shell (the workspace <main> card) then shifts up and crops
            // the tab bar with no way for the user to scroll it back.
            const scroller = findScrollContainer(targetElement)
            if (!scroller) {
              return
            }
            const offset =
              targetElement.getBoundingClientRect().top - scroller.getBoundingClientRect().top
            scroller.scrollTo({ top: scroller.scrollTop + offset, behavior: 'smooth' })
          } catch {
            console.error('Failed to scroll TOC heading into view')
          }
        })
      } catch {
        console.error('Failed to focus TOC heading block')
      }
    },
    [editor]
  )

  return {
    editor,
    replaceContent,
    flushPendingContent,
    capturePendingContent,
    headings,
    scrollToBlock
  }
}
