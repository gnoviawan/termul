import { useRef, useEffect, useMemo, useCallback } from 'react'
import {
  BlockNoteEditor,
  BlockNoteSchema,
  defaultBlockSpecs,
  createCodeBlockSpec
} from '@blocknote/core'
import { codeBlockOptions } from '@blocknote/code-block'

interface UseBlockNoteOptions {
  initialMarkdown: string
  onChange: (markdown: string) => void
}

interface UseBlockNoteResult {
  editor: BlockNoteEditor
  replaceContent: (markdown: string) => void
}

export function useBlockNote(options: UseBlockNoteOptions): UseBlockNoteResult {
  const onChangeRef = useRef(options.onChange)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Guard to suppress onChange during programmatic replaceBlocks calls
  const isReplacingRef = useRef(false)

  onChangeRef.current = options.onChange

  const editor = useMemo(() => {
    const schema = BlockNoteSchema.create({
      blockSpecs: {
        ...defaultBlockSpecs,
        codeBlock: createCodeBlockSpec(codeBlockOptions)
      }
    })
    return BlockNoteEditor.create({ schema })
  }, [])

  // Load initial markdown content
  useEffect(() => {
    const loadContent = async (): Promise<void> => {
      try {
        isReplacingRef.current = true
        const blocks = await editor.tryParseMarkdownToBlocks(options.initialMarkdown)
        editor.replaceBlocks(editor.document, blocks)
      } catch {
        // Failed to parse markdown
      } finally {
        // Delay clearing the flag so the onChange triggered by replaceBlocks is suppressed
        requestAnimationFrame(() => {
          isReplacingRef.current = false
        })
      }
    }
    loadContent()
  }, [])

  // Set up change listener
  useEffect(() => {
    const unsubscribe = editor.onChange(async () => {
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
  }, [editor])

  const replaceContent = useCallback(async (markdown: string) => {
    try {
      isReplacingRef.current = true
      const blocks = await editor.tryParseMarkdownToBlocks(markdown)
      editor.replaceBlocks(editor.document, blocks)
    } catch {
      // Failed to parse markdown
    } finally {
      requestAnimationFrame(() => {
        isReplacingRef.current = false
      })
    }
  }, [editor])

  return { editor, replaceContent }
}
