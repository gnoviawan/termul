/**
 * Wire→display reconstruction for persisted user prompts.
 *
 * The composer splits a prompt into DISPLAY text (private-use skill tokens,
 * rendered as inline `SkillChip` pills) and WIRE text (`# Agent Skills`
 * path-framed, dispatched to the agent). The optimistic in-memory user
 * message stores the display blocks, but the durable `user_prompt` record —
 * and every replayed/recovered `message_chunk(role=user)` — stores the WIRE
 * blocks (the agent's and the log's contract). Without this module, a resumed
 * chat renders the raw framing (`# Agent Skills\nname: path\n---\n(name)`)
 * instead of the chips the live chat shows.
 *
 * `wireTextToDisplay` is the inverse of `formatPromptWithSkills`: it parses
 * the EXACT wire framing and rebuilds the token string. Exact-parse-else-
 * passthrough — anything that doesn't match the structure byte-for-byte is
 * returned verbatim, so a plain prompt (or an agent echoing the framing in
 * prose, were this ever misapplied) is never partially rewritten.
 */
import { fileUrlToPath } from '@/components/chat/chat-attachments'
import { commandToken, fileToken, skillToken } from '@/lib/skill-tokens'

/** Literal header emitted by `formatPromptWithSkills`. */
const SKILLS_HEADER = '# Agent Skills'
/** Literal separator between the framed skills and the user text. */
const SEPARATOR = '\n\n---\n\n'

const SKILL_NAME_RE = /^[\p{L}\p{N}\p{M}_.-]+$/u
/** An inline skill marker in the wire user text: `(<name>)`. */
const SKILL_MARKER_RE = /\(([\p{L}\p{N}\p{M}_.-]+)\)/gu
const COMMAND_PREFIX_RE = /^\/(\S+) /

/**
 * Parse one `name: path` header line into `(name, path)`. Returns null when
 * the line is not a well-formed, non-empty pair (first `": "` split wins, so
 * Windows paths with drive letters survive — `C:\a: b` splits on the first
 * separator only if the name part is a valid skill name).
 */
function parseHeaderLine(line: string): { name: string; path: string } | null {
  const idx = line.indexOf(': ')
  if (idx <= 0) return null
  const name = line.slice(0, idx)
  const path = line.slice(idx + 2)
  if (!SKILL_NAME_RE.test(name) || path.length === 0) return null
  return { name, path }
}

/**
 * Reconstruct the display (token) text of a persisted user prompt.
 *
 * Recognized shapes (exact, per `formatPromptWithSkills` + the command
 * prefix from `buildPromptWithLoadedSkills` callers):
 *
 * - `[/<cmd> ]# Agent Skills\n\n<name>: <path>[\n<name>: <path>...]\n\n---\n\n<user text>`
 * - `# Agent Skills\n\n<name>: <path>...` (token-free send — user text empty)
 *
 * The header section is dropped; each `(<name>)` marker in the user text
 * whose name is framed in the header becomes a skill token (inline
 * duplicates preserved, matching the forward direction). A leading
 * `/<cmd> ` prefix becomes a command token only when the framing follows. A
 * token-free send (skills section only) reconstructs the chips for its framed
 * skills. Everything else — including markers with no framed entry, a
 * body-less header, a separator with an empty user text (split-streaming
 * prefix), or a body where no marker resolves to a framed name — returns the
 * input verbatim.
 */
export function wireTextToDisplay(wire: string): string {
  if (!wire.includes(SKILLS_HEADER)) return wire
  const text = wire.replaceAll('\r\n', '\n')
  const command = framedCommandPrefix(text)
  const display = framedSkillsToDisplay(text.slice(command?.[0].length ?? 0))
  if (display === null) return wire
  if (command === null) return display
  return display.length > 0 ? `${commandToken(command[1])} ${display}` : commandToken(command[1])
}

function framedCommandPrefix(text: string): RegExpExecArray | null {
  const match = COMMAND_PREFIX_RE.exec(text)
  return match && text.slice(match[0].length).startsWith(SKILLS_HEADER) ? match : null
}

