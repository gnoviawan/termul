import { useMemo } from 'react'
import { TableOfContents } from './TableOfContents'
import { useTocHeadings, filterTocHeadings, type TocHeading } from '@/hooks/use-toc-headings'
import { useBlockNoteActiveHeading, useCodeMirrorActiveHeading } from '@/hooks/use-active-heading'
import { useTocSettingsStore } from '@/stores/toc-settings-store'
import type { VisibleLineRange } from '@/hooks/use-codemirror'

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

  const headings = props.editorMode === 'blocknote' ? blockNoteHeadings : codeMirrorHeadingsResult.headings

  const blockNoteActiveHeadingId = useBlockNoteActiveHeading({
    headings: props.editorMode === 'blocknote' ? blockNoteHeadings : [],
    container: props.editorMode === 'blocknote' ? props.container : null,
    isEnabled: props.editorMode === 'blocknote'
  })

  const codeMirrorActiveHeadingId = useCodeMirrorActiveHeading({
    headings: props.editorMode === 'codemirror' ? codeMirrorHeadingsResult.headings : [],
    visibleRange: props.editorMode === 'codemirror' ? props.codemirror.visibleRange : undefined
  })

  const activeHeadingId = props.editorMode === 'blocknote' ? blockNoteActiveHeadingId : codeMirrorActiveHeadingId

  const handleHeadingClick = (heading: TocHeading): void => {
    if (props.editorMode === 'blocknote') {
      if (heading.blockId) {
        props.blocknote.scrollToBlock(heading.blockId)
      }
      return
    }

    if (heading.line) {
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
