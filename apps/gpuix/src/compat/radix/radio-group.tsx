/** `@radix-ui/react-radio-group` stand-in: a controlled or uncontrolled value, items that pick it, and an indicator on the checked one. */
import { createContext, forwardRef, type ReactNode, useContext, useState } from 'react'

// biome-ignore lint/suspicious/noExplicitAny: a Radix stand-in passes arbitrary DOM props through
type AnyProps = { children?: ReactNode; [prop: string]: any }

interface GroupState {
  value: string | undefined
  select(value: string): void
  disabled: boolean
}

const GroupCtx = createContext<GroupState | null>(null)
const ItemCtx = createContext(false)

export const Root = forwardRef<HTMLDivElement, AnyProps>(function Root(
  { value, defaultValue, onValueChange, disabled = false, orientation, loop: _loop, dir: _dir, children, ...props },
  ref
) {
  const [inner, setInner] = useState<string | undefined>(defaultValue)
  const current = value !== undefined ? value : inner
  const select = (next: string) => {
    if (value === undefined) setInner(next)
    onValueChange?.(next)
  }
  return (
    <GroupCtx.Provider value={{ value: current, select, disabled }}>
      <div ref={ref} role="radiogroup" aria-orientation={orientation} {...props}>
        {children}
      </div>
    </GroupCtx.Provider>
  )
})

export const Item = forwardRef<HTMLButtonElement, AnyProps>(function Item(
  { value, disabled, onClick, children, ...props },
  ref
) {
  const group = useContext(GroupCtx)
  if (!group) throw new Error('compat radix: <RadioGroup.Item> outside its Root')
  const checked = group.value === value
  const off = disabled || group.disabled
  return (
    <ItemCtx.Provider value={checked}>
      <button
        ref={ref}
        type="button"
        role="radio"
        aria-checked={checked}
        data-state={checked ? 'checked' : 'unchecked'}
        data-disabled={off ? '' : undefined}
        disabled={off}
        onClick={(event: unknown) => {
          onClick?.(event)
          if (!off) group.select(value)
        }}
        {...props}
      >
        {children}
      </button>
    </ItemCtx.Provider>
  )
})

export function Indicator({ children, forceMount, ...props }: AnyProps) {
  const checked = useContext(ItemCtx)
  if (!checked && !forceMount) return null
  return (
    <span data-state={checked ? 'checked' : 'unchecked'} {...props}>
      {children}
    </span>
  )
}
