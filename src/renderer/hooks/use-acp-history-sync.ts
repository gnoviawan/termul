/**
 * Desktop shared-live history reads directly from the Rust-backed provider.
 * Kept as a compatibility hook so existing composition sites need no lifecycle
 * change; renderer-fed index/payload mirroring is intentionally gone.
 */
export function useAcpHistorySync(): void {}
