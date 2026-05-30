import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGitStatusStore, diffKey } from "./git-status-store";
import * as gitApiModule from "@/lib/git-api";
import type { GitCommitContext, GitStatusDetail } from "@shared/types/ipc.types";

vi.mock("@/lib/git-api", () => ({
  gitApi: {
    getStatus: vi.fn(),
    getDiff: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    discard: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
    getCommitContext: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const { gitApi } = gitApiModule as unknown as {
  gitApi: {
    getStatus: ReturnType<typeof vi.fn>;
    getDiff: ReturnType<typeof vi.fn>;
    stage: ReturnType<typeof vi.fn>;
    unstage: ReturnType<typeof vi.fn>;
    discard: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    push: ReturnType<typeof vi.fn>;
    getCommitContext: ReturnType<typeof vi.fn>;
  };
};

const CWD = "/repo";

const makeContext = (over: Partial<GitCommitContext> = {}): GitCommitContext => ({
  branch: "main",
  hasUpstream: true,
  ahead: 0,
  behind: 0,
  stagedCount: 1,
  hasHead: true,
  lastSubject: "last",
  lastBody: "",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useGitStatusStore.setState({
    statuses: {},
    diffs: {},
    commitContexts: {},
    selectedFile: null,
    isFetchingStatus: false,
    statusFetchCount: 0,
  });
  gitApi.getStatus.mockResolvedValue([] as GitStatusDetail[]);
  gitApi.getCommitContext.mockResolvedValue(makeContext());
});

describe("git-status-store commit footer", () => {
  it("fetchCommitContext stores context per cwd", async () => {
    gitApi.getCommitContext.mockResolvedValue(makeContext({ ahead: 3 }));
    await useGitStatusStore.getState().fetchCommitContext(CWD);
    expect(useGitStatusStore.getState().commitContexts[CWD].ahead).toBe(3);
  });

  it("fetchCommitContext swallows errors (no throw)", async () => {
    gitApi.getCommitContext.mockRejectedValue(new Error("boom"));
    await expect(
      useGitStatusStore.getState().fetchCommitContext(CWD),
    ).resolves.toBeUndefined();
    expect(useGitStatusStore.getState().commitContexts[CWD]).toBeUndefined();
  });

  it("fetchCommitContext ignores a stale (out-of-order) response", async () => {
    // First call resolves slowly with stale data; second call resolves fast
    // with fresh data. The slow one must not overwrite the fresh result.
    let resolveSlow: (v: GitCommitContext) => void = () => {};
    const slow = new Promise<GitCommitContext>((r) => {
      resolveSlow = r;
    });
    gitApi.getCommitContext.mockReturnValueOnce(slow);
    gitApi.getCommitContext.mockResolvedValueOnce(makeContext({ ahead: 9 }));

    const first = useGitStatusStore.getState().fetchCommitContext(CWD);
    const second = useGitStatusStore.getState().fetchCommitContext(CWD);
    await second;
    // Now let the older request resolve with stale data.
    resolveSlow(makeContext({ ahead: 1 }));
    await first;

    expect(useGitStatusStore.getState().commitContexts[CWD].ahead).toBe(9);
  });

  it("fetchCommitContext drops stale context when the fetch fails", async () => {
    // Seed a context, then make the next fetch fail.
    await useGitStatusStore.getState().fetchCommitContext(CWD);
    expect(useGitStatusStore.getState().commitContexts[CWD]).toBeDefined();
    gitApi.getCommitContext.mockRejectedValue(new Error("locked"));
    await useGitStatusStore.getState().fetchCommitContext(CWD);
    expect(useGitStatusStore.getState().commitContexts[CWD]).toBeUndefined();
  });

  it("commit invokes gitApi.commit then refreshes status and context", async () => {
    await useGitStatusStore.getState().commit(CWD, "summary", "body", false);
    expect(gitApi.commit).toHaveBeenCalledWith(CWD, "summary", "body", false);
    expect(gitApi.getStatus).toHaveBeenCalledWith(CWD);
    expect(gitApi.getCommitContext).toHaveBeenCalledWith(CWD);
  });

  it("commit passes amend flag through", async () => {
    await useGitStatusStore.getState().commit(CWD, "reword", "", true);
    expect(gitApi.commit).toHaveBeenCalledWith(CWD, "reword", "", true);
  });

  it("commit propagates errors to the caller", async () => {
    gitApi.commit.mockRejectedValue(new Error("commit failed"));
    await expect(
      useGitStatusStore.getState().commit(CWD, "x", "", false),
    ).rejects.toThrow("commit failed");
    // Status/context refresh should not run when the mutation failed.
    expect(gitApi.getStatus).not.toHaveBeenCalled();
  });

  it("commit still resolves when the post-commit refresh fails", async () => {
    // The commit itself succeeded; a transient refresh failure must not be
    // reported to the caller as a failed commit.
    gitApi.commit.mockResolvedValue(undefined);
    gitApi.getStatus.mockRejectedValue(new Error("transient lock"));
    await expect(
      useGitStatusStore.getState().commit(CWD, "summary", "", false),
    ).resolves.toBeUndefined();
    expect(gitApi.commit).toHaveBeenCalledOnce();
  });

  it("push invokes gitApi.push then refreshes status and context", async () => {
    await useGitStatusStore.getState().push(CWD);
    expect(gitApi.push).toHaveBeenCalledWith(CWD);
    expect(gitApi.getStatus).toHaveBeenCalledWith(CWD);
    expect(gitApi.getCommitContext).toHaveBeenCalledWith(CWD);
  });

  it("push propagates errors to the caller", async () => {
    gitApi.push.mockRejectedValue(new Error("auth failed"));
    await expect(useGitStatusStore.getState().push(CWD)).rejects.toThrow(
      "auth failed",
    );
    expect(gitApi.getStatus).not.toHaveBeenCalled();
  });

  it("diffKey disambiguates staged vs unstaged rows", () => {
    expect(diffKey(CWD, "a.txt", true)).not.toBe(diffKey(CWD, "a.txt", false));
  });
});

describe("git-status-store batch staging", () => {
  it("stageFile delegates to a single-path stage", async () => {
    await useGitStatusStore.getState().stageFile(CWD, "a.txt");
    expect(gitApi.stage).toHaveBeenCalledWith(CWD, "a.txt");
    expect(gitApi.stage).toHaveBeenCalledOnce();
  });

  it("stageFiles stages every path then refreshes once", async () => {
    await useGitStatusStore.getState().stageFiles(CWD, ["a.txt", "b.txt", "c.txt"]);
    expect(gitApi.stage).toHaveBeenCalledTimes(3);
    expect(gitApi.stage).toHaveBeenNthCalledWith(1, CWD, "a.txt");
    expect(gitApi.stage).toHaveBeenNthCalledWith(2, CWD, "b.txt");
    expect(gitApi.stage).toHaveBeenNthCalledWith(3, CWD, "c.txt");
    // Status + context refresh run exactly once for the whole batch.
    expect(gitApi.getStatus).toHaveBeenCalledOnce();
    expect(gitApi.getCommitContext).toHaveBeenCalledOnce();
  });

  it("unstageFiles unstages every path then refreshes once", async () => {
    await useGitStatusStore.getState().unstageFiles(CWD, ["a.txt", "b.txt"]);
    expect(gitApi.unstage).toHaveBeenCalledTimes(2);
    expect(gitApi.getStatus).toHaveBeenCalledOnce();
    expect(gitApi.getCommitContext).toHaveBeenCalledOnce();
  });

  it("discardFiles discards every path then refreshes once", async () => {
    await useGitStatusStore.getState().discardFiles(CWD, ["a.txt", "b.txt"]);
    expect(gitApi.discard).toHaveBeenCalledTimes(2);
    expect(gitApi.getStatus).toHaveBeenCalledOnce();
    expect(gitApi.getCommitContext).toHaveBeenCalledOnce();
  });

  it("empty batch is a no-op (no git calls, no refresh)", async () => {
    await useGitStatusStore.getState().stageFiles(CWD, []);
    expect(gitApi.stage).not.toHaveBeenCalled();
    expect(gitApi.getStatus).not.toHaveBeenCalled();
  });

  it("stageFiles still refreshes when a mid-batch stage fails", async () => {
    gitApi.stage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("add failed"));
    await expect(
      useGitStatusStore.getState().stageFiles(CWD, ["a.txt", "b.txt"]),
    ).rejects.toThrow("add failed");
    // The second file aborts the loop, but a refresh still runs so the UI
    // reflects the first file that did stage.
    expect(gitApi.stage).toHaveBeenCalledTimes(2);
    expect(gitApi.getStatus).toHaveBeenCalledOnce();
  });
});
