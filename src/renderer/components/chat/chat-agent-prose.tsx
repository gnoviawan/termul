import { mermaid as mermaidPlugin } from '@streamdown/mermaid'
import { useMemo, useRef } from 'react'
import { toast } from 'sonner'
import {
  type AllowedTags,
  type Components,
  defaultRemarkPlugins,
  type LinkSafetyConfig,
  Streamdown
} from 'streamdown'

import { ConfirmedExternalLink } from '@/components/external-link/ExternalLinkConfirm'
import { useThrottledStreamingText } from '@/hooks/use-throttled-streaming-text'
import { type FilePathResolutionContext, openFilePathFromTerminal } from '@/lib/file-path-links'
import { logFrontendError } from '@/lib/log-api'
import { syntaxShikiPair } from '@/lib/themes/syntax-shiki'
import { cn } from '@/lib/utils'
import { useColorTheme } from '@/stores/app-settings-store'
import { TermulPlanRenderer } from './ChatMarkdownPlanFence'
import { ChatMedia, MediaAltChip } from './ChatMedia'
import { chatCodePlugin } from './chat-code-plugin'
import { ChatMarkdownCode } from './chat-markdown-code'
import { remarkFilePathLinks } from './chat-markdown-file-links'
import { remarkTermulMedia } from './chat-markdown-images'
import { ChatMarkdownTable } from './chat-markdown-table'
import { ChatMarkdownSpan } from './chat-markdown-word'
import { chatMediaFromMarkdown } from './chat-media-source'

const MEDIA_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkTermulMedia]
/** Adds prose file-path linkification when a `filePathContext` exists. */
const FILE_PATH_REMARK_PLUGINS = [
  ...Object.values(defaultRemarkPlugins),
  remarkTermulMedia,
  remarkFilePathLinks
]

/**
 * Custom tags streamdown must keep through `rehype-sanitize`. Values are hast
 * property names (`data-path` -> `dataPath`); the tags themselves carry no
 * `href`/`src`, so `rehype-harden` never blocks them.
 */
export const STREAMDOWN_ALLOWED_TAGS: AllowedTags = {
  'termul-file-path': ['dataPath'],
  'termul-media': ['dataUrl', 'dataAlt', 'dataLinkPreview']
}

function stringProp(props: Record<string, unknown>, name: string): string | undefined {
  const value = props[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Shiki syntax-highlighting for fenced code blocks. The theme pair matches
 * the active color theme (light twin, then dark twin).
 */
const CODE_PLUGIN = chatCodePlugin
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
  span: ChatMarkdownSpan,
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
  stagger: 12
} as const

// Links are rendered by `ConfirmedExternalLink`; Streamdown's link safety would
// add a second, competing confirm path that opens via `window.open`.
const LINK_SAFETY_OFF: LinkSafetyConfig = { enabled: false }
const LINK_CLASS = 'wrap-anywhere font-medium text-primary underline'

function decodeFragment(href: string): string {
  try {
    return decodeURIComponent(href.slice(1))
  } catch {
    return href.slice(1)
  }
}

function scrollToFragment(messageRoot: HTMLElement | null, href: string): void {
  const id = decodeFragment(href)
  const target = id
    ? Array.from(messageRoot?.querySelectorAll('[id]') ?? []).find((element) => element.id === id)
    : undefined
  if (!target) {
    void logFrontendError({
      level: 'info',
      source: 'ChatMessage.anchorLink',
      message: `No element with id '${id}' in this message; ignoring '${href}'`
    })
    return
  }
  target.scrollIntoView({ block: 'start' })
}

export function TermulMarkdownMedia({
  url,
  alt,
  linkPreview,
  filePathContext
}: {
  url: string
  alt: string
  linkPreview: boolean
  filePathContext?: FilePathResolutionContext
}): React.JSX.Element | null {
  const cwd = filePathContext?.cwd
  const media = useMemo(() => chatMediaFromMarkdown(url, alt, cwd), [url, alt, cwd])
  if (!linkPreview) return media ? <ChatMedia media={media} /> : <MediaAltChip alt={alt} />
  if (!media) return null
  return (
    <div className="my-2">
      <ChatMedia media={media} />
    </div>
  )
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
  filePathContext,
  linkScope = ''
}: {
  text: string
  streaming: boolean
  reduced: boolean
  filePathContext?: FilePathResolutionContext
  /** Stable key (the message id) so a link can be re-found after a remount. */
  linkScope?: string
}): React.JSX.Element {
  // While streaming, the store re-renders this component on every flush (up
  // to once per frame) and Streamdown re-parses the full tail markdown on
  // each text change. Throttle the VALUE, not the component: the text fed to
  // Streamdown commits at 10 Hz trailing-edge while streaming; the turn-end
  // render commits the exact final text immediately.
  const text = useThrottledStreamingText(rawText, streaming)
  const colorTheme = useColorTheme()
  const shikiTheme = useMemo(() => syntaxShikiPair(colorTheme), [colorTheme])
  const rootRef = useRef<HTMLDivElement>(null)
  const components = useMemo<Components>(() => {
    const merged: Components = {
      ...STREAMDOWN_COMPONENTS,
      'termul-media': (props: Record<string, unknown>) => (
        <TermulMarkdownMedia
          url={stringProp(props, 'data-url') ?? ''}
          alt={stringProp(props, 'data-alt') ?? ''}
          linkPreview={stringProp(props, 'data-link-preview') === 'true'}
          filePathContext={filePathContext}
        />
      ),
      a: ({ href, children, node: _node, className, ...props }) => {
        if (href?.startsWith('#')) {
          const { target: _target, rel: _rel, ...anchorProps } = props
          return (
            <a
              href={href}
              {...anchorProps}
              className={cn(LINK_CLASS, className)}
              data-streamdown="link"
              onClick={(event) => {
                event.preventDefault()
                scrollToFragment(rootRef.current, href)
              }}
              onAuxClick={(event) => {
                event.preventDefault()
              }}
            >
              {children}
            </a>
          )
        }
        // Streamdown's own link safety is off (see `linkSafety` below): every
        // external link, with or without a workspace, goes through the one
        // confirm-then-open path.
        const { target: _target, rel: _rel, ...anchorProps } = props
        return (
          <ConfirmedExternalLink
            href={href}
            {...anchorProps}
            className={cn(LINK_CLASS, className)}
            data-streamdown="link"
          >
            {children}
          </ConfirmedExternalLink>
        )
      }
    }
    if (filePathContext) {
      const context = filePathContext
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
    <div
      ref={rootRef}
      className="chat-streamdown min-w-0 text-sm leading-normal text-foreground"
      data-external-link-scope={linkScope}
    >
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
        remarkPlugins={filePathContext ? FILE_PATH_REMARK_PLUGINS : MEDIA_REMARK_PLUGINS}
        allowedTags={STREAMDOWN_ALLOWED_TAGS}
        controls={STREAMDOWN_CONTROLS}
        components={components}
        lineNumbers={false}
        linkSafety={LINK_SAFETY_OFF}
        shikiTheme={shikiTheme}
      >
        {text}
      </Streamdown>
    </div>
  )
}
