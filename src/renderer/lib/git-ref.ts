/** The classified kind of a git ref decoration, used for chip styling. */
export type GitRefKind = "head" | "tag" | "remote" | "branch";

export interface DescribedRef {
  label: string;
  kind: GitRefKind;
}

/**
 * Parse one raw `%D` decoration entry from `git log --decorate=full` into a
 * display label + kind.
 *
 * Full decoration yields canonical, unambiguous ref names:
 * - `HEAD -> refs/heads/main`     → head, label "main"
 * - `HEAD`                        → head (detached), label "HEAD"
 * - `refs/heads/feature/login`    → branch, label "feature/login"
 * - `refs/remotes/origin/main`    → remote, label "origin/main"
 * - `tag: refs/tags/v1.0`         → tag, label "v1.0"
 *
 * Using full names (not `--decorate=short`) is what lets a local branch with a
 * slash (`feature/login`) be told apart from a remote ref (`origin/main`),
 * which short names cannot distinguish.
 */
export function describeRef(ref: string): DescribedRef {
  const trimmed = ref.trim();

  // `HEAD -> <ref>`: the current branch. Classify by the target ref.
  if (trimmed.startsWith("HEAD -> ")) {
    const target = trimmed.slice("HEAD -> ".length).trim();
    return { label: stripRefPrefix(target), kind: "head" };
  }

  if (trimmed === "HEAD") {
    return { label: "HEAD", kind: "head" };
  }

  // Annotated/lightweight tags are decorated as `tag: refs/tags/<name>`.
  if (trimmed.startsWith("tag: ")) {
    const target = trimmed.slice("tag: ".length).trim();
    return { label: stripRefPrefix(target), kind: "tag" };
  }

  if (trimmed.startsWith("refs/tags/")) {
    return { label: trimmed.slice("refs/tags/".length), kind: "tag" };
  }

  if (trimmed.startsWith("refs/remotes/")) {
    return { label: trimmed.slice("refs/remotes/".length), kind: "remote" };
  }

  if (trimmed.startsWith("refs/heads/")) {
    return { label: trimmed.slice("refs/heads/".length), kind: "branch" };
  }

  // Unknown/odd decoration: show it verbatim and treat it as a branch rather
  // than guessing "remote" from a slash (which mislabels local slashed names).
  return { label: stripRefPrefix(trimmed), kind: "branch" };
}

/** Strip a known canonical ref prefix for display, leaving the human name. */
function stripRefPrefix(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  return ref;
}
