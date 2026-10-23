/**
 * GPUIX override of `components/chat/ThoughtGroup.tsx`.
 *
 * Same disclosure as the web: a "Thought · N lines" row that opens while the
 * group streams at the live tail and collapses once tools or the reply follow,
 * then stays where the reader put it. The web body is a 200px inner scroller
 * that follows its own live edge. GPUIX has no nested vertical scrolling
 * inside the transcript list, so the collapsed body is a 200px window that
 * shows the newest lines (bottom-aligned clip) and More/Less toggles the full
 * text, which the outer list then scrolls.
 */

import { memo, useEffect, useRef, useState } from 'react'
import { Brain, ChevronDown, ChevronRight, Maximize2, Minimize2 } from '@/components/icons'
import type { ContentBlock } from '@/lib/acp-api'
import type { ChatMessage } from '@/stores/acp-store'
import { useColorTheme } from '@/stores/app-settings-store'
import { transcriptThemes } from '../../../chat/theme'
import { tw } from '../../../style/tw'

const COLLAPSED_MAX_H = 200
/** `text-xs` at 16px leading: past this many lines the 200px box clips. */
const CLIP_LINES = Math.floor(COLLAPSED_MAX_H / 16)

function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

function thoughtTexts(messages: ChatMessage[]): string {
  return messages
    .map((m) => blocksToText(m.blocks))
    .filter((t) => t.length > 0)
    .join('\n\n')
}

/** The web's `thoughtMarkdown`: a bold-only line is its own paragraph, other newlines are breaks. */
function thoughtMarkdown(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      if (part.startsWith('```')) return part
      const withTitleBreaks = part.replace(/([^\n])\n(\*\*[^*\n]+\*\*[ \t]*)$/gm, '$1\n\n$2')
      return withTitleBreaks.replace(/([^\n])\n(?!\n)/g, '$1  \n')
    })
    .join('')
}

interface ThoughtGroupProps {
  messages: ChatMessage[]
  isLiveTail: boolean
}

const TRIGGER = tw('flex w-full min-h-7 cursor-pointer items-center gap-1')
const MARKER = tw('flex min-w-0 flex-1 items-center gap-2 text-xs font-medium text-muted-foreground')
const LABEL = tw('text-xs font-medium text-muted-foreground')
const COUNT = tw('text-xs font-normal text-muted-foreground')
const TOGGLE = tw('mt-1 flex min-h-10 cursor-pointer items-center gap-1 self-start px-1 hover:text-foreground')

function ThoughtGroupComponent({ messages, isLiveTail }: ThoughtGroupProps) {
  const themes = transcriptThemes(useColorTheme())
  const isStreaming = isLiveTail && messages.some((m) => m.streaming)
  const text = thoughtTexts(messages)
  const lines = text.split('\n').filter((l) => l.trim().length > 0).length

  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const userOverride = useRef(false)

  useEffect(() => {
    if (userOverride.current) return
    setOpen(isStreaming)
  }, [isStreaming])

  useEffect(() => {
    if (!open) setExpanded(false)
  }, [open])

  const overflows = lines > CLIP_LINES || text.length > CLIP_LINES * 90
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div style={tw('flex flex-col pt-2')} testId="thought-group">
      <div
        testId="thought-group-trigger"
        role="button"
        aria-expanded={open}
        style={TRIGGER}
        onClick={() => {
          userOverride.current = true
          setOpen((value) => !value)
        }}
      >
        <div style={MARKER}>
          <Brain size={14} className="text-muted-foreground" />
          <div style={tw('flex min-w-0 flex-1 flex-row items-center')}>
            <text style={LABEL}>{isStreaming ? 'Thinking…' : 'Thought'}</text>
            {lines > 0 ? <text style={COUNT}>{` · ${lines} line${lines === 1 ? '' : 's'}`}</text> : null}
          </div>
        </div>
        <Chevron size={13} className="shrink-0 text-muted-foreground" />
      </div>
      {open ? (
        <div style={tw('mt-1.5 flex flex-col pb-2 pl-3')} testId="thought-group-body">
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              overflow: 'hidden',
              ...(expanded ? {} : { maxHeight: COLLAPSED_MAX_H })
            }}
          >
            <markdown source={thoughtMarkdown(text)} theme={themes.thought} style={{ flexShrink: 0, minWidth: 0 }} />
          </div>
          {expanded || overflows ? (
            <div
              role="button"
              aria-label={expanded ? 'Collapse thinking' : 'Expand all thinking'}
              style={TOGGLE}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? (
                <Minimize2 size={12} className="text-muted-foreground" />
              ) : (
                <Maximize2 size={12} className="text-muted-foreground" />
              )}
              <text style={tw('text-xs text-muted-foreground')}>{expanded ? 'Less' : 'More'}</text>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export const ThoughtGroup = memo(ThoughtGroupComponent)
