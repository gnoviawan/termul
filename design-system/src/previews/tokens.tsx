import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { contrastRatio } from '@/lib/themes/color-utils'
import { cn } from '@/lib/utils'
import { Caption, Pad, Row, useThemeId } from './kit'

/* ------------------------------------------------------------- helpers */

/** Paint any CSS color onto a 1px canvas and read back #rrggbb (alpha over `over`). */
function cssColorToHex(value: string, over = '#ffffff'): string {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d')
  if (!ctx) return '#000000'
  ctx.fillStyle = over
  ctx.fillRect(0, 0, 1, 1)
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function Probe({ background, onHex }: { background: string; onHex: (hex: string) => void }) {
  const themeId = useThemeId()
  const ref = useRef<HTMLSpanElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: themeId is the refresh trigger.
  useEffect(() => {
    if (!ref.current) return
    const page = cssColorToHex(getComputedStyle(document.body).backgroundColor)
    onHex(cssColorToHex(getComputedStyle(ref.current).backgroundColor, page))
  }, [background, themeId, onHex])
  return <span ref={ref} aria-hidden className="hidden" style={{ background }} />
}

function Ratio({ fg, bg }: { fg: string; bg: string }) {
  if (!fg || !bg) return <span className="font-mono text-xs text-muted-foreground">…</span>
  const ratio = contrastRatio(fg, bg)
  return (
    <span
      className={cn(
        'font-mono text-xs tabular-nums',
        ratio >= 4.5 ? 'text-muted-foreground' : 'text-destructive'
      )}
    >
      {ratio.toFixed(2)}:1
    </span>
  )
}

/* ---------------------------------------------------------- brand scale */

/** Interfere blue scale (Radix blue), light steps. Reference only. */
const INTERFERE_BLUE = [
  ['blue-9', '#0090ff', 'Switch on'],
  ['blue-10', '#0588f0', 'Switch on, hover'],
  ['blue-11', '#0d74ce', 'Solid fill, Light link'],
  ['blue-12', '#113264', 'Mix target for hover/pressed']
] as const

const LIVE_BRAND = [
  ['Fill', 'oklch(var(--primary-fill))', 'bg-primary-fill'],
  ['Hover', 'var(--primary-fill-hover)', 'bg-primary-fill-hover'],
  ['Pressed', 'var(--primary-fill-active)', 'bg-primary-fill-active'],
  ['Link', 'oklch(var(--primary))', 'text-primary']
] as const

function LiveSwatch({ label, value, utility }: { label: string; value: string; utility: string }) {
  const [hex, setHex] = useState('')
  const [fg, setFg] = useState('')
  const [card, setCard] = useState('')
  const isText = utility.startsWith('text-')
  return (
    <div className="flex flex-col gap-1.5">
      <Probe background={value} onHex={setHex} />
      <Probe background="oklch(var(--primary-foreground))" onHex={setFg} />
      <Probe background="oklch(var(--card))" onHex={setCard} />
      <div
        className="flex h-9 items-center justify-center rounded-md text-sm font-medium shadow-sm"
        style={
          isText
            ? { background: 'oklch(var(--card))', color: value }
            : { background: value, color: 'oklch(var(--primary-foreground))' }
        }
      >
        {isText ? 'Docs' : 'Save'}
      </div>
      <span className="text-xs text-foreground">{label}</span>
      <span className="font-mono text-xs text-muted-foreground">{hex || '…'}</span>
      {isText ? <Ratio fg={hex} bg={card} /> : <Ratio fg={fg} bg={hex} />}
    </div>
  )
}

export function BrandScale() {
  return (
    <Pad className="gap-4">
      <Row label="live">
        <div className="grid w-full grid-cols-4 gap-3">
          {LIVE_BRAND.map(([label, value, utility]) => (
            <LiveSwatch key={label} label={label} value={value} utility={utility} />
          ))}
        </div>
      </Row>
      <Row label="Interfere">
        <div className="grid w-full grid-cols-4 gap-3">
          {INTERFERE_BLUE.map(([step, hex, role]) => (
            <div key={step} className="flex flex-col gap-1.5">
              <div className="h-6 rounded-md" style={{ background: hex }} />
              <span className="font-mono text-xs text-foreground">
                {step} {hex}
              </span>
              <span className="text-xs text-muted-foreground">{role}</span>
            </div>
          ))}
        </div>
      </Row>
      <Caption>
        Live row reads the running theme. Ratios: fills against their label, link against the card.
        Termul pins the fill to blue-11; other themes derive it from their palette.
      </Caption>
    </Pad>
  )
}

/* ------------------------------------------------------ elevation ladder */

const LADDER = [
  ['E0 page', 'bg-background', '', 'Canvas, terminal, editor'],
  ['E0 shell', 'bg-sidebar', '', 'Sidebar, title bar'],
  ['E1 raised', 'bg-card', 'shadow-sm', 'Cards, panels, thumb'],
  ['E2 overlay', 'bg-popover', 'shadow-md', 'Popover, menu, tooltip'],
  ['E2 overlay', 'bg-popover', 'shadow-lg', 'Dialog, dropdown'],
  ['E3 modal', 'bg-popover', 'shadow-xl', 'Lightbox, sheet'],
  ['E3 modal', 'bg-popover', 'shadow-2xl', 'Command palette'],
  ['Chat', 'bg-popover', 'shadow-panel', 'Question panel']
] as const

export function ElevationLadder() {
  return (
    <Pad className="gap-4 bg-background">
      <div className="grid grid-cols-4 gap-x-5 gap-y-6">
        {LADDER.map(([level, surface, shadow, use]) => (
          <div key={`${level}-${shadow}`} className="flex flex-col gap-2">
            <div
              className={cn(
                'h-16 rounded-lg',
                surface,
                shadow,
                !shadow && 'outline-dashed outline-1 outline-border'
              )}
            />
            <span className="text-xs text-foreground">{level}</span>
            <span className="font-mono text-xs text-muted-foreground">{shadow || surface}</span>
            <span className="text-xs text-muted-foreground">{use}</span>
          </div>
        ))}
      </div>
      <Caption>
        E0 tiles are outlined only to show their footprint; the rest are lifted by their
        --elevation-* token alone. Termul Light maps sm to Interfere s-default, md/lg to s-large,
        xl/2xl to s-extra-large.
      </Caption>
    </Pad>
  )
}

/* ------------------------------------------------------------- switch */

function SwitchSpecimen({
  label,
  checked,
  disabled,
  className
}: {
  label: string
  checked: boolean
  disabled?: boolean
  className?: string
}) {
  // Rest and disabled rows reuse the same labels, so ids must be unique per specimen.
  const id = useId()
  return (
    <div className="flex w-24 flex-col items-start gap-1.5">
      <Switch id={id} checked={checked} disabled={disabled} className={className} />
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
    </div>
  )
}

export function SwitchStates() {
  const [live, setLive] = useState(false)
  return (
    <Pad className="gap-4">
      <Row label="rest">
        <SwitchSpecimen label="Off" checked={false} />
        <SwitchSpecimen label="On" checked />
      </Row>
      <Row label="forced">
        <SwitchSpecimen
          label="Off, hover"
          checked={false}
          className="[background:var(--switch-track-off-hover)]"
        />
        <SwitchSpecimen
          label="On, hover"
          checked
          className="[background:var(--switch-track-on-hover)]"
        />
        <SwitchSpecimen
          label="On, pressed"
          checked
          className="[background:var(--switch-track-on-active)]"
        />
        <SwitchSpecimen label="Focus" checked className="ring-1 ring-ring" />
      </Row>
      <Row label="disabled">
        <SwitchSpecimen label="Off" checked={false} disabled />
        <SwitchSpecimen label="On" checked disabled />
      </Row>
      <Row label="live">
        <div className="flex items-center gap-2">
          <Switch id="ds-switch-live" checked={live} onCheckedChange={setLive} />
          <Label htmlFor="ds-switch-live">Hover, press and tab to me</Label>
        </div>
      </Row>
    </Pad>
  )
}

/* ------------------------------------------------------- emboss, buttons */

const FORCED = [
  ['Default', ''],
  ['Hover', 'bg-primary-fill-hover shadow-emboss-hover'],
  ['Pressed', 'bg-primary-fill-active scale-[0.96]']
] as const

function EmbossSpecimen({ label, className }: { label: string; className: string }) {
  const [fill, setFill] = useState('')
  const [fg, setFg] = useState('')
  const fillVar =
    label === 'Hover'
      ? 'var(--primary-fill-hover)'
      : label === 'Pressed'
        ? 'var(--primary-fill-active)'
        : 'oklch(var(--primary-fill))'
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Probe background={fillVar} onHex={setFill} />
      <Probe background="oklch(var(--primary-foreground))" onHex={setFg} />
      <Button tabIndex={-1} className={className}>
        Save
      </Button>
      <span className="text-xs text-foreground">{label}</span>
      <span className="font-mono text-xs text-muted-foreground">{fill || '…'}</span>
      <Ratio fg={fg} bg={fill} />
    </div>
  )
}

export function EmbossStates() {
  const [ink, setInk] = useState('')
  const [wash, setWash] = useState('')
  return (
    <Pad className="gap-4">
      <Row label="primary">
        {FORCED.map(([label, className]) => (
          <EmbossSpecimen key={label} label={label} className={className} />
        ))}
      </Row>
      <Row label="ghost hover">
        <Probe background="var(--ghost-hover-foreground)" onHex={setInk} />
        <Probe background="oklch(var(--secondary))" onHex={setWash} />
        <Button tabIndex={-1} variant="ghost" className="bg-secondary text-ghost-hover-foreground">
          Cancel
        </Button>
        <Button
          tabIndex={-1}
          variant="outline"
          className="bg-secondary text-ghost-hover-foreground"
        >
          Details
        </Button>
        <Ratio fg={ink} bg={wash} />
      </Row>
      <Caption>
        Hover and pressed are forced with classes so they stay visible. Emboss: --shadow-emboss and
        --shadow-emboss-hover.
      </Caption>
    </Pad>
  )
}
