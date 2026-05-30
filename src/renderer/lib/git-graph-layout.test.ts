import { describe, it, expect } from "vitest";
import { computeGraphLayout } from "./git-graph-layout";
import type { GitCommit } from "@shared/types/ipc.types";

function commit(hash: string, parents: string[], extra: Partial<GitCommit> = {}): GitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    refs: [],
    author: "Test",
    date: "2026-05-30T12:00:00+00:00",
    subject: `commit ${hash}`,
    ...extra,
  };
}

describe("computeGraphLayout", () => {
  it("returns an empty layout for no commits", () => {
    const layout = computeGraphLayout([]);
    expect(layout.rows).toEqual([]);
    expect(layout.laneCount).toBe(0);
  });

  it("places linear history in a single lane", () => {
    // Newest first: B -> A (root).
    const commits = [commit("B", ["A"]), commit("A", [])];
    const layout = computeGraphLayout(commits);

    expect(layout.laneCount).toBe(1);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 0]);
    // B has one edge down to A's lane (0).
    expect(layout.rows[0].parentEdges).toEqual([{ parentHash: "A", toLane: 0 }]);
    // Root commit has no edges.
    expect(layout.rows[1].parentEdges).toEqual([]);
    expect(layout.rows[1].row).toBe(1);
  });

  it("fans out a merge commit into both parent lanes", () => {
    // M merges feature(P2) into main(P1); both descend from Base.
    const commits = [
      commit("M", ["P1", "P2"]),
      commit("P1", ["Base"]),
      commit("P2", ["Base"]),
      commit("Base", []),
    ];
    const layout = computeGraphLayout(commits);

    expect(layout.laneCount).toBe(2);

    const merge = layout.rows[0];
    expect(merge.commit.hash).toBe("M");
    expect(merge.lane).toBe(0);
    // First parent continues the merge's lane (0); second parent branches to 1.
    expect(merge.parentEdges).toEqual([
      { parentHash: "P1", toLane: 0 },
      { parentHash: "P2", toLane: 1 },
    ]);

    // The feature commit sits in lane 1 and converges back to Base in lane 0.
    const feat = layout.rows.find((r) => r.commit.hash === "P2");
    expect(feat?.lane).toBe(1);
    expect(feat?.parentEdges).toEqual([{ parentHash: "Base", toLane: 0 }]);
  });

  it("assigns distinct lanes to diverging branch tips", () => {
    // Two tips both pointing at the same Base, no merge in the window.
    const commits = [
      commit("TipA", ["Base"]),
      commit("TipB", ["Base"]),
      commit("Base", []),
    ];
    const layout = computeGraphLayout(commits);

    expect(layout.laneCount).toBe(2);
    expect(layout.rows[0].lane).toBe(0); // TipA
    expect(layout.rows[1].lane).toBe(1); // TipB
    // Both converge onto Base's lane (0).
    expect(layout.rows[0].parentEdges).toEqual([{ parentHash: "Base", toLane: 0 }]);
    expect(layout.rows[1].parentEdges).toEqual([{ parentHash: "Base", toLane: 0 }]);
    expect(layout.rows[2].lane).toBe(0); // Base
  });

  it("reclaims a freed lane for an unrelated later tip", () => {
    // TipA closes out (root) before an unrelated TipB appears; TipB should
    // reuse lane 0 rather than allocating a third lane.
    const commits = [
      commit("TipA", []),
      commit("TipB", ["Base"]),
      commit("Base", []),
    ];
    const layout = computeGraphLayout(commits);
    expect(layout.laneCount).toBe(1);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
  });

  it("frees the lane of a parent that lies outside the fetched window", () => {
    // 'Older' is referenced as a parent but not present in the window (it is
    // beyond the fetch limit). Its reserved lane must be reclaimed so the
    // following independent tip reuses lane 0 instead of inflating laneCount.
    const commits = [
      commit("Tip", ["Older"]), // Older is NOT in the list
      commit("Other", []),
    ];
    const layout = computeGraphLayout(commits);
    expect(layout.laneCount).toBe(1);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 0]);
    // The edge to the out-of-window parent is still emitted for rendering.
    expect(layout.rows[0].parentEdges).toEqual([{ parentHash: "Older", toLane: 0 }]);
  });

  it("handles an octopus merge with three parents", () => {
    const commits = [
      commit("M", ["P1", "P2", "P3"]),
      commit("P1", ["Base"]),
      commit("P2", ["Base"]),
      commit("P3", ["Base"]),
      commit("Base", []),
    ];
    const layout = computeGraphLayout(commits);
    // Three distinct parent lanes off the merge node.
    expect(layout.rows[0].parentEdges).toEqual([
      { parentHash: "P1", toLane: 0 },
      { parentHash: "P2", toLane: 1 },
      { parentHash: "P3", toLane: 2 },
    ]);
    expect(layout.laneCount).toBe(3);
  });

  it("keeps a visible parent in its own lane when an earlier merge parent is out-of-window", () => {
    // M's first parent 'Older' is beyond the fetch limit (omitted). The visible
    // second parent 'P2' must NOT collapse onto the out-of-window parent's lane;
    // releasing the Older lane is deferred until all parents are placed.
    const commits = [
      commit("M", ["Older", "P2"]), // Older is NOT in the list
      commit("P2", ["Base"]),
      commit("Base", []),
    ];
    const layout = computeGraphLayout(commits);
    expect(layout.rows[0].parentEdges).toEqual([
      { parentHash: "Older", toLane: 0 },
      { parentHash: "P2", toLane: 1 },
    ]);
    expect(layout.rows.find((r) => r.commit.hash === "P2")?.lane).toBe(1);
    expect(layout.laneCount).toBe(2);
  });
});
