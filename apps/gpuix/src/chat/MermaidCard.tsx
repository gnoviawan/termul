/**
 * A finished mermaid fence as Streamdown's mermaid block draws it in the web
 * transcript: the diagram fitted to its frame with Zoom in, Zoom out and
 * Reset in the frame's lower-left corner (the wheel zooms, a drag pans), and
 * Download (SVG, PNG, MMD), Copy and View fullscreen at the top right. The
 * fullscreen view fills the window with the same diagram and controls and
 * closes on Exit or Escape. The diagram is the webview helper's PNG
 * (`mermaid.ts`), placed by `pan-zoom.ts` since GPUIX has no transforms; the
 * buttons wear Streamdown's own icons.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buttonProps, type EventPayload, type StyleDesc } from '@gpuix/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { LAYER } from '../compat/stacking'
import { useIconStyle } from '../icons/hugeicons'
import { log } from '../log'
import { tw } from '../style/tw'
import { copyText } from '../terminal/clipboard'
import { downloadsDir } from './downloads'
import { exportMermaid, type MermaidFormat, useMermaid } from './mermaid'
import {
  canZoomIn,
  canZoomOut,
  fitted,
  initialView,
  type PanZoomMode,
  type PanZoomView,
  type Point,
  panned,
  placement,
  reset,
  type Size,
  wheeled,
  ZOOM_STEP,
  zoomedBy
} from './pan-zoom'

/** Streamdown's icon set (Apache-2.0), 16 px filled paths. */
const ICON = {
  check:
    'M15.5607 3.99999L15.0303 4.53032L6.23744 13.3232C5.55403 14.0066 4.44599 14.0066 3.76257 13.3232L4.2929 12.7929L3.76257 13.3232L0.969676 10.5303L0.439346 9.99999L1.50001 8.93933L2.03034 9.46966L4.82323 12.2626C4.92086 12.3602 5.07915 12.3602 5.17678 12.2626L13.9697 3.46966L14.5 2.93933L15.5607 3.99999Z',
  copy: 'M2.75 0.5C1.7835 0.5 1 1.2835 1 2.25V9.75C1 10.7165 1.7835 11.5 2.75 11.5H3.75H4.5V10H3.75H2.75C2.61193 10 2.5 9.88807 2.5 9.75V2.25C2.5 2.11193 2.61193 2 2.75 2H8.25C8.38807 2 8.5 2.11193 8.5 2.25V3H10V2.25C10 1.2835 9.2165 0.5 8.25 0.5H2.75ZM7.75 4.5C6.7835 4.5 6 5.2835 6 6.25V13.75C6 14.7165 6.7835 15.5 7.75 15.5H13.25C14.2165 15.5 15 14.7165 15 13.75V6.25C15 5.2835 14.2165 4.5 13.25 4.5H7.75ZM7.5 6.25C7.5 6.11193 7.61193 6 7.75 6H13.25C13.3881 6 13.5 6.11193 13.5 6.25V13.75C13.5 13.8881 13.3881 14 13.25 14H7.75C7.61193 14 7.5 13.8881 7.5 13.75V6.25Z',
  download:
    'M8.75 1V1.75V8.68934L10.7197 6.71967L11.25 6.18934L12.3107 7.25L11.7803 7.78033L8.70711 10.8536C8.31658 11.2441 7.68342 11.2441 7.29289 10.8536L4.21967 7.78033L3.68934 7.25L4.75 6.18934L5.28033 6.71967L7.25 8.68934V1.75V1H8.75ZM13.5 9.25V13.5H2.5V9.25V8.5H1V9.25V14C1 14.5523 1.44771 15 2 15H14C14.5523 15 15 14.5523 15 14V9.25V8.5H13.5V9.25Z',
  maximize:
    'M1 5.25V6H2.5V5.25V2.5H5.25H6V1H5.25H2C1.44772 1 1 1.44772 1 2V5.25ZM5.25 14.9994H6V13.4994H5.25H2.5V10.7494V9.99939H1V10.7494V13.9994C1 14.5517 1.44772 14.9994 2 14.9994H5.25ZM15 10V10.75V14C15 14.5523 14.5523 15 14 15H10.75H10V13.5H10.75H13.5V10.75V10H15ZM10.75 1H10V2.5H10.75H13.5V5.25V6H15V5.25V2C15 1.44772 14.5523 1 14 1H10.75Z',
  reset:
    'M13.5 8C13.5 4.96643 11.0257 2.5 7.96452 2.5C5.42843 2.5 3.29365 4.19393 2.63724 6.5H5.25H6V8H5.25H0.75C0.335787 8 0 7.66421 0 7.25V2.75V2H1.5V2.75V5.23347C2.57851 2.74164 5.06835 1 7.96452 1C11.8461 1 15 4.13001 15 8C15 11.87 11.8461 15 7.96452 15C5.62368 15 3.54872 13.8617 2.27046 12.1122L1.828 11.5066L3.03915 10.6217L3.48161 11.2273C4.48831 12.6051 6.12055 13.5 7.96452 13.5C11.0257 13.5 13.5 11.0336 13.5 8Z',
  close:
    'M12.4697 13.5303L13 14.0607L14.0607 13L13.5303 12.4697L9.06065 7.99999L13.5303 3.53032L14.0607 2.99999L13 1.93933L12.4697 2.46966L7.99999 6.93933L3.53032 2.46966L2.99999 1.93933L1.93933 2.99999L2.46966 3.53032L6.93933 7.99999L2.46966 12.4697L1.93933 13L2.99999 14.0607L3.53032 13.5303L7.99999 9.06065L12.4697 13.5303Z',
  zoomIn:
    'M1.5 6.5C1.5 3.73858 3.73858 1.5 6.5 1.5C9.26142 1.5 11.5 3.73858 11.5 6.5C11.5 9.26142 9.26142 11.5 6.5 11.5C3.73858 11.5 1.5 9.26142 1.5 6.5ZM6.5 0C2.91015 0 0 2.91015 0 6.5C0 10.0899 2.91015 13 6.5 13C8.02469 13 9.42677 12.475 10.5353 11.596L13.9697 15.0303L14.5 15.5607L15.5607 14.5L15.0303 13.9697L11.596 10.5353C12.475 9.42677 13 8.02469 13 6.5C13 2.91015 10.0899 0 6.5 0ZM4.125 5.875H4.75H5.875V4.75V4.125H7.125V4.75V5.875H8.25H8.875V7.125H8.25H7.125V8.25V8.875H5.875V8.25V7.125H4.75H4.125V5.875Z',
  zoomOut:
    'M1.5 6.5C1.5 3.73858 3.73858 1.5 6.5 1.5C9.26142 1.5 11.5 3.73858 11.5 6.5C11.5 9.26142 9.26142 11.5 6.5 11.5C3.73858 11.5 1.5 9.26142 1.5 6.5ZM6.5 0C2.91015 0 0 2.91015 0 6.5C0 10.0899 2.91015 13 6.5 13C8.02469 13 9.42677 12.475 10.5353 11.596L13.9697 15.0303L14.5 15.5607L15.5607 14.5L15.0303 13.9697L11.596 10.5353C12.475 9.42677 13 8.02469 13 6.5C13 2.91015 10.0899 0 6.5 0ZM4.125 5.875H4.75H8.25H8.875V7.125H8.25H4.75H4.125V5.875Z'
} as const

