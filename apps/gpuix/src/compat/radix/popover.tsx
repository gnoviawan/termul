import { Close, makeContent, makeRoot, makeTrigger, passthrough, Portal } from './core'
export { Close, Portal }
export const Root = makeRoot('popover')
export const Trigger = makeTrigger('Popover.Trigger')
export const Anchor = passthrough()
export const Content = makeContent('Popover.Content')
export const Arrow = () => null
