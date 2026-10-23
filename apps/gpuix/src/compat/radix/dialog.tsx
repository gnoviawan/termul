import { Close, DialogContent, DialogOverlay, makeRoot, makeTrigger, passthrough, Portal } from './core'
export { Close, Portal }
export const Root = makeRoot('dialog')
export const Trigger = makeTrigger('Dialog.Trigger')
export const Overlay = DialogOverlay
export const Content = DialogContent
export const Title = passthrough('h2')
export const Description = passthrough('p')
export const Action = Close
export const Cancel = Close
