/**
 * A fenced code block as the web paints it through Streamdown's `CodeBlock`
 * with `ChatMarkdownCode`'s actions: a sidebar-tinted card, a lower-case
 * language header, Download and Copy in the top-right group, and the code on
 * the background fill. The code itself is GPUIX's native `<code>`, which
 * highlights in Rust and scrolls horizontally on its own.
 *
 * A finished mermaid fence draws its diagram as Streamdown's mermaid block
 * does, from a PNG the webview helper renders (`mermaid.ts`). While it draws
 * the card keeps the diagram's frame; without the helper, or when mermaid
 * rejects the source, the card shows the source.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { TermulPlanRenderer } from '@/components/chat/ChatMarkdownPlanFence'
import { Check, Copy, Download } from '@/components/icons'
import { IconActionButton, IconActionGroup } from '@/components/ui/icon-action-button'
import { IconSwap } from '@/components/ui/icon-swap'
import { useColorTheme } from '@/stores/app-settings-store'
import { log } from '../log'
import { tw } from '../style/tw'
import { copyText } from '../terminal/clipboard'
import { canDrawMermaid, useMermaid } from './mermaid'
import { transcriptThemes } from './theme'

/** Fence info strings GPUIX's `<code>` has a grammar for, under the alias it expects. */
const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  javascript: 'javascript',
  jsx: 'javascript',
  sh: 'bash',
  shell: 'bash',
  bash: 'bash',
  zsh: 'bash',
  console: 'bash',
  rs: 'rust',
  rust: 'rust',
  py: 'python',
  python: 'python',
  json: 'json',
  jsonc: 'json',
  go: 'go',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  css: 'css',
  html: 'html',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  markdown: 'markdown'
}

const CARD = tw(
  'relative flex w-full flex-col gap-2 rounded-xl border border-border bg-sidebar p-2'
)
const HEADER = tw('flex h-8 items-center text-muted-foreground text-xs')
const HEADER_LABEL = tw('ml-1 font-mono text-xs text-muted-foreground')
const ACTIONS = tw('absolute top-2 right-2 flex items-center')
/** `.chat-streamdown pre`'s `margin-block: 0 0.55em` (7.7px at 14px) sits inside the body's `p-4`. */
const BODY = {
  ...tw('rounded-md border border-border bg-background p-4'),
  paddingBottom: 16 + 0.55 * 14
}
const NOTE = tw('px-1 text-xs text-muted-foreground')
const DIAGRAM_BODY = tw('overflow-hidden rounded-md border border-border bg-background')
/** Streamdown's mermaid frame: at least 7rem tall, the diagram fit to its width and centred. */
const DIAGRAM_STAGE = tw('flex min-h-28 w-full flex-col items-center justify-center')

function downloadsDir(): string {
  return process.env.XDG_DOWNLOAD_DIR || path.join(homedir(), 'Downloads')
}

/** The web downloads `file.<ext>` through a blob link; here it lands in the Downloads folder. */
function saveCode(code: string, language: string): string {
  const ext = language && language !== 'text' ? language : 'txt'
  const dir = downloadsDir()
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `file-${Date.now()}.${ext}`)
  writeFileSync(file, code)
  return file
}

type ActionSize = 'default' | 'sm'

export function CopyAction({
  code,
  disabled,
  size = 'sm'
}: {
  code: string
  disabled: boolean
  size?: ActionSize
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const copy = useCallback(() => {
    if (!code || disabled) return
    copyText(code).then(
      () => {
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1500)
      },
      (error: unknown) => {
        log.warn('chat', `code.copy-failed ${String(error)}`)
        toast.error('Failed to copy')
      }
    )
  }, [code, disabled])
  return (
    <IconActionButton
      label={copied ? 'Copied' : 'Copy'}
      onClick={copy}
      disabled={disabled}
      size={size}
    >
      <IconSwap iconKey={copied}>{copied ? <Check className="text-success" /> : <Copy />}</IconSwap>
    </IconActionButton>
  )
}

