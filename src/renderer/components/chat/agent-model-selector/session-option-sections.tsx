import { Zap } from '@/components/icons'
import type { SessionConfigOption } from '@/lib/acp-api'
import { flattenConfigOptionValues } from '../chat-input-bar-config'
import type { ChoiceSection, OptionChoice } from './SelectorOptionRows'
import type { SelectorPanelProps } from './SelectorPanel'
import { PICKER_ICON } from './selector-tokens'

type IsRejected = (optionId: string, value: string) => boolean
type TrySet = (optionId: string, value: string | boolean) => Promise<void>

/** A select option's value, or undefined when the agent sent none (or a non-string). */
const selectValue = (option: SessionConfigOption): string | undefined =>
  typeof option.currentValue === 'string' ? option.currentValue : undefined

/**
 * A select option's choices, labelled from the option data. A value the agent
 * rejected is dropped, or kept disabled while it is still the current one.
 */
function optionChoices(option: SessionConfigOption, isRejected?: IsRejected): OptionChoice[] {
  const current = selectValue(option)
  return flattenConfigOptionValues(option).flatMap(({ value, name, description }) => {
    const unavailable = isRejected?.(option.id, value) ?? false
    if (unavailable && value !== current) return []
    return [{ value, name, description: description ?? undefined, unavailable }]
  })
}

/** A rejected set is already toasted, and its value marked unavailable. */
const alreadyReported = (): void => {}

/**
 * The active model's session options: Thinking (the effort option), Context,
 * Fast mode. Each shows only when the agent sends that option, with value
 * labels from the option data.
 */
export function editSections(
  props: Pick<
    SelectorPanelProps,
    'thoughtLevel' | 'effortValue' | 'onEffort' | 'fastMode' | 'fastOn' | 'onToggleFast'
  >,
  context: SessionConfigOption | null,
  isRejected: IsRejected,
  trySet: TrySet
): ChoiceSection[] {
  const sections: ChoiceSection[] = []
  const thinking = props.thoughtLevel ? optionChoices(props.thoughtLevel) : []
  if (thinking.length > 0) {
    sections.push({
      kind: 'radio',
      id: 'thinking',
      label: 'Thinking',
      value: props.effortValue,
      choices: thinking,
      onPick: props.onEffort
    })
  }
  const windows = context ? optionChoices(context, isRejected) : []
  if (context && windows.length > 0) {
    sections.push({
      kind: 'radio',
      id: 'context',
      label: 'Context',
      value: selectValue(context),
      choices: windows,
      onPick: (value) => void trySet(context.id, value).catch(alreadyReported)
    })
  }
  const { onToggleFast } = props
  if (props.fastMode && onToggleFast) {
    sections.push({
      kind: 'toggle',
      id: 'fast',
      label: 'Fast mode',
      icon: (
        <Zap
          size={PICKER_ICON.glyph}
          aria-hidden="true"
          className="shrink-0 text-muted-foreground"
        />
      ),
      checked: props.fastOn,
      onToggle: () => onToggleFast()
    })
  }
  return sections
}

/** The agent's other options (not model, effort, Fast, mode or context window). */
export function restSections(
  rest: readonly SessionConfigOption[],
  isRejected: IsRejected,
  trySet: TrySet
): ChoiceSection[] {
  return rest.flatMap((option): ChoiceSection[] => {
    if (option.type === 'boolean') {
      return [
        {
          kind: 'toggle',
          id: option.id,
          label: option.name,
          checked: option.currentValue === true,
          onToggle: (value) => trySet(option.id, value)
        }
      ]
    }
    const choices = optionChoices(option, isRejected)
    if (choices.length === 0) return []
    return [
      {
        kind: 'radio',
        id: option.id,
        label: option.name,
        value: selectValue(option),
        choices,
        onPick: (value) => void trySet(option.id, value).catch(alreadyReported)
      }
    ]
  })
}
