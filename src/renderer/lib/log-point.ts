/**
 * A position in one incarnation of a chat's host session log. `seq` counts
 * within the incarnation `logEpoch` names (`null` when the transport has none):
 * a host restart can start a new epoch whose seqs restart.
 */
export interface LogPoint {
  logEpoch: string | null
  seq: number
}

/**
 * Whether `point` comes after `earlier` (`null`: nothing seen yet). A point in
 * another epoch counts as after: a renderer only meets a new epoch once the
 * host moved to it, and the old epoch's seqs mean nothing in the new log.
 */
export function isAfter(point: LogPoint, earlier: LogPoint | null | undefined): boolean {
  return !earlier || point.logEpoch !== earlier.logEpoch || point.seq > earlier.seq
}