export function DownloadAction({
  code,
  language,
  disabled,
  size = 'sm'
}: {
  code: string
  language: string
  disabled: boolean
  size?: ActionSize
}) {
  const download = useCallback(() => {
    if (!code || disabled) return
    try {
      const file = saveCode(code, language)
      log.info('chat', `code.saved ${JSON.stringify({ file, bytes: code.length })}`)
      toast.success(`Saved to ${file}`)
    } catch (error) {
      log.warn('chat', `code.save-failed ${String(error)}`)
      toast.error('Failed to download')
    }
  }, [code, language, disabled])
  return (
    <IconActionButton label="Download" onClick={download} disabled={disabled} size={size}>
      <Download />
    </IconActionButton>
  )
}

export interface CodeCardProps {
  code: string
  /** The fence's info word, lower-cased. */
  language: string
  /** The closing fence has not streamed in yet. */
  open: boolean
  /** The reply is still streaming: actions are disabled, as on the web. */
  streaming: boolean
}

function SourceCard({ code, language, streaming }: Omit<CodeCardProps, 'open'>) {
  const themes = transcriptThemes(useColorTheme())
  const label = language || 'text'
  const grammar = LANGUAGE_ALIASES[label]
  return (
    <div style={CARD} testId="chat-code-card">
      <div style={HEADER}>
        <text style={HEADER_LABEL}>{label}</text>
      </div>
      <div style={ACTIONS}>
        <IconActionGroup>
          <DownloadAction code={code} language={label} disabled={streaming} />
          <CopyAction code={code} disabled={streaming} />
        </IconActionGroup>
      </div>
      <code
        code={code}
        {...(grammar ? { language: grammar } : {})}
        theme={themes.code}
        style={{ ...BODY, ...tw('font-mono text-foreground'), fontSize: 13, lineHeight: 20 }}
      />
      {language === 'mermaid' ? (
        <text style={NOTE}>Mermaid diagrams are shown as source in this client.</text>
      ) : null}
    </div>
  )
}

/** The diagram at its own size, or scaled down to the frame's width. */
function fitted(
  width: number,
  height: number,
  available: number
): { width: number; height: number } {
  const scale = Math.min(1, available / width)
  return { width: width * scale, height: height * scale }
}

function MermaidCard({ code, streaming }: { code: string; streaming: boolean }) {
  const diagram = useMermaid(code)
  // An image needs a definite size; the frame's width decides it, as the web fits the SVG to it.
  const [stageWidth, setStageWidth] = useState(0)
  if (diagram.status === 'done' && !diagram.ok)
    return <SourceCard code={code} language="mermaid" streaming={streaming} />
  return (
    <div style={CARD} testId="chat-mermaid-card">
      <div style={HEADER}>
        <text style={HEADER_LABEL}>mermaid</text>
      </div>
      <div style={ACTIONS}>
        <IconActionGroup>
          <DownloadAction code={code} language="mermaid" disabled={streaming} />
          <CopyAction code={code} disabled={streaming} />
        </IconActionGroup>
      </div>
      <div style={DIAGRAM_BODY}>
        <div
          style={DIAGRAM_STAGE}
          onLayout={(event: { width?: number }) => setStageWidth(event.width ?? 0)}
        >
          {diagram.status === 'done' && diagram.ok && stageWidth > 0 ? (
            <img
              src={diagram.png}
              objectFit="contain"
              alt="Mermaid chart"
              testId="chat-mermaid-diagram"
              style={fitted(diagram.width, diagram.height, stageWidth)}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function CodeCardComponent({ code, language, open, streaming }: CodeCardProps) {
  if (language === 'termul-plan') {
    return <TermulPlanRenderer code={code} isIncomplete={open} language={language} />
  }
  if (language === 'mermaid' && !open && canDrawMermaid())
    return <MermaidCard code={code} streaming={streaming} />
  return <SourceCard code={code} language={language} streaming={streaming} />
}

export const CodeCard = memo(CodeCardComponent)
