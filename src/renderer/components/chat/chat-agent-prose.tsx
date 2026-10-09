import { code as codePlugin } from '@streamdown/code'
import { mermaid as mermaidPlugin } from '@streamdown/mermaid'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  type AllowedTags,
  type Components,
  defaultRemarkPlugins,
  type LinkSafetyConfig,
  type LinkSafetyModalProps,
  Streamdown
} from 'streamdown'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { useThrottledStreamingText } from '@/hooks/use-throttled-streaming-text'
import { openerApi } from '@/lib/api'
import { readAttachmentBytes } from '@/lib/attachment-api'
import { type FilePathResolutionContext, openFilePathFromTerminal } from '@/lib/file-path-links'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { TermulPlanRenderer } from './ChatMarkdownPlanFence'
import { guessMimeType, uint8ToBase64 } from './chat-attachments'
import { ChatMarkdownCode } from './chat-markdown-code'
import { remarkFilePathLinks } from './chat-markdown-file-links'
import { remarkTermulImages, resolveLocalImagePath } from './chat-markdown-images'
import { ChatMarkdownTable } from './chat-markdown-table'

/** Always-on remark plugins: streamdown defaults plus the termul-image rewrite. */
const IMAGE_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkTermulImages]
/** Adds prose file-path linkification when a `filePathContext` exists. */
const FILE_PATH_REMARK_PLUGINS = [
  ...Object.values(defaultRemarkPlugins),
  remarkTermulImages,
  remarkFilePathLinks
]

/**
 * Custom tags streamdown must keep through `rehype-sanitize`. Values are hast
 * property names (`data-path` -> `dataPath`); the tags themselves carry no
 * `href`/`src`, so `rehype-harden` never blocks them.
 */
const STREAMDOWN_ALLOWED_TAGS: AllowedTags = {
  'termul-file-path': ['dataPath'],
  'termul-image': ['dataUrl', 'dataAlt']
}

/**
 * Shiki syntax-highlighting for fenced code blocks. Themes track the app's
 * light/dark mode via Streamdown's dual-theme output (github-light/dark).
 */
const CODE_PLUGIN = codePlugin
/** Live Mermaid diagram rendering for ```mermaid fences. */
const MERMAID_PLUGIN = mermaidPlugin
/**
 * Base plugin set used while the agent message is still streaming. The
 * `termul-plan` renderer is deliberately absent here so an in-flight turn
 * never renders a duplicate inline plan (the live sticky `PlanPanel` covers
 * the streaming turn). Historical (non-streaming) messages swap in
 * `STREAMDOWN_PLUGINS_WITH_PLAN` via the `plugins` prop on `AgentProse`.
 */
const STREAMDOWN_PLUGINS = { code: CODE_PLUGIN, mermaid: MERMAID_PLUGIN }
const STREAMDOWN_PLUGINS_WITH_PLAN = {
  ...STREAMDOWN_PLUGINS,
  renderers: [{ language: 'termul-plan', component: TermulPlanRenderer }]
}

// Copy on code blocks, plus download (save an agent-generated file); no line
// numbers (chat snippets are short). Mermaid keeps its interactive controls.
const STREAMDOWN_CONTROLS = {
  // Fenced code copy/download come from ChatMarkdownCode (IconActionButton).
  code: false,
  table: { copy: true, download: true, fullscreen: true },
  mermaid: { copy: true, download: true, fullscreen: true, panZoom: true }
} as const

const STREAMDOWN_COMPONENTS = {
  code: ChatMarkdownCode,
  table: ChatMarkdownTable
} as const

// Streamdown blurIn, tuned to the streaming-text tokens.
// Duration = --stream-fade. Easing = --stream-ease. Word gap = --stream-gap.
// The 1px blur lives in the sd-blurIn keyframe (--stream-blur).
// Active only while isAnimating is true. Settled markdown is not replayed.
const STREAMDOWN_ANIMATED = {
  animation: 'blurIn',
  duration: 350,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  sep: 'word',
  stagger: 60
} as const

