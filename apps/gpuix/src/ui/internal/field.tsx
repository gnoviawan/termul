/**
 * Text fields over GPUIX `<input>` / `<textarea>`, with the DOM field contract
 * Termul call sites use: `value` or `defaultValue`, `onChange(e)` with
 * `e.target.value`, `placeholder`, `disabled`, `readOnly`.
 *
 * GPUIX paints placeholders in a fixed #8f8f8f, so the placeholder is drawn
 * here in the field's `placeholder:` colour, over an empty field. The native
 * text field applies its `focusVisible` style on any focus, as browsers match
 * `:focus-visible` on a focused text field (native patch gpuix/0008).
 */
import type { EventPayload, PublicInstance, StyleDesc } from '@gpuix/react'
import { forwardRef, type Ref, useState } from 'react'
import { tw } from '../../style/tw'
import { type HostProps, nativeHandlers, useTw } from './host'

export interface UiChangeEvent {
  type: 'change'
  target: { value: string }
  currentTarget: { value: string }
  nativeEvent: EventPayload
}

export interface FieldProps extends Omit<HostProps, 'children'> {
  value?: string | number | readonly string[]
  defaultValue?: string | number | readonly string[]
  placeholder?: string
  disabled?: boolean
  readOnly?: boolean
  type?: string
  name?: string
  autoComplete?: string
  spellCheck?: boolean
  maxLength?: number
  onChange?: (event: UiChangeEvent) => void
  /** Enter in an input, Enter without Shift in a textarea (GPUIX `onSubmit`). */
  onSubmit?: (event: UiChangeEvent) => void
}

/** Keys that place the field in its parent; they go on the wrapper the placeholder needs. */
const OUTER_KEYS = new Set([
  'width',
  'minWidth',
  'maxWidth',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'alignSelf',
  'margin',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'position',
  'top',
  'right',
  'bottom',
  'left'
])

function splitStyle(style: StyleDesc): { outer: StyleDesc; inner: StyleDesc } {
  const outer: Record<string, unknown> = { position: 'relative', display: 'flex' }
  const inner: Record<string, unknown> = { flexGrow: 1, minWidth: 0 }
  for (const [key, value] of Object.entries(style)) {
    if (OUTER_KEYS.has(key)) outer[key] = value
    else inner[key] = value
  }
  return { outer: outer as StyleDesc, inner: inner as StyleDesc }
}

const asText = (value: FieldProps['value']) => (value === undefined ? undefined : String(value))

function changeEvent(event: EventPayload): UiChangeEvent {
  const value = event.value ?? ''
  return { type: 'change', target: { value }, currentTarget: { value }, nativeEvent: event }
}

export const Field = forwardRef<
  PublicInstance,
  FieldProps & { element: 'input' | 'textarea'; minRows?: number; maxRows?: number }
>(function Field(props, ref) {
  const {
    element,
    className,
    style,
    value,
    defaultValue,
    placeholder,
    disabled = false,
    readOnly = false,
    onChange,
    onSubmit,
    minRows,
    maxRows,
    tabIndex,
    autoFocus
  } = props
  const [focused, setFocused] = useState(false)
  const [own, setOwn] = useState(asText(defaultValue) ?? '')
  const controlled = value !== undefined
  const text = controlled ? (asText(value) ?? '') : own
  const { style: twStyle } = useTw(className, { disabled, focus: focused }, props)
  const merged: StyleDesc = { ...twStyle, ...style }
  const { outer, inner } = splitStyle(merged)
  const handlers = nativeHandlers(props)
  const placeholderColor = tw(placeholderClass(className ?? '')).color

  const field = {
    ref: ref as Ref<PublicInstance>,
    ...handlers,
    testId: props['data-testid'] as string | undefined,
    'aria-label': (props['aria-label'] as string | undefined) ?? placeholder,
    value: text,
    readOnly: readOnly || disabled,
    tabIndex: disabled ? -1 : tabIndex,
    autoFocus,
    style: inner,
    onChange: (event: EventPayload) => {
      const next = changeEvent(event)
      if (!controlled) setOwn(next.target.value)
      onChange?.(next)
    },
    onSubmit: onSubmit && ((event: EventPayload) => onSubmit(changeEvent(event))),
    onFocus: (event: EventPayload) => {
      setFocused(true)
      handlers.onFocus?.(event)
    },
    onBlur: (event: EventPayload) => {
      setFocused(false)
      handlers.onBlur?.(event)
    }
  }
  const showPlaceholder = placeholder !== undefined && text === ''
  return (
    <div style={outer}>
      {element === 'input' ? (
        <input {...field} />
      ) : (
        <textarea {...field} minRows={minRows} maxRows={maxRows} />
      )}
      {showPlaceholder && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: element === 'input' ? 0 : undefined,
            display: 'flex',
            alignItems: element === 'input' ? 'center' : 'start',
            paddingLeft:
              Number(inner.paddingLeft ?? 0) +
              Number(inner.borderLeftWidth ?? inner.borderWidth ?? 0),
            paddingTop:
              element === 'input'
                ? 0
                : Number(inner.paddingTop ?? 0) +
                  Number(inner.borderTopWidth ?? inner.borderWidth ?? 0),
            pointerEvents: 'none',
            overflow: 'hidden',
            color: placeholderColor ?? inner.color,
            fontFamily: inner.fontFamily,
            fontSize: inner.fontSize,
            fontWeight: inner.fontWeight,
            lineHeight: inner.lineHeight,
            opacity: inner.opacity
          }}
        >
          <text style={{ whiteSpace: 'nowrap' }}>{placeholder}</text>
        </div>
      )}
    </div>
  )
})

/** `placeholder:text-x` -> `text-x`, for the hand-drawn placeholder. */
function placeholderClass(className: string): string {
  return className
    .split(/\s+/)
    .filter((token) => token.startsWith('placeholder:'))
    .map((token) => token.slice('placeholder:'.length))
    .join(' ')
}
