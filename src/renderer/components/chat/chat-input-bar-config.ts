/**
 * Pure helpers for the input-bar config-option chip row. Kept free of
 * React/store so they can be unit-tested directly. Partitions agent-advertised
 * config options so the `thought_level` reasoning-level control can be promoted
 * to a dedicated, distinctly-styled chip rendered ahead of generic options
 * (issue #286).
 */
import type { SessionConfigOption } from '@/lib/acp-api'

/** ACP semantic category for reasoning/thinking-depth config options. */
export const THOUGHT_LEVEL_CATEGORY = 'thought_level'

export interface PartitionedConfigOptions {
  /** The first `thought_level` option, if the agent advertises one. */
  thoughtLevel: SessionConfigOption | null
  /** All remaining options, in their original relative order. */
  rest: SessionConfigOption[]
}

/**
 * Split usable config options into the promoted `thought_level` option (first
 * match wins) and the rest, preserving the rest's original order. Options with
 * an unknown/other category fall through to `rest` and render as plain chips.
 */
export function partitionConfigOptions(options: SessionConfigOption[]): PartitionedConfigOptions {
  let thoughtLevel: SessionConfigOption | null = null
  const rest: SessionConfigOption[] = []
  for (const option of options) {
    if (thoughtLevel === null && option.category === THOUGHT_LEVEL_CATEGORY) {
      thoughtLevel = option
    } else {
      rest.push(option)
    }
  }
  return { thoughtLevel, rest }
}