/**
 * Confirm external links, then hand off to the OS browser.
 *
 * `onLinkCheck` only decides whether to show the confirm UI (never opens).
 * Opening happens in the modal action so Streamdown's default `window.open`
 * path is not used and the dialog actually closes after confirm.
 */
function StreamdownLinkSafetyModal({
  isOpen,
  onClose,
  url
}: LinkSafetyModalProps): React.JSX.Element {
  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Open external link?</AlertDialogTitle>
          <AlertDialogDescription className="break-all">{url}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              void openerApi.openUrlWithSystemBrowser(url)
              onClose()
            }}
          >
            Open
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const LINK_SAFETY: LinkSafetyConfig = {
  enabled: true,
  // Always take the confirm path; never open from the check callback.
  onLinkCheck: () => false,
  renderModal: (props) => <StreamdownLinkSafetyModal {...props} />
}

/** Muted fallback for images we cannot render (web without Tauri, unreadable). */
function TermulImageAltChip({ alt }: { alt: string }): React.JSX.Element {
  return (
    <span
      data-testid="termul-image-alt"
      title={alt}
      className="inline-flex max-w-[16rem] items-center rounded border border-border/40 bg-muted/40 px-1.5 py-0.5 align-middle text-xs text-muted-foreground"
    >
      <span className="truncate">{alt || 'image'}</span>
    </span>
  )
}

/** What an async-resolved preview belongs to, so stale previews get dropped. */
interface ResolvedImagePreview {
  url: string
  cwd?: string
  src: string
}

/**
 * Renders a `<termul-image>` element emitted by `remarkTermulImages`.
 * `data:`/`blob:` URLs render directly; `file://` and relative URLs are
 * resolved against the chat cwd and read via the brokered
 * `readAttachmentBytes` command (Tauri only). On the web or any read failure
 * the muted alt-text chip renders instead. A preview that fails to decode
 * after render (`<img>` onError) also falls back to the chip.
 */
