/**
 * A fenced code block as the web paints it through Streamdown's `CodeBlock`
 * with `ChatMarkdownCode`'s actions: a sidebar-tinted card, a lower-case
 * language header, Download and Copy in the top-right group, and the code on
 * the background fill. The code itself is GPUIX's native `<code>`, which
 * highlights in Rust and scrolls horizontally on its own.
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
const BODY = tw('rounded-md border border-border bg-background p-4')
const NOTE = tw('px-1 text-xs text-muted-foreground')

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

export function CopyAction({ code, disabled }: { code: string; disabled: boolean }) {
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
      size="sm"
    >
      <IconSwap iconKey={copied}>{copied ? <Check className="text-success" /> : <Copy />}</IconSwap>
    </IconActionButton>
  )
}

export function DownloadAction({
  code,
  language,
  disabled
}: {
  code: string
  language: string
  disabled: boolean
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
    <IconActionButton label="Download" onClick={download} disabled={disabled} size="sm">
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

function CodeCardComponent({ code, language, open, streaming }: CodeCardProps) {
  const themes = transcriptThemes(useColorTheme())
  if (language === 'termul-plan') {
    return <TermulPlanRenderer code={code} isIncomplete={open} language={language} />
  }
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

export const CodeCard = memo(CodeCardComponent)
