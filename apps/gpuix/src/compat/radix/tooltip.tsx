import { makeContent, makeRoot, makeTrigger, Portal, Provider } from './core'
export { Portal, Provider }
export const Root = makeRoot('tooltip')
export const Trigger = makeTrigger('Tooltip.Trigger')
export const Content = makeContent('Tooltip.Content')
export const Arrow = () => null
export const TooltipProvider = Provider
