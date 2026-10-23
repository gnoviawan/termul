/**
 * An observer the perf harness may install. The transcript calls it after a
 * streaming reply's text commits, so the harness can pair a chunk's arrival
 * with the frame that painted it. Unset in the app: one optional call.
 */
export const transcriptProbe: { onStreamCommit?: (text: string) => void } = {}
