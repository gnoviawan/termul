import { useEffect, useMemo, useRef, useState } from 'react'
import { useBlockNoteActiveHeading, useCodeMirrorActiveHeading } from '@/hooks/use-active-heading'
import type { VisibleLineRange } from '@/hooks/use-codemirror'
import { filterTocHeadings, type TocHeading, useTocHeadings } from '@/hooks/use-toc-headings'
import { useTocSettingsStore } from '@/stores/toc-settings-store'
import { TableOfContents } from './TableOfContents'

interface BlockNoteTocApi {
  getHeadings: () => TocHeading[]
  scrollToBlock: (blockId: string) => void
}

interface CodeMirrorTocApi {
  content: string
  scrollToLine: (lineNumber: number) => void
  visibleRange?: VisibleLineRange
}

type TocPanelProps =
  | {
      editorMode: 'blocknote'
      blocknote: BlockNoteTocApi
      container: HTMLElement | null
    }
  | {
      editorMode: 'codemirror'
      codemirror: CodeMirrorTocApi
    }

export function TocPanel(props: TocPanelProps): React.JSX.Element {
  const maxHeadingLevel = useTocSettingsStore((state) => state.settings.maxHeadingLevel)
  const setMaxHeadingLevel = useTocSettingsStore((state) => state.setMaxHeadingLevel)
  const [selectedHeadingId, setSelectedHeadingId] = useState<string | undefined>()

  const blockNoteHeadings = useMemo(() => {
    if (props.editorMode !== 'blocknote') {
      return []
    }

    return filterTocHeadings(props.blocknote.getHeadings(), maxHeadingLevel)
  }, [maxHeadingLevel, props])

  const codeMirrorHeadingsResult = useTocHeadings({
    content: props.editorMode === 'codemirror' ? props.codemirror.content : '',
    maxLevel: maxHeadingLevel
  })

  const headings =
    props.editorMode === 'blocknote' ? blockNoteHeadings : codeMirrorHeadingsResult.headings

  const blockNoteActiveHeadingId = useBlockNoteActiveHeading({
    headings: props.editorMode === 'blocknote' ? blockNoteHeadings : [],
    container: props.editorMode === 'blocknote' ? props.container : null,
    isEnabled: props.editorMode === 'blocknote'
  })

  const codeMirrorActiveHeadingId = useCodeMirrorActiveHeading({
    headings: props.editorMode === 'codemirror' ? codeMirrorHeadingsResult.headings : [],
    visibleRange: props.editorMode === 'codemirror' ? props.codemirror.visibleRange : undefined
  })

  const scrollActiveHeadingId =
    props.editorMode === 'blocknote' ? blockNoteActiveHeadingId : codeMirrorActiveHeadingId

  const prevScrollRef = useRef(scrollActiveHeadingId)

  // When the scroll-based active heading changes after a click, clear the optimistic selection
  useEffect(() => {
    if (!selectedHeadingId) {
      prevScrollRef.current = scrollActiveHeadingId
      return
    }

    if (scrollActiveHeadingId !== prevScrollRef.current) {
      prevScrollRef.current = scrollActiveHeadingId
      setSelectedHeadingId(undefined)
    }
  }, [scrollActiveHeadingId, selectedHeadingId])

  const activeHeadingId = selectedHeadingId ?? scrollActiveHeadingId

  const handleHeadingClick = (heading: TocHeading): void => {
    if (props.editorMode === 'blocknote') {
      if (heading.blockId) {
        setSelectedHeadingId(heading.id)
        props.blocknote.scrollToBlock(heading.blockId)
      }
      return
    }

    if (heading.line) {
      setSelectedHeadingId(heading.id)
      props.codemirror.scrollToLine(heading.line)
    }
  }

  return (
    <TableOfContents
      headings={headings}
      activeHeadingId={activeHeadingId}
      maxHeadingLevel={maxHeadingLevel}
      onHeadingClick={handleHeadingClick}
      onMaxHeadingLevelChange={setMaxHeadingLevel}
    />
  )
}