type IconName = keyof typeof ICON

const iconSources = new Map<IconName, string>()
function iconSource(name: IconName): string {
  let source = iconSources.get(name)
  if (!source) {
    source = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="#000" fill-rule="evenodd" clip-rule="evenodd" d="${ICON[name]}"/></svg>`
    iconSources.set(name, source)
  }
  return source
}

function Icon({ name, color }: { name: IconName; color: string | undefined }) {
  return <svg source={iconSource(name)} style={useIconStyle(16, undefined, color, undefined)} />
}

const MUTED = tw('text-muted-foreground').color as string
const FOREGROUND = tw('text-foreground').color as string

/** The three looks Streamdown gives its mermaid buttons. */
const BUTTON = {
  /** Header and fullscreen toolbar: `p-1`, foreground on hover. */
  bar: { base: tw('p-1'), hover: {} },
  /** Pan and zoom: `rounded p-1.5`, `bg-muted` on hover. */
  zoom: { base: tw('flex items-center justify-center rounded p-1.5'), hover: tw('bg-muted') },
  /** Exit fullscreen: `rounded-md p-2`, `bg-muted` on hover. */
  exit: { base: tw('rounded-md p-2'), hover: tw('bg-muted') }
} as const

function ControlButton({
  label,
  icon,
  look,
  disabled = false,
  onClick,
  onMouseDown
}: {
  label: string
  icon: IconName
  look: keyof typeof BUTTON
  disabled?: boolean
  onClick: () => void
  onMouseDown?: () => void
}) {
  const [hover, setHover] = useState(false)
  const live = hover && !disabled
  const { base, hover: hovered } = BUTTON[look]
  return (
    // biome-ignore lint/a11y/useSemanticElements: GPUIX has no <button>; buttonProps gives the div its behaviour
    <div
      {...buttonProps({ disabled, onClick })}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-disabled={disabled}
      testId={`mermaid-${label.toLowerCase().replace(/\s+/g, '-')}`}
      style={{
        ...base,
        ...(live ? hovered : {}),
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={onMouseDown}
    >
      <Icon name={icon} color={live ? FOREGROUND : MUTED} />
    </div>
  )
}

/** A name in the Downloads folder that is not taken: `diagram.svg`, then `diagram (1).svg`, as a browser saves. */
function freeName(
  dir: string,
  base: string,
  ext: string,
  exists: (file: string) => boolean
): string {
  for (let n = 0; ; n++) {
    const file = path.join(dir, n === 0 ? `${base}.${ext}` : `${base} (${n}).${ext}`)
    if (!exists(file)) return file
  }
}

async function saveDiagram(source: string, format: MermaidFormat): Promise<void> {
  const result = await exportMermaid(source, format)
  if (!result.ok) {
    log.warn('chat', `mermaid.export-failed ${JSON.stringify({ format, error: result.error })}`)
    toast.error('Failed to download diagram')
    return
  }
  try {
    const dir = downloadsDir()
    mkdirSync(dir, { recursive: true })
    const file = freeName(dir, 'diagram', format, existsSync)
    writeFileSync(file, result.data)
    log.info('chat', `mermaid.saved ${JSON.stringify({ file, format, bytes: result.data.length })}`)
    toast.success(`Saved to ${file}`)
  } catch (error) {
    log.warn('chat', `mermaid.save-failed ${String(error)}`)
    toast.error('Failed to download diagram')
  }
}

/** `absolute top-full right-0 mt-1`: under the 24 px trigger, 4 px down, right edges aligned. */
const MENU = {
  ...tw(
    'absolute right-0 min-w-[120px] overflow-hidden rounded-md border border-border bg-background shadow-lg'
  ),
  top: 24 + 4,
  zIndex: LAYER.popover
}
const MENU_ITEM = tw('w-full px-3 py-2 text-left text-sm text-foreground hover:bg-muted/40')
const FORMATS: readonly { format: MermaidFormat; label: string }[] = [
  { format: 'svg', label: 'SVG' },
  { format: 'png', label: 'PNG' },
  { format: 'mmd', label: 'MMD' }
]

function DownloadMenu({ source, disabled }: { source: string; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  // A press on the trigger also reaches the menu's outside handler, so the click toggles from
  // what the press saw, as Streamdown's trigger sits inside the menu's outside-click boundary.
  const openAtPress = useRef<boolean | null>(null)
  return (
    <div style={tw('relative')}>
      <ControlButton
        label="Download diagram"
        icon="download"
        look="bar"
        disabled={disabled}
        onMouseDown={() => {
          openAtPress.current = open
        }}
        onClick={() => {
          setOpen(!(openAtPress.current ?? open))
          openAtPress.current = null
        }}
      />
      {open ? (
        <div style={MENU} testId="mermaid-download-menu" onMouseDownOutside={() => setOpen(false)}>
          {FORMATS.map(({ format, label }) => (
            <div
              key={format}
              {...buttonProps({
                onClick: () => {
                  setOpen(false)
                  void saveDiagram(source, format)
                }
              })}
              role="menuitem"
              tabIndex={0}
              aria-label={`Download diagram as ${label}`}
              testId={`mermaid-download-${format}`}
              style={{ ...MENU_ITEM, cursor: 'pointer' }}
            >
              <text>{label}</text>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function CopyButton({ source, disabled }: { source: string; disabled: boolean }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const copy = useCallback(() => {
    if (copied) return
    copyText(source).then(
      () => {
        setCopied(true)
        timer.current = setTimeout(() => setCopied(false), 2000)
      },
      (error: unknown) => {
        log.warn('chat', `mermaid.copy-failed ${String(error)}`)
        toast.error('Failed to copy')
      }
    )
  }, [copied, source])
  return (
    <ControlButton
      label="Copy Code"
      icon={copied ? 'check' : 'copy'}
      look="bar"
      disabled={disabled}
      onClick={copy}
    />
  )
}

const ZOOM_PANEL = tw(
  'absolute flex flex-col gap-1 rounded-md border border-border bg-background/70 p-1'
)

interface Drawn {
  png: string
  width: number
  height: number
}

/** The diagram in its frame with the pan and zoom buttons; inline the frame takes the fitted height. */
function PanZoomStage({ diagram, mode }: { diagram: Drawn; mode: PanZoomMode }) {
  const { width, height: naturalHeight } = diagram
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 })
  const [view, setView] = useState<PanZoomView>(initialView)
  const drag = useRef<{ from: Point; pan: Point } | null>(null)
  useEffect(() => {
    setView((current) =>
      fitted(
        current,
        { width, height: naturalHeight },
        { width: stage.width, height: stage.height },
        mode
      )
    )
  }, [width, naturalHeight, stage.width, stage.height, mode])
  const height = mode === 'inline' ? Math.max(112, view.stageHeight ?? 0) : stage.height
  const box = placement(view, { width, height: naturalHeight }, { width: stage.width, height })
  const fullscreen = mode === 'fullscreen'
  return (
    <div
      role="application"
      aria-label="Mermaid chart"
      testId={`mermaid-stage-${mode}`}
      style={{
        ...tw('relative w-full overflow-hidden'),
        ...(fullscreen ? tw('h-full') : { height }),
        cursor: 'grab',
        active: { cursor: 'grabbing' },
        pointerEvents: 'auto'
      }}
      onLayout={(event: { width?: number; height?: number }) =>
        setStage({ width: event.width ?? 0, height: event.height ?? 0 })
      }
      onScroll={(event: EventPayload) => {
        // GPUI's deltaY is positive when the wheel turns away from the user, the DOM's opposite.
        const deltaY = event.deltaY ?? 0
        if (deltaY !== 0) setView((current) => wheeled(current, -deltaY))
      }}
      onMouseDown={(event: EventPayload) => {
        if ((event.button ?? 0) !== 0) return
        drag.current = { from: { x: event.x ?? 0, y: event.y ?? 0 }, pan: view.pan }
      }}
      onMouseMove={(event: EventPayload) => {
        const start = drag.current
        if (!start || event.pressedButton !== 0) return
        setView((current) =>
          panned(current, {
            x: start.pan.x + (event.x ?? 0) - start.from.x,
            y: start.pan.y + (event.y ?? 0) - start.from.y
          })
        )
      }}
      onMouseUp={() => {
        drag.current = null
      }}
    >
      {stage.width > 0 ? (
        <img
          src={diagram.png}
          objectFit="fill"
          alt="Mermaid chart"
          testId="chat-mermaid-diagram"
          style={{
            position: 'absolute',
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            pointerEvents: 'none'
          }}
        />
      ) : null}
      <div
        style={{ ...ZOOM_PANEL, ...(fullscreen ? tw('bottom-4 left-4') : tw('bottom-2 left-2')) }}
      >
        <ControlButton
          label="Zoom in"
          icon="zoomIn"
          look="zoom"
          disabled={!canZoomIn(view)}
          onClick={() => setView((current) => zoomedBy(current, ZOOM_STEP))}
        />
        <ControlButton
          label="Zoom out"
          icon="zoomOut"
          look="zoom"
          disabled={!canZoomOut(view)}
          onClick={() => setView((current) => zoomedBy(current, -ZOOM_STEP))}
        />
        <ControlButton
          label="Reset zoom and pan"
          icon="reset"
          look="zoom"
          onClick={() => setView(reset)}
        />
      </div>
    </div>
  )
}

const FULLSCREEN: StyleDesc = tw(
  'absolute inset-0 flex items-center justify-center bg-background/95'
)

function Fullscreen({
  source,
  diagram,
  onExit
}: {
  source: string
  diagram: Drawn
  onExit: () => void
}) {
  return (
    <anchored fill="window" priority={LAYER.dialog} style={{ backgroundColor: 'transparent' }}>
      <div
        role="dialog"
        aria-label="View fullscreen"
        testId="chat-mermaid-fullscreen"
        tabIndex={-1}
        // biome-ignore lint/a11y/noAutofocus: a modal view takes focus on open so Escape reaches it, as Streamdown listens on the document
        autoFocus
        style={FULLSCREEN}
        onKeyDown={(event: { key?: string }) => {
          if (event.key === 'escape') onExit()
        }}
      >
        <div style={tw('flex size-full items-center justify-center p-4')}>
          <PanZoomStage diagram={diagram} mode="fullscreen" />
        </div>
        <div style={tw('absolute top-4 right-4 flex items-center gap-1')}>
          <DownloadMenu source={source} disabled={false} />
          <CopyButton source={source} disabled={false} />
          <ControlButton label="Exit fullscreen" icon="close" look="exit" onClick={onExit} />
        </div>
      </div>
    </anchored>
  )
}

const CARD = tw(
  'relative flex w-full flex-col gap-2 rounded-xl border border-border bg-sidebar p-2'
)
const HEADER = tw('flex h-8 items-center text-muted-foreground text-xs')
const HEADER_LABEL = tw('ml-1 font-mono text-xs text-muted-foreground')
const DIAGRAM_BODY = tw('overflow-hidden rounded-md border border-border bg-background')
/** Streamdown's `mermaid-block-actions`; it sits over the body, so it comes after it here. */
const ACTIONS = tw('absolute top-2 right-2 flex items-center')
const ACTIONS_GROUP = tw(
  'flex shrink-0 items-center gap-2 rounded-md border border-sidebar bg-sidebar/70 px-1.5 py-1'
)

export function MermaidCard({
  code,
  streaming,
  fallback
}: {
  code: string
  streaming: boolean
  /** The source card, for a diagram mermaid rejects. */
  fallback: React.ReactNode
}) {
  const diagram = useMermaid(code)
  const [fullscreen, setFullscreen] = useState(false)
  if (diagram.status === 'done' && !diagram.ok) return fallback
  const drawn = diagram.status === 'done' && diagram.ok ? diagram : null
  return (
    <div style={CARD} testId="chat-mermaid-card">
      <div style={HEADER}>
        <text style={HEADER_LABEL}>mermaid</text>
      </div>
      <div style={DIAGRAM_BODY}>
        {drawn ? (
          <PanZoomStage diagram={drawn} mode="inline" />
        ) : (
          <div style={tw('min-h-28 w-full')} />
        )}
      </div>
      <div style={ACTIONS}>
        <div style={ACTIONS_GROUP}>
          <DownloadMenu source={code} disabled={streaming} />
          <CopyButton source={code} disabled={streaming} />
          <ControlButton
            label="View fullscreen"
            icon="maximize"
            look="bar"
            disabled={streaming || !drawn}
            onClick={() => setFullscreen(true)}
          />
        </div>
      </div>
      {fullscreen && drawn ? (
        <Fullscreen source={code} diagram={drawn} onExit={() => setFullscreen(false)} />
      ) : null}
    </div>
  )
}
