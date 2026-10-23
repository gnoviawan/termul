/**
 * Helpers the chat and composer tools share for seeding a throwaway
 * termul-server.
 */

/**
 * Where a tool keeps its servers' state and its output. `GPUIX_STATE_ROOT`
 * overrides the tool's default, so a unit running it next to the unit that
 * owns the default writes under its own `/tmp/gpuix-<unit>`.
 */
export function stateRoot(fallback: string): string {
  return process.env.GPUIX_STATE_ROOT ?? fallback
}
