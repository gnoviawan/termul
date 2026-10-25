/** Short constructors for writing surface steps. */

import type { Action, Check, Step, Target } from '../types'

export const id = (testId: string): Target => ({ testId })
export const txt = (text: string, exact = true): Target => ({ text, exact })
export const label = (name: string, role?: Extract<Target, { label: string }>['role']): Target => ({
  label: name,
  role
})
export const css = (selector: string): Target => ({ css: selector })

export const click = (target: Target): Action => ({ do: 'click', target })
export const rclick = (target: Target): Action => ({ do: 'click', target, button: 'right' })
export const dblclick = (target: Target): Action => ({ do: 'dblclick', target })
export const hover = (target: Target): Action => ({ do: 'hover', target })
export const press = (keys: string, gpuixKeys?: string): Action =>
  gpuixKeys ? { do: 'press', keys, gpuixKeys } : { do: 'press', keys }
export const type = (text: string): Action => ({ do: 'type', text })
export const wait = (ms: number): Action => ({ do: 'wait', ms })
export const drag = (from: Target, to: Target): Action => ({ do: 'drag', from, to })
export const wheel = (target: Target, deltaY: number): Action => ({ do: 'wheel', target, deltaY })

export const see = (...texts: string[]): Check[] => texts.map((text) => ({ text }))
export const gone = (text: string): Check => ({ text, gone: true })
/** The canvas status once FigCraft is up: GPUIX takes 5 to 14 s to get there (V1). */
export const CANVAS_READY: Check = { text: 'Ready', timeoutMs: 30_000 }

export const step = (name: string, actions: Action[], expect: Check[] = []): Step => ({
  name,
  actions,
  expect
})

/** The dashboard as it boots, with checks that the seeded state is there. */
export const DASHBOARD = step('a-dashboard', [], see('What should we do in alpha?'))

export const openSettings: Action[] = [click(label('Settings'))]
export const openTab = (tab: 'Chats' | 'Explorer' | 'Changes'): Action =>
  click(tab === 'Changes' ? css('[role="tab"]:has-text("Changes")') : label(tab, 'tab'))
