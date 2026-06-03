import type { GitCommit } from '@shared/types/ipc.types'

/**
 * A commit positioned for SVG rendering.
 *
 * `lane` is the horizontal column index for the commit node. `row` is its
 * vertical position (0 = newest, matching the input order). `parentEdges`
 * describes one line segment per parent, from this commit's lane to the lane
 * the parent occupies once it is drawn.
 */
export interface GraphRow {
  commit: GitCommit
  row: number
  lane: number
  /** Edges from this commit down to each parent's lane. */
  parentEdges: GraphEdge[]
}

export interface GraphEdge {
  /** Parent commit hash this edge connects to. */
  parentHash: string
  /** Lane the parent will be drawn in (or continues through). */
  toLane: number
}

export interface GraphLayout {
  rows: GraphRow[]
  /** Total number of lanes used; drives the SVG graph column width. */
  laneCount: number
}

/**
 * Assign lanes and parent edges to a newest-first commit list for a self-rendered
 * SVG lane graph.
 *
 * Algorithm (single pass, newest -> oldest):
 * - Keep an array of "active lanes". Each slot holds the SHA that lane is
 *   currently waiting to draw next, or `null` if the lane is free.
 * - For each commit, its lane is the first active lane already waiting for its
 *   hash; if none, it takes the first free lane (or a new one appended).
 * - After placing the commit, that lane is reassigned to the commit's FIRST
 *   parent. Additional parents (a merge) reuse a lane already waiting for them
 *   or claim a new lane — producing the merge fan-out.
 * - Edges connect the commit to the lane each parent occupies, so the renderer
 *   can draw converging/diverging lines.
 *
 * Lanes freed by a commit whose hash no lane is waiting for (e.g. a branch tip
 * with no children in the window) are reclaimed for later commits, keeping the
 * lane count tight.
 */
export function computeGraphLayout(commits: GitCommit[]): GraphLayout {
  // active[i] = hash the lane at column i is waiting to render next, or null.
  const active: (string | null)[] = []
  const rows: GraphRow[] = []
  // All hashes present in the fetched window. A parent not in this set lives
  // beyond the fetch limit and will never be drawn, so its lane must not stay
  // reserved (that would inflate the lane count and block reuse).
  const known = new Set(commits.map((c) => c.hash))
  let maxLaneIndex = -1

  const firstFreeLane = (): number => {
    const idx = active.indexOf(null)
    if (idx !== -1) return idx
    active.push(null)
    return active.length - 1
  }

  for (let row = 0; row < commits.length; row++) {
    const commit = commits[row]

    // Find a lane already expecting this commit (its child reserved it).
    let lane = active.indexOf(commit.hash)
    if (lane === -1) {
      // No child in view reserved a lane — this is a tip; take a free lane.
      lane = firstFreeLane()
    } else {
      // Clear every lane that was waiting for this same commit so duplicate
      // reservations (two children sharing a parent) collapse into one node.
      for (let i = 0; i < active.length; i++) {
        if (active[i] === commit.hash) active[i] = null
      }
    }

    const parentEdges: GraphEdge[] = []
    // Lanes for out-of-window parents are released only after every parent of
    // this commit has been assigned. Releasing mid-iteration would let a later
    // parent's firstFreeLane() reclaim a lane still needed by an earlier
    // parent, collapsing two distinct parent edges onto one lane.
    const lanesToRelease: number[] = []
    commit.parents.forEach((parentHash, parentIdx) => {
      let parentLane: number
      const existing = active.indexOf(parentHash)
      if (existing !== -1) {
        // Another lane already expects this parent: edge merges into it.
        parentLane = existing
      } else if (parentIdx === 0) {
        // First parent continues this commit's lane.
        parentLane = lane
        active[lane] = parentHash
      } else {
        // Extra merge parent: branch off into a fresh lane.
        parentLane = firstFreeLane()
        active[parentLane] = parentHash
      }
      parentEdges.push({ parentHash, toLane: parentLane })
      maxLaneIndex = Math.max(maxLaneIndex, parentLane)
      // Parent outside the fetched window: it will never be drawn, so its lane
      // can be reused by older commits. The edge is still emitted (the renderer
      // runs it to the bottom edge). Defer the actual release until all parents
      // of this commit are placed.
      if (!known.has(parentHash)) {
        lanesToRelease.push(parentLane)
      }
    })
    for (const releaseLane of lanesToRelease) {
      active[releaseLane] = null
    }

    // Root commit (no parents): free this lane for reuse below.
    if (commit.parents.length === 0) {
      active[lane] = null
    }

    rows.push({ commit, row, lane, parentEdges })
    maxLaneIndex = Math.max(maxLaneIndex, lane)
  }

  return { rows, laneCount: maxLaneIndex + 1 }
}
