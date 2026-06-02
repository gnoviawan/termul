import { describe, expect, it } from "vitest";
import {
  parseUnifiedDiffInline,
  parseUnifiedDiffSplit,
} from "./parse-unified-diff";

describe("parseUnifiedDiffInline", () => {
  it("classifies hunk lines", () => {
    const lines = parseUnifiedDiffInline(
      "@@ -1,2 +1,2 @@\n-old\n+new\n context",
    );
    expect(lines.map((l) => l.kind)).toEqual([
      "header",
      "deletion",
      "addition",
      "context",
    ]);
    expect(lines[1].text).toBe("old");
    expect(lines[3].text).toBe("context");
  });
});

describe("parseUnifiedDiffSplit", () => {
  it("pairs deletions and additions on the same row", () => {
    const rows = parseUnifiedDiffSplit(
      "@@ -1,2 +1,2 @@\n-old line\n+new line\n unchanged",
    );
    const hunkHeader = rows.find((r) => r.fullWidth?.raw.startsWith("@@"));
    expect(hunkHeader).toBeDefined();

    const changeRow = rows.find(
      (r) => r.left?.kind === "deletion" && r.right?.kind === "addition",
    );
    expect(changeRow?.left?.text).toBe("old line");
    expect(changeRow?.right?.text).toBe("new line");

    const contextRow = rows.find(
      (r) =>
        r.left?.kind === "context" &&
        r.right?.kind === "context" &&
        r.left?.text === "unchanged",
    );
    expect(contextRow).toBeDefined();
  });

  it("handles addition-only hunk tail", () => {
    const rows = parseUnifiedDiffSplit("@@ -0,0 +1,1 @@\n+only add");
    const addRow = rows.find((r) => r.right?.kind === "addition");
    expect(addRow?.left).toBeNull();
    expect(addRow?.right?.text).toBe("only add");
  });

  it("handles deletion-only hunk tail", () => {
    const rows = parseUnifiedDiffSplit("@@ -1,1 +0,0 @@\n-only del");
    const delRow = rows.find((r) => r.left?.kind === "deletion");
    expect(delRow?.right).toBeNull();
    expect(delRow?.left?.text).toBe("only del");
  });

  it("emits full-width file headers", () => {
    const rows = parseUnifiedDiffSplit(
      "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts",
    );
    expect(rows.every((r) => r.fullWidth != null)).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it("shows meta lines full width", () => {
    const rows = parseUnifiedDiffSplit(
      "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new",
    );
    const meta = rows.find((r) => r.fullWidth?.kind === "meta");
    expect(meta?.fullWidth?.raw).toContain("No newline");
  });
});
