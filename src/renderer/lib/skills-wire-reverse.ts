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
import { commandToken, skillToken } from '@/lib/skill-tokens'

/** Literal header emitted by `formatPromptWithSkills`. */
const SKILLS_HEADER = '# Agent Skills'
/** Literal separator between the framed skills and the user text. */
const SEPARATOR = '\n\n---\n\n'

/** Skill names are non-empty word chars (letters, digits, `-`, `_`, `.`). */
const SKILL_NAME_RE = /^[\w.-]+$/
/** An inline skill marker in the wire user text: `(<name>)`. */
const SKILL_MARKER_RE = /\(([\w.-]+)\)/g

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
 * `/<cmd> ` prefix becomes a command token. A token-free send (skills
 * section only) reconstructs the chips for its framed skills. Everything
 * else — including markers with no framed entry, a body-less header, a
 * separator with an empty user text (split-streaming prefix), or a body
 * where no marker resolves to a framed name — returns the input verbatim.
 */
export function wireTextToDisplay(text: string): string {
  if (!text.includes(SKILLS_HEADER)) return text

  let body = text
  // Optional leading command prefix (wire: `/<cmd> ` + framed body).
  let command: string | null = null
  const commandMatch = body.match(/^\/(\S+) /)
  if (commandMatch && body.slice(commandMatch[0].length).startsWith(SKILLS_HEADER)) {
    command = commandMatch[1]
    body = body.slice(commandMatch[0].length)
  }

  if (!body.startsWith(SKILLS_HEADER)) return text
  // `formatPromptWithSkills` emits `header\n\n` + lines; no body when the
  // user text was empty (the skills section IS the whole wire).
  const afterHeader = body.slice(SKILLS_HEADER.length)
  if (!afterHeader.startsWith('\n\n')) return text
  const headerAndBody = afterHeader.slice(2)

  let headerLines: string
  let userText: string
  const sepIdx = headerAndBody.indexOf(SEPARATOR)
  if (sepIdx === -1) {
    // Token-free send: no separator, no user text.
    if (headerAndBody.includes('\n\n')) return text
    headerLines = headerAndBody
    userText = ''
  } else {
    headerLines = headerAndBody.slice(0, sepIdx)
    userText = headerAndBody.slice(sepIdx + SEPARATOR.length)
    // A framing header never contains blank lines; a second `\n\n` inside the
    // "header" region means this is not our framing.
    if (headerLines.includes('\n\n')) return text
    if (headerLines.length === 0) return text
  }

  // Parse every header line; any malformed line aborts (passthrough).
  const framed = new Set<string>()
  for (const line of headerLines.split('\n')) {
    const parsed = parseHeaderLine(line)
    if (!parsed) return text
    framed.add(parsed.name)
  }
  if (framed.size === 0) return text

  // Split-streaming prefix: the wire framing is being re-streamed across
  // several chunks and this fragment ends at the separator with an empty user
  // text. Normalizing now would rewrite it to `''` — the empty-chunk guards
  // downstream would drop the framing half, and the continuation alone can
  // never parse. Keep the raw fragment so the coalesced post-append
  // normalization (recovery fold + `_onMessageChunk`) sees the complete
  // framing once the marker-bearing continuation lands.
  if (sepIdx !== -1 && userText.length === 0) return text

  // Token-free send (no separator): the skills section is the whole wire.
  // Reconstruct the chips for the framed skills — never `''`, which would
  // blank the bubble and make `partitionTranscriptTurns` hide the whole turn
  // (its agent reply included) as a hidden no-content turn.
  if (sepIdx === -1) {
    let chips = [...framed].map((name) => skillToken(name)).join(' ')
    if (command) {
      chips = `${commandToken(command)}${chips.length > 0 ? ` ${chips}` : ''}`
    }
    return chips
  }

  // Replace only markers whose name is framed (a typed literal `(foo)` that
  // was never a chip stays literal — the forward direction only framed real
  // chips, and unframed names have no header entry to reconstruct from).
  // When NO marker resolves to a framed name the text is not a completed
  // Termul framing — either a split prefix whose markers have not arrived or
  // prose that merely matches the shape — so it passes through verbatim.
  let resolved = false
  let display = userText.replace(SKILL_MARKER_RE, (marker, name: string) => {
    if (!framed.has(name)) return marker
    resolved = true
    return skillToken(name)
  })
  if (!resolved) return text
  if (command) {
    display = `${commandToken(command)}${display.length > 0 ? ` ${display}` : ''}`
  }
  return display
}

/** Apply {@link wireTextToDisplay} to the text of every `text` block. */
export function wireBlocksToDisplay<T extends { type: string; text?: string }>(
  blocks: T[] | null | undefined
): T[] {
  if (!Array.isArray(blocks)) return blocks ?? []
  let changed = false
  const next = blocks.map((block) => {
    if (
      block != null &&
      typeof block === 'object' &&
      (block as T).type === 'text' &&
      typeof (block as T).text === 'string'
    ) {
      const display = wireTextToDisplay((block as T).text as string)
      if (display !== (block as T).text) {
        changed = true
        return { ...block, text: display }
      }
    }
    return block
  })
  return changed ? (next as T[]) : blocks
}
