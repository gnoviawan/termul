import { makeContent, makeItem, makeRoot, makeTrigger, passthrough, Portal } from './core'
export { Portal }
export const Root = makeRoot('context')
export const Trigger = makeTrigger('context-menu.Trigger')
export const Content = makeContent('context-menu.Content')
export const Item = makeItem()
export const CheckboxItem = makeItem(false)
export const RadioItem = makeItem(false)
export const RadioGroup = passthrough()
export const Group = passthrough()
export const Label = passthrough()
export const Separator = passthrough('div', { role: 'separator' })
export const ItemIndicator = () => null
export const Sub = makeRoot('context')
export const SubTrigger = makeTrigger('context-menu.SubTrigger')
export const SubContent = makeContent('context-menu.SubContent')
export const Arrow = () => null
