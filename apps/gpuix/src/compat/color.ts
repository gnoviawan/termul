/**
 * What an icon inherits from its ancestors. The text colour, for the one
 * GPUIX element that does not inherit it natively: `<svg>` tints with its own `style.color` or a fixed grey
 * (measured, packages/native/src/custom_elements/img.rs). An element that
 * sets a colour and has element children provides it; an `<svg>` reads it.
 */

import { createContext } from 'react'

export const ColorContext = createContext<string | undefined>(undefined)

/** `[&_svg]:…` classes of an ancestor: they style every icon below it, as the descendant selector does. */
export const SvgClassContext = createContext<string | undefined>(undefined)
