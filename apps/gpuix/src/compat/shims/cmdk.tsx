/** cmdk stand-in: the parts render as plain containers; filtering and keyboard nav are not attempted. */
import { forwardRef, type ReactNode } from 'react'
const part = (tag: string) =>
  forwardRef<unknown, Record<string, unknown> & { children?: ReactNode }>(function CmdkPart(
    { children, value, onValueChange, onSelect, shouldFilter, filter, loop, vimBindings, ...props },
    ref
  ) {
    const Tag = tag as 'div'
    return (
      <Tag {...props} ref={ref} onClick={onSelect ? () => (onSelect as (v: unknown) => void)(value) : undefined}>
        {children}
      </Tag>
    )
  })
export const Command = Object.assign(part('div'), {
  Input: part('input'),
  List: part('div'),
  Empty: part('div'),
  Group: part('div'),
  Item: part('div'),
  Separator: part('div'),
  Loading: part('div'),
  Dialog: part('div')
})
export const CommandInput = Command.Input
export const CommandList = Command.List
export const CommandEmpty = Command.Empty
export const CommandGroup = Command.Group
export const CommandItem = Command.Item
export const CommandSeparator = Command.Separator
export const useCommandState = () => undefined
