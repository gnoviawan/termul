import type { Surface } from '../types'
import { CORE } from './core'
import { TAIL } from './tail'

export const SURFACES: Surface[] = [...CORE, ...TAIL]