export function TermulMarkdownImage({
  url,
  alt,
  cwd
}: {
  url: string
  alt: string
  cwd?: string
}): React.JSX.Element {
  const directUrl = url.startsWith('data:') || url.startsWith('blob:') ? url : null
  const readablePath = directUrl ? null : resolveLocalImagePath(url, cwd)
  const [resolved, setResolved] = useState<ResolvedImagePreview | null>(null)
  const [failed, setFailed] = useState<{ url: string; cwd?: string } | null>(null)
  if (resolved !== null && (resolved.url !== url || resolved.cwd !== cwd)) {
    // The markdown re-parsed with a different URL or the project switched cwd:
    // drop the stale preview so the new combination resolves from a clean slate.
    setResolved(null)
  }
  if (failed !== null && (failed.url !== url || failed.cwd !== cwd)) {
    setFailed(null)
  }

  useEffect(() => {
    if (directUrl || !readablePath || !isTauriContext()) return
    let cancelled = false
    void (async () => {
      try {
        const bytes = await readAttachmentBytes(readablePath)
        if (cancelled) return
        setResolved({
          url,
          cwd,
          src: `data:${guessMimeType(readablePath)};base64,${uint8ToBase64(bytes)}`
        })
      } catch (error) {
        if (cancelled) return
        void logFrontendError({
          level: 'warn',
          source: 'ChatMessage.termulImage',
          message: `Failed to read chat image '${url}': ${String(error)}`
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [directUrl, readablePath, url, cwd])

  const failedNow = failed !== null && failed.url === url && failed.cwd === cwd
  const src = directUrl ?? resolved?.src
  if (src && !failedNow) {
    return (
      <img
        src={src}
        alt={alt}
        className="max-h-96 max-w-full rounded-md"
        onError={() => {
          setFailed({ url, cwd })
          setResolved(null)
          void logFrontendError({
            level: 'warn',
            source: 'ChatMessage.termulImage',
            message: `Failed to display chat image '${url}': image decode/load failed`
          })
        }}
      />
    )
  }
  return <TermulImageAltChip alt={alt} />
}

/**
 * Renders a `<termul-file-path>` element emitted by `remarkFilePathLinks` as
 * the open-in-editor button. The path arrives in the `data-path` attribute
 * (hast property `dataPath`), already HTML-unescaped by the parser.
 */
export function TermulFilePathButton({
  path,
  context,
  children
}: {
  path: string
  context: FilePathResolutionContext
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="termul-file-path"
      data-path={path}
      className="cursor-pointer appearance-none text-left font-medium text-primary underline underline-offset-2"
      title="Open in editor"
      onClick={(event) => {
        if (event.button !== 0 || event.shiftKey) return
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed) return
        event.preventDefault()
        void openFilePathFromTerminal(path, context)
          .then((result) => {
            if (!result.ok) toast.error(result.message)
          })
          .catch((error: unknown) => {
            void logFrontendError({
              level: 'warn',
              source: 'ChatMessage.filePathLink',
              message: `Failed to open ${path}: ${String(error)}`
            })
            toast.error('Failed to open file from chat.')
          })
      }}
    >
      {children}
    </button>
  )
}

/** Agent reply rendered as streaming-safe, hardened markdown via Streamdown. */
export function AgentProse({
  text: rawText,
  streaming,
  reduced,
  filePathContext
}: {
  text: string
  streaming: boolean
  reduced: boolean
  filePathContext?: FilePathResolutionContext
}): React.JSX.Element {
  // While streaming, the store re-renders this component on every flush (up
  // to once per frame) and Streamdown re-parses the full tail markdown on
  // each text change. Throttle the VALUE, not the component: the text fed to
  // Streamdown commits at 10 Hz trailing-edge while streaming; the turn-end
  // render commits the exact final text immediately.
  const text = useThrottledStreamingText(rawText, streaming)
  const [externalUrl, setExternalUrl] = useState<string | null>(null)
  const components = useMemo<Components>(() => {
    const merged: Components = {
      ...STREAMDOWN_COMPONENTS,
      'termul-image': (props: Record<string, unknown>) => {
        const url = typeof props['data-url'] === 'string' ? props['data-url'] : ''
        const alt = typeof props['data-alt'] === 'string' ? props['data-alt'] : ''
        return <TermulMarkdownImage url={url} alt={alt} cwd={filePathContext?.cwd} />
      }
    }
    if (filePathContext) {
      const context = filePathContext
      merged.a = ({ href, children, ...props }) => (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          {...props}
          onClick={(event) => {
            event.preventDefault()
            if (href) setExternalUrl(href)
          }}
          onAuxClick={(event) => {
            event.preventDefault()
          }}
        >
          {children}
        </a>
      )
      merged['termul-file-path'] = (props: Record<string, unknown>) => {
        const path = typeof props['data-path'] === 'string' ? props['data-path'] : ''
        return (
          <TermulFilePathButton path={path} context={context}>
            {props.children as React.ReactNode}
          </TermulFilePathButton>
        )
      }
    }
    return merged
  }, [filePathContext])

  return (
    <div className="chat-streamdown min-w-0 text-sm leading-normal text-foreground">
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        isAnimating={streaming}
        caret={streaming ? 'block' : undefined}
        animated={reduced ? false : STREAMDOWN_ANIMATED}
        parseIncompleteMarkdown={streaming}
        // The `termul-plan` renderer is attached only to historical
        // (non-streaming) messages so an in-flight turn never renders a
        // duplicate inline plan — the live sticky `PlanPanel` owns the
        // streaming turn.
        plugins={streaming ? STREAMDOWN_PLUGINS : STREAMDOWN_PLUGINS_WITH_PLAN}
        remarkPlugins={filePathContext ? FILE_PATH_REMARK_PLUGINS : IMAGE_REMARK_PLUGINS}
        allowedTags={STREAMDOWN_ALLOWED_TAGS}
        controls={STREAMDOWN_CONTROLS}
        components={components}
        lineNumbers={false}
        linkSafety={LINK_SAFETY}
        shikiTheme={['github-light', 'github-dark']}
      >
        {text}
      </Streamdown>
      {externalUrl && (
        <StreamdownLinkSafetyModal
          isOpen
          url={externalUrl}
          onClose={() => setExternalUrl(null)}
          onConfirm={() => setExternalUrl(null)}
        />
      )}
    </div>
  )
}
