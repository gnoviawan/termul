import { type ComponentType, useEffect, useMemo, useRef, useState } from 'react'
import * as Icons from '@/components/icons'
import { Button } from '@/components/ui/button'
import { MONO_STACK, SANS_STACK } from '@/lib/font-stacks'
import {
  BUNDLED_COLOR_THEMES,
  COLOR_THEME_FAMILIES,
  getColorThemeDefinition,
  readCssTokenHex,
  resolveSyntaxColors
} from '@/lib/themes'
import { cn } from '@/lib/utils'
import { Caption, Pad, Row, useCssVars, useThemeId } from './kit'

/* ------------------------------------------------------------------ colors */

/**
 * A semantic token row. `utility` is the Tailwind class that consumes it.
 * `raw` tokens hold a full color (var(--x)); the rest hold "L C H"
 * components consumed as oklch(var(--x)).
 */
export interface TokenSpec {
  token: `--${string}`
  utility: string
  raw?: boolean
}

function TokenSwatches({ tokens }: { tokens: readonly TokenSpec[] }) {
  const names = useMemo(() => tokens.map((spec) => spec.token), [tokens])
  const values = useCssVars(names)
  return (
    <ul className="flex flex-col divide-y divide-border/60 px-5 py-2">
      {tokens.map((spec) => {
        const value = values[spec.token] ?? ''
        let hex = ''
        if (!spec.raw && value) {
          try {
            hex = readCssTokenHex(spec.token)
          } catch {
            hex = ''
          }
        }
        return (
          <li key={spec.token} className="flex items-center gap-3 py-2">
            <span
              aria-hidden
              className="size-9 shrink-0 rounded-md border border-border"
              style={{ background: spec.raw ? `var(${spec.token})` : `oklch(var(${spec.token}))` }}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-mono text-xs text-foreground">{spec.token}</span>
              <span className="truncate text-xs text-muted-foreground">{spec.utility}</span>
            </div>
            <div className="flex shrink-0 flex-col items-end font-mono text-xs tabular-nums">
              <span className="max-w-48 truncate text-muted-foreground" title={value}>
                {spec.raw ? value || '—' : value ? `oklch(${value})` : '—'}
              </span>
              <span className="text-muted-foreground">{hex}</span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function tokenPreview(tokens: readonly TokenSpec[]): ComponentType {
  return function TokenPreview() {
    return <TokenSwatches tokens={tokens} />
  }
}

export const SURFACE_TOKENS: TokenSpec[] = [
  { token: '--background', utility: 'bg-background' },
  { token: '--card', utility: 'bg-card' },
  { token: '--popover', utility: 'bg-popover' },
  { token: '--secondary', utility: 'bg-secondary' },
  { token: '--muted', utility: 'bg-muted' },
  { token: '--surface-dark', utility: 'bg-surface-dark' },
  { token: '--surface-darker', utility: 'bg-surface-darker' },
  { token: '--terminal-bg', utility: 'bg-terminal-bg' },
  { token: '--row-hover', utility: 'bg-row-hover', raw: true },
  { token: '--row-hover-solid', utility: 'bg-row-hover-solid', raw: true },
  { token: '--rail-keycap', utility: '.keycap on the rail', raw: true }
]

export const TEXT_TOKENS: TokenSpec[] = [
  { token: '--foreground', utility: 'text-foreground' },
  { token: '--card-foreground', utility: 'text-card-foreground' },
  { token: '--popover-foreground', utility: 'text-popover-foreground' },
  { token: '--secondary-foreground', utility: 'text-secondary-foreground' },
  { token: '--muted-foreground', utility: 'text-muted-foreground' },
  { token: '--disabled-foreground', utility: 'text-disabled-foreground' },
  { token: '--terminal-fg', utility: 'text-terminal-fg' }
]

export const ACCENT_TOKENS: TokenSpec[] = [
  { token: '--primary', utility: 'text-primary, border-primary' },
  { token: '--primary-fill', utility: 'bg-primary-fill' },
  { token: '--primary-foreground', utility: 'text-primary-foreground' },
  { token: '--accent', utility: 'bg-accent' },
  { token: '--accent-foreground', utility: 'text-accent-foreground' },
  { token: '--ring', utility: 'ring-ring' },
  { token: '--search-match', utility: 'search highlight' },
  { token: '--search-match-active', utility: 'active search highlight' }
]

export const STATUS_TOKENS: TokenSpec[] = [
  { token: '--success', utility: 'text-success' },
  { token: '--success-fill', utility: 'bg-success-fill' },
  { token: '--success-foreground', utility: 'text-success-foreground' },
  { token: '--warning', utility: 'text-warning' },
  { token: '--warning-foreground', utility: 'text-warning-foreground' },
  { token: '--destructive', utility: 'text-destructive' },
  { token: '--destructive-fill', utility: 'bg-destructive-fill' },
  { token: '--destructive-foreground', utility: 'text-destructive-foreground' },
  { token: '--connection', utility: 'text-connection' }
]

export const LINE_TOKENS: TokenSpec[] = [
  { token: '--border', utility: 'border-border' },
  { token: '--input', utility: 'border-input' },
  { token: '--field-border', utility: 'border-field-border' },
  { token: '--overlay', utility: 'bg-overlay/50' }
]

export const DIFF_TOKENS: TokenSpec[] = [
  { token: '--diff-added', utility: 'bg-diff-added' },
  { token: '--diff-added-foreground', utility: 'text-diff-added-foreground' },
  { token: '--diff-added-border', utility: 'border-diff-added-border' },
  { token: '--diff-modified', utility: 'bg-diff-modified' },
  { token: '--glow-blue', utility: 'shadow-glow-blue' },
  { token: '--glow-purple', utility: 'shadow-glow-purple' },
  { token: '--glow-green', utility: 'shadow-glow-green' }
]

export const SIDEBAR_TOKENS: TokenSpec[] = [
  { token: '--sidebar-background', utility: 'bg-sidebar' },
  { token: '--sidebar-foreground', utility: 'text-sidebar-foreground' },
  { token: '--sidebar-primary', utility: 'bg-sidebar-primary' },
  { token: '--sidebar-primary-foreground', utility: 'text-sidebar-primary-foreground' },
  { token: '--sidebar-accent', utility: 'bg-sidebar-accent' },
  { token: '--sidebar-accent-foreground', utility: 'text-sidebar-accent-foreground' },
  { token: '--sidebar-border', utility: 'border-sidebar-border' },
  { token: '--sidebar-ring', utility: 'ring-sidebar-ring' }
]

const HUES = ['blue', 'purple', 'green', 'yellow', 'red', 'cyan', 'pink', 'orange', 'gray'] as const

export const PROJECT_TOKENS: TokenSpec[] = HUES.map((hue) => ({
  token: `--project-${hue}` as const,
  utility: `bg-project-${hue}`
}))

export const STATUS_BAR_TOKENS: TokenSpec[] = [
  { token: '--status-bar', utility: 'bg-status-bar' },
  ...HUES.map((hue) => ({
    token: `--status-bar-${hue}` as const,
    utility: `bg-status-bar-${hue}`
  }))
]

/** Every bundled theme's source palette, from BUNDLED_COLOR_THEMES. */
export function ThemePalettes() {
  const activeId = useThemeId()
  const keys = [
    'neutral',
    'ink',
    'primary',
    'accent',
    'success',
    'warning',
    'error',
    'info'
  ] as const
  return (
    <div className="flex flex-col gap-1 p-5">
      <div className="mb-1 flex items-center gap-3 pl-36 font-mono text-xs text-muted-foreground">
        {keys.map((key) => (
          <span key={key} className="w-12 truncate text-center">
            {key}
          </span>
        ))}
      </div>
      {COLOR_THEME_FAMILIES.flatMap((family) => [family.darkThemeId, family.lightThemeId]).map(
        (id) => {
          const theme = BUNDLED_COLOR_THEMES[id]
          if (!theme) return null
          const palette = theme.dark.palette
          return (
            <div
              key={id}
              className={cn(
                'flex items-center gap-3 rounded-md px-2 py-1',
                id === activeId && 'keycap'
              )}
            >
              <span className="w-32 truncate text-xs text-foreground">
                {theme.name}
                <span className="sr-only">{id === activeId ? ' (active)' : ''}</span>
              </span>
              {keys.map((key) => (
                <span
                  key={key}
                  title={`${theme.name} ${key}: ${palette[key]}`}
                  className="h-6 w-12 rounded border border-border"
                  style={{ background: palette[key] }}
                />
              ))}
            </div>
          )
        }
      )}
    </div>
  )
}

const SYNTAX_SAMPLE: { kind: keyof ReturnType<typeof resolveSyntaxColors>; text: string }[][] = [
  [{ kind: 'comment', text: '// Resolve the active session (mock data)' }],
  [
    { kind: 'keyword', text: 'export async function ' },
    { kind: 'function', text: 'openSession' },
    { kind: 'punctuation', text: '(' },
    { kind: 'variable', text: 'id' },
    { kind: 'operator', text: ': ' },
    { kind: 'type', text: 'string' },
    { kind: 'punctuation', text: ') {' }
  ],
  [
    { kind: 'keyword', text: '  const ' },
    { kind: 'definition', text: 'retries' },
    { kind: 'operator', text: ' = ' },
    { kind: 'number', text: '3' }
  ],
  [
    { kind: 'keyword', text: '  return ' },
    { kind: 'punctuation', text: '{ ' },
    { kind: 'property', text: 'id' },
    { kind: 'punctuation', text: ', ' },
    { kind: 'property', text: 'label' },
    { kind: 'operator', text: ': ' },
    { kind: 'string', text: "'api-server'" },
    { kind: 'punctuation', text: ', ' },
    { kind: 'property', text: 'live' },
    { kind: 'operator', text: ': ' },
    { kind: 'bool', text: 'true' },
    { kind: 'punctuation', text: ' }' }
  ],
  [{ kind: 'punctuation', text: '}' }],
  [
    { kind: 'tag', text: '<Button ' },
    { kind: 'attributeName', text: 'variant' },
    { kind: 'operator', text: '=' },
    { kind: 'attributeValue', text: '"ghost"' },
    { kind: 'tag', text: ' />' }
  ]
]

/** Syntax colors resolved for the active theme via resolveSyntaxColors. */
export function SyntaxColors() {
  const themeId = useThemeId()
  const syntax = resolveSyntaxColors(getColorThemeDefinition(themeId))
  const entries = Object.entries(syntax) as [keyof typeof syntax, string][]
  return (
    <Pad>
      <pre className="overflow-x-auto rounded-lg bg-terminal-bg p-4 font-mono text-xs leading-relaxed">
        {SYNTAX_SAMPLE.map((line, index) => (
          <div key={index}>
            {line.map((part, partIndex) => (
              <span key={partIndex} style={{ color: syntax[part.kind] }}>
                {part.text}
              </span>
            ))}
          </div>
        ))}
      </pre>
      <div className="grid grid-cols-3 gap-x-4 gap-y-2">
        {entries.map(([name, color]) => (
          <div key={name} className="flex items-center gap-2 text-xs">
            <span
              aria-hidden
              className="size-3 shrink-0 rounded-sm border border-border"
              style={{ background: color }}
            />
            <span className="truncate font-mono text-muted-foreground">{name}</span>
          </div>
        ))}
      </div>
    </Pad>
  )
}

/* -------------------------------------------------------------- typography */

const TYPE_SCALE = [
  ['text-xs', 'Labels, captions, menus, status bar'],
  ['text-sm', 'Body text, buttons, fields'],
  ['text-base', 'Reading text in chat and docs'],
  ['text-lg', 'Dialog titles'],
  ['text-xl', 'Panel headings'],
  ['text-2xl', 'Page headings'],
  ['text-3xl', 'Empty-state headline']
] as const

function useComputed(
  ref: React.RefObject<HTMLElement | null>,
  read: (s: CSSStyleDeclaration) => string
) {
  const themeId = useThemeId()
  const [value, setValue] = useState('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: themeId refreshes the reading.
  useEffect(() => {
    void document.fonts.ready.then(() => {
      if (ref.current) setValue(read(getComputedStyle(ref.current)))
    })
  }, [themeId])
  return value
}

function TypeRow({ className, use }: { className: string; use: string }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const metrics = useComputed(ref, (s) => `${s.fontSize} / ${s.lineHeight}`)
  return (
    <div className="grid grid-cols-[88px_1fr_120px] items-baseline gap-4">
      <span className="font-mono text-xs text-muted-foreground">{className}</span>
      <p ref={ref} className={cn(className, 'truncate text-foreground')}>
        {use}
      </p>
      <span className="text-right font-mono text-xs text-muted-foreground tabular-nums">
        {metrics}
      </span>
    </div>
  )
}

export function TypeScale() {
  return (
    <Pad className="gap-4">
      {TYPE_SCALE.map(([className, use]) => (
        <TypeRow key={className} className={className} use={use} />
      ))}
      <Caption>
        12px (text-xs) is the floor. text-2xs, text-3xs and text-4xs are aliases that resolve to
        0.75rem so nothing renders smaller.
      </Caption>
    </Pad>
  )
}

export function FontFamilies() {
  return (
    <Pad>
      <Row label="sans">
        <div className="flex flex-col gap-1">
          <p className="font-sans text-2xl text-foreground">Inter Variable</p>
          <p className="font-mono text-xs break-all text-muted-foreground">{SANS_STACK}</p>
        </div>
      </Row>
      <Row label="mono">
        <div className="flex flex-col gap-1">
          <p className="font-mono text-2xl text-foreground">Paper Mono 0123456789</p>
          <p className="font-mono text-xs break-all text-muted-foreground">{MONO_STACK}</p>
        </div>
      </Row>
      <Row label="weights">
        <span className="text-sm font-normal">Regular 400</span>
        <span className="text-sm font-medium">Medium 500</span>
        <span className="text-sm font-semibold">Semibold 600</span>
      </Row>
      <Row label="numerals">
        <span className="font-mono text-sm tabular-nums">tabular-nums 1,204.50 · 98.10</span>
      </Row>
    </Pad>
  )
}

export function LabelRoles() {
  return (
    <Pad className="gap-4">
      <Row label=".label-section">
        <span className="label-section text-foreground">Projects</span>
      </Row>
      <Row label=".label-group">
        <span className="label-group text-muted-foreground">Recent commands</span>
      </Row>
      <Row label=".label-panel">
        <span className="label-panel">On this page</span>
      </Row>
      <Caption>Sentence case, no tracking, 12px medium. Color stays at the call site.</Caption>
    </Pad>
  )
}

/* ----------------------------------------------------------- spacing, radius */

const SPACING = ['0.5', '1', '1.5', '2', '3', '4', '5', '6', '8', '10', '12', '16'] as const

function SpacingBar({ step }: { step: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useComputed(ref, (s) => s.width)
  return (
    <div className="grid grid-cols-[48px_1fr_56px] items-center gap-3">
      <span className="font-mono text-xs text-muted-foreground">{step}</span>
      <div ref={ref} className={cn('h-3 rounded-sm bg-primary-fill', `w-${step}`)} />
      <span className="text-right font-mono text-xs text-muted-foreground tabular-nums">
        {width}
      </span>
    </div>
  )
}

export function SpacingScale() {
  return (
    <Pad className="gap-2.5">
      {SPACING.map((step) => (
        <SpacingBar key={step} step={step} />
      ))}
      <Caption>Tailwind 4px base. Widths are measured from the rendered bars.</Caption>
    </Pad>
  )
}

/* Classes spelled out so Tailwind sees them. */
const SPACING_SAFELIST =
  'w-0.5 w-1 w-1.5 w-2 w-3 w-4 w-5 w-6 w-8 w-10 w-12 w-16 rounded-sm rounded-md rounded-lg rounded-xl rounded-2xl rounded-full shadow-sm shadow-md shadow-lg shadow-xl shadow-glow-blue shadow-glow-purple shadow-glow-green'
void SPACING_SAFELIST

const RADII = [
  'rounded-sm',
  'rounded-md',
  'rounded-lg',
  'rounded-xl',
  'rounded-2xl',
  'rounded-full'
]

function RadiusTile({ className }: { className: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const radius = useComputed(ref, (s) => s.borderTopLeftRadius)
  return (
    <div className="flex flex-col items-center gap-2">
      <div ref={ref} className={cn('size-16 border border-border bg-card', className)} />
      <span className="font-mono text-xs text-foreground">{className.replace('rounded-', '')}</span>
      <span className="font-mono text-xs text-muted-foreground tabular-nums">{radius}</span>
    </div>
  )
}

// Module-level so useCssVars sees a stable array and does not re-run every render.
const RADIUS_VARS = ['--radius'] as const

export function RadiusScale() {
  const vars = useCssVars(RADIUS_VARS)
  return (
    <Pad>
      <div className="flex flex-wrap gap-5">
        {RADII.map((className) => (
          <RadiusTile key={className} className={className} />
        ))}
      </div>
      <Caption>
        --radius is {vars['--radius'] || '…'}. lg uses it directly, md and sm subtract 2px and 4px.
      </Caption>
    </Pad>
  )
}

const SHADOWS = [
  ['shadow-sm', 'Resting controls'],
  ['shadow-md', 'Popovers, menus, tooltips'],
  ['shadow-lg', 'Dialogs, sheets'],
  ['shadow-xl', 'Lightbox'],
  ['shadow-glow-blue', 'Glow, blue'],
  ['shadow-glow-purple', 'Glow, purple'],
  ['shadow-glow-green', 'Glow, green']
] as const

export function ShadowScale() {
  return (
    <Pad>
      <div className="grid grid-cols-4 gap-5">
        {SHADOWS.map(([className, use]) => (
          <div key={className} className="flex flex-col gap-2">
            <div className={cn('h-14 rounded-lg border border-border bg-card', className)} />
            <span className="font-mono text-xs text-foreground">{className}</span>
            <span className="text-xs text-muted-foreground">{use}</span>
          </div>
        ))}
        <div className="flex flex-col gap-2">
          <div className="keycap h-14 rounded-lg" />
          <span className="font-mono text-xs text-foreground">.keycap</span>
          <span className="text-xs text-muted-foreground">Active tab, project, row</span>
        </div>
      </div>
    </Pad>
  )
}

/* ------------------------------------------------------------------ motion */

const DURATIONS = [
  '--duration-stagger',
  '--duration-micro',
  '--duration-quick',
  '--duration-fast',
  '--duration-medium',
  '--duration-slow',
  '--duration-very-slow'
] as const

const EASINGS = [
  '--ease-out',
  '--ease-in-out',
  '--ease-drawer',
  '--ease-smooth-out',
  '--ease-bounce',
  '--ease-bounce-strong',
  '--ease-linear'
] as const

const MOTION_EXTRAS = [
  '--distance-micro',
  '--distance-small',
  '--distance-base',
  '--distance-medium',
  '--distance-large',
  '--scale-tiny',
  '--scale-small',
  '--scale-medium',
  '--scale-large',
  '--blur-small',
  '--blur-medium',
  '--blur-large',
  '--tt-delay',
  '--tt-in-dur',
  '--tt-out-dur'
] as const

function parseBezier(value: string): [number, number, number, number] | null {
  if (value.trim() === 'linear') return [0, 0, 1, 1]
  const match = value.match(/cubic-bezier\(([^)]+)\)/)
  if (!match?.[1]) return null
  const parts = match[1].split(',').map((part) => Number.parseFloat(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null
  return parts as [number, number, number, number]
}

function Curve({ value }: { value: string }) {
  const bezier = parseBezier(value)
  if (!bezier) return <span className="size-12" />
  const [x1, y1, x2, y2] = bezier
  const s = 44
  const pad = 6
  const y = (v: number) => pad + (1 - v) * s
  const x = (v: number) => pad + v * s
  return (
    <svg
      role="img"
      aria-label={`Easing curve ${value}`}
      width={s + pad * 2}
      height={s + pad * 2}
      className="shrink-0 overflow-visible"
    >
      <rect
        x={pad}
        y={pad}
        width={s}
        height={s}
        className="fill-none stroke-border"
        strokeWidth={1}
      />
      <path
        d={`M ${x(0)} ${y(0)} C ${x(x1)} ${y(y1)}, ${x(x2)} ${y(y2)}, ${x(1)} ${y(1)}`}
        className="fill-none stroke-primary"
        strokeWidth={1.5}
      />
    </svg>
  )
}

export function MotionDurations() {
  const values = useCssVars(DURATIONS)
  const [played, setPlayed] = useState(false)
  return (
    <Pad className="gap-3">
      {DURATIONS.map((name) => (
        <div key={name} className="grid grid-cols-[150px_56px_1fr] items-center gap-3">
          <span className="font-mono text-xs text-foreground">{name}</span>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {values[name]}
          </span>
          <div className="relative h-2 rounded-full bg-muted">
            {/* The rail is the track minus the dot, so translateX(100%) lands the dot at the end. */}
            <span
              className="absolute inset-y-0 left-0 w-[calc(100%-0.5rem)] transition-transform motion-reduce:transition-none"
              style={{
                transform: played ? 'translateX(100%)' : 'translateX(0)',
                transitionDuration: `var(${name})`,
                transitionTimingFunction: 'var(--ease-out)'
              }}
            >
              <span className="block size-2 rounded-full bg-primary" />
            </span>
          </div>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => setPlayed((value) => !value)}>
          {played ? 'Reverse' : 'Play'}
        </Button>
        <Caption>
          Each dot travels with its duration on --ease-out. Reduced motion skips it.
        </Caption>
      </div>
    </Pad>
  )
}

export function MotionEasings() {
  const values = useCssVars(EASINGS)
  return (
    <Pad className="gap-3">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {EASINGS.map((name) => (
          <div key={name} className="flex items-center gap-3">
            <Curve value={values[name] ?? ''} />
            <div className="flex min-w-0 flex-col">
              <span className="font-mono text-xs text-foreground">{name}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {values[name]}
              </span>
            </div>
          </div>
        ))}
      </div>
    </Pad>
  )
}

export function MotionTokens() {
  const values = useCssVars(MOTION_EXTRAS)
  return (
    <Pad className="gap-0">
      <div className="grid grid-cols-2 gap-x-6 gap-y-2">
        {MOTION_EXTRAS.map((name) => (
          <div key={name} className="flex items-center justify-between gap-3 text-xs">
            <span className="font-mono text-foreground">{name}</span>
            <span className="font-mono text-muted-foreground tabular-nums">{values[name]}</span>
          </div>
        ))}
      </div>
    </Pad>
  )
}

/* ------------------------------------------------------------------- icons */

const ICON_ENTRIES = Object.entries(Icons)
  .filter(([name, value]) => /^[A-Z]/.test(name) && typeof value === 'object' && value !== null)
  .sort(([a], [b]) => a.localeCompare(b)) as [string, Icons.TermulIcon][]

export function IconGrid() {
  return (
    <div className="grid grid-cols-8 gap-1 p-4">
      {ICON_ENTRIES.map(([name, Icon]) => (
        <div
          key={name}
          title={name}
          className="flex flex-col items-center gap-1.5 rounded-md px-1 py-2.5 text-muted-foreground hover:bg-row-hover hover:text-foreground"
        >
          <Icon size={18} aria-hidden />
          <span className="w-full truncate text-center text-xs">{name}</span>
        </div>
      ))}
    </div>
  )
}

export const ICON_COUNT = ICON_ENTRIES.length