function framedSkillsToDisplay(body: string): string | null {
  if (!body.startsWith(SKILLS_HEADER)) return null
  // `formatPromptWithSkills` emits `header\n\n` + lines; no body when the
  // user text was empty (the skills section IS the whole wire).
  const afterHeader = body.slice(SKILLS_HEADER.length)
  if (!afterHeader.startsWith('\n\n')) return null
  const headerAndBody = afterHeader.slice(2)

  let headerLines: string
  let userText: string
  const sepIdx = headerAndBody.indexOf(SEPARATOR)
  if (sepIdx === -1) {
    // Token-free send: no separator, no user text.
    if (headerAndBody.includes('\n\n')) return null
    headerLines = headerAndBody
    userText = ''
  } else {
    headerLines = headerAndBody.slice(0, sepIdx)
    userText = headerAndBody.slice(sepIdx + SEPARATOR.length)
    // A framing header never contains blank lines; a second `\n\n` inside the
    // "header" region means this is not our framing.
    if (headerLines.includes('\n\n')) return null
    if (headerLines.length === 0) return null
  }

  // Parse every header line; any malformed line aborts (passthrough).
  const framed = new Set<string>()
  for (const line of headerLines.split('\n')) {
    const parsed = parseHeaderLine(line)
    if (!parsed) return null
    framed.add(parsed.name)
  }
  if (framed.size === 0) return null

  // Split-streaming prefix: the wire framing is being re-streamed across
  // several chunks and this fragment ends at the separator with an empty user
  // text. Normalizing now would rewrite it to `''` — the empty-chunk guards
  // downstream would drop the framing half, and the continuation alone can
  // never parse. Keep the raw fragment so the coalesced post-append
  // normalization (recovery fold + `_onMessageChunk`) sees the complete
  // framing once the marker-bearing continuation lands.
  if (sepIdx !== -1 && userText.length === 0) return null

  // Token-free send (no separator): the skills section is the whole wire.
  // Reconstruct the chips for the framed skills — never `''`, which would
  // blank the bubble and make `partitionTranscriptTurns` hide the whole turn
  // (its agent reply included) as a hidden no-content turn.
  if (sepIdx === -1) return [...framed].map((name) => skillToken(name)).join(' ')

  // Replace only markers whose name is framed (a typed literal `(foo)` that
  // was never a chip stays literal — the forward direction only framed real
  // chips, and unframed names have no header entry to reconstruct from).
  // When NO marker resolves to a framed name the text is not a completed
  // Termul framing — either a split prefix whose markers have not arrived or
  // prose that merely matches the shape — so it passes through verbatim.
  let resolved = false
  const display = userText.replace(SKILL_MARKER_RE, (marker, name: string) => {
    if (!framed.has(name)) return marker
    resolved = true
    return skillToken(name)
  })
  return resolved ? display : null
}

type WireBlock = { type: string; text?: string; name?: unknown; uri?: unknown }

function unambiguousFilePaths(blocks: WireBlock[]): Map<string, string> {
  const pathsByName = new Map<string, Set<string>>()
  for (const block of blocks) {
    if (
      block?.type !== 'resource_link' ||
      typeof block.name !== 'string' ||
      block.name.length === 0 ||
      typeof block.uri !== 'string' ||
      !block.uri.startsWith('file://')
    ) {
      continue
    }
    let path: string
    try {
      path = fileUrlToPath(block.uri)
    } catch {
      continue
    }
    const paths = pathsByName.get(block.name) ?? new Set<string>()
    pathsByName.set(block.name, paths.add(path))
  }
  const unambiguous = new Map<string, string>()
  for (const [name, paths] of pathsByName) {
    if (paths.size === 1) unambiguous.set(name, [...paths][0])
  }
  return unambiguous
}

function restoreFileTokens(text: string, paths: Map<string, string>): string {
  if (paths.size === 0) return text
  const markers = [...paths.keys()].map(
    (name) => `\\(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`
  )
  return text.replace(new RegExp(markers.join('|'), 'g'), (marker) => {
    const name = marker.slice(1, -1)
    const path = paths.get(name)
    return path === undefined ? marker : fileToken(name, path)
  })
}

/**
 * Apply {@link wireTextToDisplay} to every `text` block and rebuild file
 * pills from the `resource_link` blocks, which stay in place.
 */
export function wireBlocksToDisplay<T extends WireBlock>(blocks: T[] | null | undefined): T[] {
  if (!Array.isArray(blocks)) return blocks ?? []
  const filePaths = unambiguousFilePaths(blocks)
  let changed = false
  const next = blocks.map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block
    const text = restoreFileTokens(wireTextToDisplay(block.text), filePaths)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? next : blocks
}
