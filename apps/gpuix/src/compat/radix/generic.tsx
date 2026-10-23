/** Catch-all Radix stand-in for primitives none of the four targets render open (select, switch, accordion, hover-card). */
import { Close, makeContent, makeItem, makeRoot, makeTrigger, passthrough, Portal } from './core'
export { Close, Portal }
export const Root = makeRoot('popover')
export const Trigger = makeTrigger('Generic.Trigger')
export const Content = makeContent('Generic.Content')
export const Item = makeItem()
export const Value = passthrough('span')
export const Icon = passthrough('span')
export const ItemText = passthrough('span')
export const ItemIndicator = () => null
export const Viewport = passthrough()
export const Group = passthrough()
export const Label = passthrough()
export const Separator = passthrough()
export const ScrollUpButton = () => null
export const ScrollDownButton = () => null
export const Thumb = passthrough('span')
export const Header = passthrough()
export const Arrow = () => null
