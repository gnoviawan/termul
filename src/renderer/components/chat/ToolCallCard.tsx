import { memo } from 'react'
import { cn } from '@/lib/utils'
import {
  FileText,
  FilePen,
  Trash2,
  FolderInput,
  Search,
  TerminalSquare,
  Brain,
  Globe,
  Shuffle,
  Wrench,
  Loader2,
  type LucideIcon
} from 'lucide-react'
import { DiffPreview } from './DiffPreview'
import { kindIcon, statusStyle, type ToolIconName } from './tool-call-format'
import type { ToolCall, ToolCallContent, ContentBlock } from '@/lib/acp-api'

const ICONS: Record<ToolIconName, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  delete: Trash2,
  move: FolderInput,
  search: Search,
  execute: TerminalSquare,
  think: Brain,
  fetch: Globe,
  switch: Shuffle,
  tool: Wrench
}

function renderContentBlock(block: ContentBlock, key: number): React.JSX.Element {
  if (block.type === 'text') {
    return (
      <div key={key} className="whitespace-pre-wrap break-words text-xs text-foreground/90">
        {block.text ?? ''}
      </div>
    )
  }
  return (
    <div key={key} className="text-xs italic text-muted-foreground">
      [{block.type}]
    </div>
  )
}

function renderContentItem(item: ToolCallContent, key: number): React.JSX.Element {
  if (item.type === 'diff') {
    const d = item as { path: string; oldText?: string | null; newText: string }
    return (
      <DiffPreview
        key={key}
        diff={{ path: d.path, oldText: d.oldText ?? null, newText: d.newText }}
      />
    )
  }
  if (item.type === 'content') {
    const c = item as { content?: ContentBlock }
    return c.content ? (
      renderContentBlock(c.content, key)
    ) : (
      <div key={key} className="text-xs italic text-muted-foreground">
        [content]
      </div>
    )
  }
  if (item.type === 'terminal') {
    return (
      <div key={key} className="rounded border border-border/40 px-2 py-1 text-xs text-muted-foreground">
        [terminal output]
      </div>
    )
  }
  return (
    <div key={key} className="text-xs italic text-muted-foreground">
      [{item.type}]
    </div>
  )
}

interface ToolCallCardProps {
  toolCall: ToolCall
}

function ToolCallCardComponent({ toolCall }: ToolCallCardProps): React.JSX.Element {
  const Icon = ICONS[kindIcon(toolCall.kind)]
  const status = statusStyle(toolCall.status)
  const content = toolCall.content ?? []

  return (
    <div className="mx-4 my-2 rounded-md border border-border/50 bg-card/40">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Icon size={13} className="shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium text-foreground">
          {toolCall.title ?? toolCall.kind ?? 'Tool call'}
        </span>
        <span
          className={cn(
            'ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
            status.className
          )}
        >
          {status.spinning && <Loader2 size={9} className="animate-spin motion-reduce:animate-none" />}
          {status.label}
        </span>
      </div>
      {content.length > 0 && (
        <div className="flex flex-col gap-1.5 px-3 pb-2">
          {content.map((item, i) => renderContentItem(item, i))}
        </div>
      )}
    </div>
  )
}

export const ToolCallCard = memo(ToolCallCardComponent)
