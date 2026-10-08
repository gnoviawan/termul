import { type KeyboardEvent, useId } from 'react'
import {
  Bot,
  Check,
  Eye,
  FileEdit,
  FolderEdit,
  Hand,
  Maps,
  MessageQuestion,
  ShieldAlert,
  Sparkles,
  type TermulIcon
} from '@/components/icons'
import type { SessionMode } from '@/lib/acp-api'
import { cn } from '@/lib/utils'

/** How much a mode lets the agent do without asking. */
export type ModeRisk = 'ask' | 'act' | 'danger' | 'other'

interface ModeKind {
  risk: ModeRisk
  icon: TermulIcon
}

/**
 * Known agent modes by id: Claude Agent (`default`, `acceptEdits`, `plan`,
 * `auto`, `bypassPermissions`), Cursor (`agent`, `plan`, `ask`), and Codex
 * (`read-only`, `workspace-write`, `agent`, `agent-full-access`). Codex calls
 * `agent` "Auto review" and Cursor calls it "Agent"; both edit without asking
 * first, so both are `act`.
 */
const MODE_KINDS: Record<string, ModeKind> = {
  default: { risk: 'ask', icon: Hand },
  plan: { risk: 'ask', icon: Maps },
  ask: { risk: 'ask', icon: MessageQuestion },
  'read-only': { risk: 'ask', icon: Eye },
  acceptEdits: { risk: 'act', icon: FileEdit },
  auto: { risk: 'act', icon: Sparkles },
  agent: { risk: 'act', icon: Bot },
  'workspace-write': { risk: 'act', icon: FolderEdit },
  bypassPermissions: { risk: 'danger', icon: ShieldAlert },
  'agent-full-access': { risk: 'danger', icon: ShieldAlert }
}

export function modeKind(modeId: string | undefined): ModeKind {
  return (modeId && MODE_KINDS[modeId]) || { risk: 'other', icon: Bot }
}

const GROUP_ORDER: ModeRisk[] = ['ask', 'act', 'danger', 'other']

function groupLabel(risk: ModeRisk, agentName: string | undefined): string {
  if (risk === 'ask') return 'Ask first'
  if (risk === 'act') return agentName ? `Let ${agentName} act` : 'Let the agent act'
  if (risk === 'danger') return 'Use with care'
  return 'Other modes'
}

function dangerDescription(description: string | null | undefined): string {
  const base = description?.trim()
  if (!base) return 'Use with care.'
  return `${base}${/[.!?]$/.test(base) ? '' : '.'} Use with care.`
}

/** The chip icon for the current mode; yellow when the mode is risky. */
export function ModeIcon({
  modeId,
  size = 13,
  className
}: {
  modeId: string | undefined
  size?: number
  className?: string
}): React.JSX.Element {
  const { risk, icon: Icon } = modeKind(modeId)
  return (
    <Icon
      size={size}
      aria-hidden="true"
      className={cn(
        'shrink-0',
        risk === 'danger' ? 'text-warning' : 'text-muted-foreground',
        className
      )}
    />
  )
}

/**
 * The mode menu (design "Mode menu · V4 Icons and groups"): every mode has an
 * icon; modes are grouped by risk ("Ask first", "Let <agent> act"); risky
 * modes are set apart below a hairline with a yellow icon. The selected mode
 * has a check only: the fill means hover or focus. Up and Down move the focus.
 */
export function ModeMenuList({
  modes,
  selectedId,
  agentName,
  touch,
  onPick,
  rowHandlers
}: {
  modes: readonly SessionMode[]
  selectedId: string | undefined
  agentName?: string
  touch: boolean
  onPick: (modeId: string) => void
  /** Extra per-row handlers (touch tap detection on mobile). */
  rowHandlers?: (modeId: string) => React.ButtonHTMLAttributes<HTMLButtonElement>
}): React.JSX.Element {
  const groups = GROUP_ORDER.map((risk) => ({
    risk,
    modes: modes.filter((m) => modeKind(m.id).risk === risk)
  })).filter((g) => g.modes.length > 0)
  const showLabels = groups.length > 1
  const uid = useId()

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-mode-id]')
    )
    const index = rows.indexOf(event.target as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1
    rows[(next + rows.length) % rows.length]?.focus()
  }

  return (
    <div
      data-testid="mode-chip-options"
      className="max-h-[min(28rem,70vh)] overflow-y-auto overscroll-contain"
    >
      {groups.map(({ risk, modes: groupModes }, groupIndex) => {
        const labelId = `${uid}-mode-group-${risk}`
        return (
          <fieldset key={risk} aria-labelledby={labelId} className="min-w-0">
            {risk === 'danger' && groupIndex > 0 ? (
              <div aria-hidden="true" className="mx-1.5 my-1 h-px bg-border" />
            ) : null}
            <div
              id={labelId}
              className={cn(
                'px-2.5 pb-0.5 text-2xs font-medium text-muted-foreground',
                groupIndex === 0 ? 'pt-1.5' : 'pt-2',
                (!showLabels || risk === 'danger') && 'sr-only'
              )}
            >
              {groupLabel(risk, agentName)}
            </div>
            {groupModes.map((mode) => {
              const selected = mode.id === selectedId
              const { icon: Icon } = modeKind(mode.id)
              const description =
                risk === 'danger' ? dangerDescription(mode.description) : mode.description
              return (
                <button
                  key={mode.id}
                  type="button"
                  data-mode-id={mode.id}
                  data-press-feedback="off"
                  aria-pressed={selected}
                  onClick={() => onPick(mode.id)}
                  onKeyDown={onKeyDown}
                  {...rowHandlers?.(mode.id)}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-lg px-2.5 text-left',
                    'transition-[background-color,transform] duration-150 ease-out',
                    'hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
                    'active:scale-[0.96] motion-reduce:active:scale-100',
                    touch ? 'min-h-11 py-2.5' : 'py-2'
                  )}
                >
                  <Icon
                    size={16}
                    aria-hidden="true"
                    className={cn(
                      'mt-0.5 shrink-0',
                      risk === 'danger' ? 'text-warning' : 'text-muted-foreground'
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {mode.name}
                      </span>
                      <Check
                        size={14}
                        aria-hidden="true"
                        className={cn(
                          'shrink-0 text-foreground',
                          selected ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </span>
                    {description ? (
                      <span className="text-xs text-muted-foreground">{description}</span>
                    ) : null}
                  </span>
                </button>
              )
            })}
          </fieldset>
        )
      })}
    </div>
  )
}
