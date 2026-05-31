import { describe, it, expect } from "vitest";
import { describeRef } from "./git-ref";

describe("describeRef", () => {
  it("classifies the current branch from HEAD ->", () => {
    expect(describeRef("HEAD -> refs/heads/main")).toEqual({
      label: "main",
      kind: "head",
    });
  });

  it("classifies detached HEAD", () => {
    expect(describeRef("HEAD")).toEqual({ label: "HEAD", kind: "head" });
  });

  it("classifies a local branch and preserves a slash in the name", () => {
    // The key case: a local slashed branch must NOT be mistaken for a remote.
    expect(describeRef("refs/heads/feature/login")).toEqual({
      label: "feature/login",
      kind: "branch",
    });
  });

  it("classifies a remote-tracking ref", () => {
    expect(describeRef("refs/remotes/origin/main")).toEqual({
      label: "origin/main",
      kind: "remote",
    });
  });

  it("classifies tags from both decoration forms", () => {
    expect(describeRef("tag: refs/tags/v1.0")).toEqual({
      label: "v1.0",
      kind: "tag",
    });
    expect(describeRef("refs/tags/v2.0")).toEqual({
      label: "v2.0",
      kind: "tag",
    });
  });

  it("classifies HEAD -> a slashed local branch as head, label keeps the slash", () => {
    expect(describeRef("HEAD -> refs/heads/feature/x")).toEqual({
      label: "feature/x",
      kind: "head",
    });
  });

  it("treats an unknown decoration as a branch, not a remote", () => {
    expect(describeRef("weird/thing")).toEqual({
      label: "weird/thing",
      kind: "branch",
    });
  });
});
