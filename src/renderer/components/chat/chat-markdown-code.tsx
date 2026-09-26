import { mermaid as mermaidPlugin } from '@streamdown/mermaid'
import { Check, Copy, Download } from 'lucide-react'
import {
  type ComponentPropsWithoutRef,
  isValidElement,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useState
} from 'react'
import { toast } from 'sonner'
import { CodeBlock, Streamdown, StreamdownContext, useIsCodeFenceIncomplete } from 'streamdown'
import { IconActionButton } from '@/components/ui/icon-action-button'
import { IconSwap } from '@/components/ui/icon-swap'
import { copyText } from '@/lib/copy-text'
import { cn } from '@/lib/utils'
import { TermulPlanRenderer } from './ChatMarkdownPlanFence'

const MERMAID_PLUGIN = mermaidPlugin
const LANGUAGE_RE = /language-([^\s]+)/

/** Pull fenced-code text out of Streamdown's `code` children shapes. */
function childrenToCode(children: ReactNode, node?: unknown): string {
  // Prefer the raw markdown node value — it preserves the original newlines
  // that React's children-array shape would collapse when joined with ''.
  const nodeValue = (node as { value?: string } | null | undefined)?.value
  if (typeof nodeValue === 'string') return nodeValue

  if (typeof children === 'string') return children
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return childrenToCode(children.props.children)
  }
  if (Array.isArray(children)) {
    return children.map((child) => childrenToCode(child as ReactNode)).join('')
  }
  return ''
}

function languageFromClassName(className: string | undefined): string {
  const match = className?.match(LANGUAGE_RE)
  return match?.[1] ?? ''
}

function downloadCodeFile(filename: string, code: string): void {
  const blob = new Blob([code], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function CodeCopyAction({ code }: { code: string }): React.JSX.Element {
  const { isAnimating } = useContext(StreamdownContext)
  const [copied, setCopied] = useState(false)

  const copy = useCallback(() => {
    if (!code || isAnimating) return
    void copyText(code).then((ok) => {
      if (!ok) {
        toast.error('Failed to copy')
        return
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [code, isAnimating])

  return (
    <IconActionButton
      label={copied ? 'Copied' : 'Copy'}
      onClick={copy}
      disabled={isAnimating}
      size="sm"
    >
      <IconSwap iconKey={copied}>{copied ? <Check className="text-success" /> : <Copy />}</IconSwap>
    </IconActionButton>
  )
}

function CodeDownloadAction({
  code,
  language
}: {
  code: string
  language: string
}): React.JSX.Element {
  const { isAnimating } = useContext(StreamdownContext)

  const download = useCallback(() => {
    if (!code || isAnimating) return
    try {
      const ext = language && language !== 'text' ? language : 'txt'
      downloadCodeFile(`file.${ext}`, code)
    } catch {
      toast.error('Failed to download')
    }
  }, [code, isAnimating, language])

  return (
    <IconActionButton label="Download" onClick={download} disabled={isAnimating} size="sm">
      <Download />
    </IconActionButton>
  )
}

type ChatMarkdownCodeProps = ComponentPropsWithoutRef<'code'> & {
  node?: unknown
}

/**
 * Streamdown `components.code` override: keep default inline + mermaid
 * behavior, but swap fenced-code copy/download for IconActionButton +
 * IconSwap so they match MessageActions.
 */
export function ChatMarkdownCode({
  className,
  children,
  node,
  ...props
}: ChatMarkdownCodeProps): React.JSX.Element {
  const { lineNumbers } = useContext(StreamdownContext)
  const isIncomplete = useIsCodeFenceIncomplete()
  const isInline = !('data-block' in props)
  const language = languageFromClassName(className)
  const code = childrenToCode(children, node)

  if (isInline) {
    return (
      <code
        className={cn('rounded bg-muted px-1.5 py-0.5 font-mono text-sm', className)}
        data-streamdown="inline-code"
        {...props}
      >
        {children}
      </code>
    )
  }

  // Mermaid stays on Streamdown's built-in block (fullscreen/panZoom out of
  // scope). Nested instance omits our `code` override so default path runs.
  if (language === 'mermaid') {
    return (
      <Suspense fallback={null}>
        <Streamdown
          mode="static"
          plugins={{ mermaid: MERMAID_PLUGIN }}
          controls={{
            code: false,
            table: false,
            mermaid: { copy: true, download: true, fullscreen: true, panZoom: true }
          }}
          linkSafety={{ enabled: false }}
        >
          {`\`\`\`mermaid\n${code}\n\`\`\``}
        </Streamdown>
      </Suspense>
    )
  }

  // termul-plan fences render as an inline read-only PlanPanel, not a code
  // block. This override replaces Streamdown's default `code` component (the
  // only one that consults the `renderers` plugin config), so the lookup must
  // happen here. `useIsCodeFenceIncomplete` is the public per-block hook that
  // reports whether THIS fence is still being streamed — the same signal the
  // default component passes to custom renderers.
  if (language === 'termul-plan') {
    return (
      <Suspense fallback={null}>
        <TermulPlanRenderer code={code} isIncomplete={isIncomplete} language={language} />
      </Suspense>
    )
  }

  return (
    <CodeBlock
      code={code}
      language={language || 'text'}
      className={cn('[&_code>span]:block', className)}
      lineNumbers={lineNumbers}
    >
      <CodeDownloadAction code={code} language={language || 'text'} />
      <CodeCopyAction code={code} />
    </CodeBlock>
  )
}
