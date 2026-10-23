/**
 * Tailwind variants -> conditions. GPUIX applies `hover`, `active` and
 * `focusVisible` natively; everything else is a condition over TwState that
 * the caller supplies (disabled, group hover, data-state, viewport width).
 */
import { BREAKPOINTS } from './scale'

export type NativeState = 'hover' | 'active' | 'focusVisible'

export type Flag =
  | 'disabled'
  | 'focus'
  | 'focusWithin'
  | 'groupHover'
  | 'groupFocus'
  | 'groupFocusVisible'
  | 'coarsePointer'
  | 'reducedMotion'

export type Condition =
  | { kind: 'flag'; flag: Flag; negate?: boolean }
  | { kind: 'attr'; scope: 'self' | 'group'; attr: string; value?: string }
  | { kind: 'viewport'; min?: number; max?: number }
  | { kind: 'appearance'; dark: boolean }

export type VariantResult =
  | { kind: 'native'; state: NativeState }
  | { kind: 'condition'; condition: Condition }
  | { kind: 'unsupported'; reason: string }

/** Element state a tw() caller knows and GPUIX does not track for it. */
export interface TwState {
  /** A real <button> or `data-keep-shadow` element: keeps shadows on flat-elevation themes. */
  keepShadow?: boolean
  disabled?: boolean
  focus?: boolean
  focusWithin?: boolean
  groupHover?: boolean
  groupFocus?: boolean
  groupFocusVisible?: boolean
  coarsePointer?: boolean
  reducedMotion?: boolean
  viewportWidth?: number
  /** `data-*` and `aria-*` attributes of this element, keyed with their prefix (`data-state`). */
  attrs?: Readonly<Record<string, string | boolean | undefined>>
  /** The same for the nearest `group` ancestor. */
  groupAttrs?: Readonly<Record<string, string | boolean | undefined>>
}

const flag = (f: Flag, negate = false): VariantResult => ({
  kind: 'condition',
  condition: { kind: 'flag', flag: f, ...(negate ? { negate } : {}) }
})
const attr = (name: string, value?: string, scope: 'self' | 'group' = 'self'): VariantResult => ({
  kind: 'condition',
  condition: { kind: 'attr', scope, attr: name, ...(value === undefined ? {} : { value }) }
})

/** shadcn/tailwind.css custom variants (`data-open:` and friends). */
const SHADCN_DATA: Record<string, [string, string]> = {
  'data-open': ['data-state', 'open'],
  'data-closed': ['data-state', 'closed'],
  'data-checked': ['data-state', 'checked'],
  'data-unchecked': ['data-state', 'unchecked'],
  'data-selected': ['data-selected', 'true'],
  'data-disabled': ['data-disabled', 'true'],
  'data-active': ['data-active', 'true'],
  'data-horizontal': ['data-orientation', 'horizontal'],
  'data-vertical': ['data-orientation', 'vertical']
}

const STATIC: Record<string, VariantResult> = {
  hover: { kind: 'native', state: 'hover' },
  active: { kind: 'native', state: 'active' },
  'focus-visible': { kind: 'native', state: 'focusVisible' },
  focus: flag('focus'),
  'focus-within': flag('focusWithin'),
  disabled: flag('disabled'),
  enabled: flag('disabled', true),
  'group-hover': flag('groupHover'),
  'group-focus': flag('groupFocus'),
  'group-focus-visible': flag('groupFocusVisible'),
  'group-focus-within': flag('groupFocus'),
  'pointer-coarse': flag('coarsePointer'),
  'pointer-fine': flag('coarsePointer', true),
  'motion-reduce': flag('reducedMotion'),
  'motion-safe': flag('reducedMotion', true),
  dark: { kind: 'condition', condition: { kind: 'appearance', dark: true } }
}

function bracketAttr(
  prefix: 'data' | 'aria',
  body: string,
  scope: 'self' | 'group'
): VariantResult {
  const [name, value] = body.split('=')
  return attr(`${prefix}-${name}`, value?.replace(/^["']|["']$/g, ''), scope)
}

export function parseVariant(variant: string): VariantResult {
  const known = STATIC[variant]
  if (known) return known
  if (variant in SHADCN_DATA) return attr(...SHADCN_DATA[variant])
  const bracket = variant.match(/^(group-)?(data|aria)-\[(.+)\]$/)
  if (bracket)
    return bracketAttr(bracket[2] as 'data' | 'aria', bracket[3], bracket[1] ? 'group' : 'self')
  const ariaBool = variant.match(
    /^(group-)?aria-(selected|expanded|checked|disabled|pressed|current)$/
  )
  if (ariaBool) return attr(`aria-${ariaBool[2]}`, 'true', ariaBool[1] ? 'group' : 'self')
  const dataBool = variant.match(/^(group-)?data-([a-z-]+)$/)
  if (dataBool) return attr(`data-${dataBool[2]}`, undefined, dataBool[1] ? 'group' : 'self')
  const minBp = BREAKPOINTS[variant]
  if (minBp !== undefined) return { kind: 'condition', condition: { kind: 'viewport', min: minBp } }
  const maxBp = variant.startsWith('max-') ? BREAKPOINTS[variant.slice(4)] : undefined
  if (maxBp !== undefined) return { kind: 'condition', condition: { kind: 'viewport', max: maxBp } }
  if (
    variant.startsWith('[') ||
    variant.startsWith('*') ||
    /^(before|after|placeholder|file|first|last|odd|even|marker|selection)/.test(variant)
  ) {
    return {
      kind: 'unsupported',
      reason: `variant ${variant}: selects another element or a pseudo-element`
    }
  }
  return { kind: 'unsupported', reason: `variant ${variant} has no GPUIX mapping` }
}

function attrMatches(attrs: TwState['attrs'], name: string, value: string | undefined): boolean {
  const actual = attrs?.[name]
  if (actual === undefined || actual === false) return false
  if (value === undefined) return actual !== 'false'
  return String(actual) === value
}

export function conditionHolds(condition: Condition, state: TwState, dark: boolean): boolean {
  switch (condition.kind) {
    case 'flag':
      return (state[condition.flag] === true) !== (condition.negate === true)
    case 'attr':
      return attrMatches(
        condition.scope === 'group' ? state.groupAttrs : state.attrs,
        condition.attr,
        condition.value
      )
    case 'viewport': {
      const width = state.viewportWidth ?? Number.POSITIVE_INFINITY
      return (
        (condition.min === undefined || width >= condition.min) &&
        (condition.max === undefined || width < condition.max)
      )
    }
    case 'appearance':
      return condition.dark === dark
  }
}

export function conditionKey(condition: Condition): string {
  return JSON.stringify(condition)
}
