/**
 * Warm-pool session ids that have not been promoted to a saved chat.
 * Lives in its own module so helpers can drop an id without importing
 * `shared-state` (that file already imports helpers).
 */
export const ephemeralSessionIds = new Set<string>()
