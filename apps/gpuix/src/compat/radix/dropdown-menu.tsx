import { makeContent, makeItem, makeRoot, makeTrigger, passthrough, Portal } from './core'
export { Portal }
export const Root = makeRoot('menu')
export const Trigger = makeTrigger('dropdown-menu.Trigger')
export const Content = makeContent('dropdown-menu.Content')
export const Item = makeItem()
export const CheckboxItem = makeItem(false)
export const RadioItem = makeItem(false)
export const RadioGroup = passthrough()
export const Group = passthrough()
export const Label = passthrough()
export const Separator = passthrough('div', { role: 'separator' })
export const ItemIndicator = () => null
export const Sub = makeRoot('menu')
export const SubTrigger = makeTrigger('dropdown-menu.SubTrigger')
export const SubContent = makeContent('dropdown-menu.SubContent')
export const Arrow = () => null
