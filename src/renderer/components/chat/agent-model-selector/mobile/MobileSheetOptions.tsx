import type { ReactNode } from 'react'
import { ModeIcon } from '@/components/chat/mode-menu'
import { SheetGroup, SheetRow, SheetSwitchRow } from '@/components/ui/mobile-sheet'
import type { SessionModeState } from '@/lib/acp-api'
import type { ChoiceSection } from '../SelectorOptionRows'
import { useOptimisticSwitch } from '../use-option-values'

export interface ModeControl {
  modes: SessionModeState
  displayValue: string | undefined
  onPick: (modeId: string) => void
}

export type SheetOption = ChoiceSection & { glyph?: (value: string) => ReactNode }

const PHONE_LABELS: Record<string, string> = {
  thinking: 'Effort',
  context: 'Context window',
  fast: 'Fast'
}

const modeGlyph = (value: string): ReactNode => <ModeIcon modeId={value} size={16} />

export function sheetOptions(
  edit: readonly ChoiceSection[],
  rest: readonly ChoiceSection[],
  mode: ModeControl | null
): SheetOption[] {
  const find = (id: string): SheetOption | null => edit.find((s) => s.id === id) ?? null
  const modeOption: SheetOption | null =
    mode && mode.modes.availableModes.length > 0
      ? {
          kind: 'radio',
          id: 'mode',
          label: 'Mode',
          value: mode.displayValue,
          choices: mode.modes.availableModes.map((m) => ({
            value: m.id,
            name: m.name,
            description: m.description ?? undefined
          })),
          onPick: mode.onPick,
          glyph: modeGlyph
        }
      : null
  return [find('thinking'), modeOption, find('fast'), find('context'), ...rest]
    .filter((option): option is SheetOption => option !== null)
    .map((option) => ({ ...option, label: PHONE_LABELS[option.id] ?? option.label }))
}

function ToggleRow({
  option,
  disabled
}: {
  option: Extract<SheetOption, { kind: 'toggle' }>
  disabled: boolean
}): React.JSX.Element {
  const [on, toggle] = useOptimisticSwitch(option.checked, option.onToggle)
  return (
    <SheetSwitchRow
      title={option.label}
      checked={on}
      disabled={disabled}
      onCheckedChange={toggle}
      testId={`sheet-option-${option.id}`}
    />
  )
}

export function OptionsCard({
  options,
  disabled,
  onOpen
}: {
  options: readonly SheetOption[]
  disabled: boolean
  onOpen: (id: string) => void
}): React.JSX.Element | null {
  if (options.length === 0) return null
  return (
    <SheetGroup>
      {options.map((option) => {
        if (option.kind === 'toggle') {
          return <ToggleRow key={option.id} option={option} disabled={disabled} />
        }
        const current = option.choices.find((choice) => choice.value === option.value)
        return (
          <SheetRow
            key={option.id}
            title={option.label}
            value={
              current ? (
                <>
                  {option.glyph?.(current.value)}
                  <span className="truncate">{current.name}</span>
                </>
              ) : undefined
            }
            accessory="chevron"
            subview={option.id}
            disabled={disabled}
            onSelect={() => onOpen(option.id)}
          />
        )
      })}
    </SheetGroup>
  )
}

export function ChoiceList({
  option,
  disabled,
  onDone
}: {
  option: Extract<SheetOption, { kind: 'radio' }>
  disabled: boolean
  onDone: () => void
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={option.label}>
      <SheetGroup>
        {option.choices.map((choice) => (
          <SheetRow
            key={choice.value}
            role="radio"
            icon={option.glyph?.(choice.value)}
            title={choice.name}
            subtitle={choice.description}
            accessory="check"
            selected={choice.value === option.value}
            disabled={disabled || choice.unavailable}
            onSelect={() => {
              if (choice.value !== option.value) option.onPick(choice.value)
              onDone()
            }}
          />
        ))}
      </SheetGroup>
    </div>
  )
}
