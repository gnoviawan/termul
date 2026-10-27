import type { Rpc } from './upstream.ts'

/**
 * The `maxBytes` the router passes to `inspect_document`. figcraft cuts a
 * tree past about 8 MiB to fit an MCP client's 10 MiB read buffer, but the
 * router reads its engine line by line with no such limit, and a shallower
 * tree would hide layers from the integrity checks.
 */
export const SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024

/**
 * Why a snapshot failed, or `undefined` when `tree` holds the whole
 * document. A tree that comes back `truncated` fails too: the checks would
 * pass a design whose deeper layers they never saw.
 */
export function snapshotFailure(saved: Rpc, tree: Rpc): string | undefined {
  const failed = [saved, tree].find((reply) => reply.error || reply.result?.isError === true)
  if (failed) return JSON.stringify(failed.error ?? failed.result?.content)
  const text = documentText(tree)
  if (text === undefined) return 'inspect_document returned no text'
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return 'inspect_document returned text that is not JSON'
  }
  const truncated = (document as { truncated?: unknown } | null)?.truncated
  if (truncated !== undefined)
    return `inspect_document truncated the tree: ${JSON.stringify(truncated)}`
  return undefined
}

/** The JSON text of an `inspect_document` reply. */
export function documentText(tree: Rpc): string | undefined {
  const content = tree.result?.content as { text?: string }[] | undefined
  return content?.[0]?.text
}
