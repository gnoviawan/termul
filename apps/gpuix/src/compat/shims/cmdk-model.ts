/** The parts of the cmdk stand-in that are plain data: part-class splitting and the filter. */

export type Part = 'group-heading' | 'group' | 'group-items' | 'item' | 'input' | 'list' | 'empty' | 'separator'
export type PartClasses = Partial<Record<Part, string>>

const PART_VARIANT = /^\[&_\[cmdk-([a-z-]+)\]\]:(.+)$/

/** Split `[&_[cmdk-x]]:cls` tokens out of a className: the element keeps the rest. */
export function splitPartClasses(className: string | undefined): { own: string; parts: PartClasses } {
  const own: string[] = []
  const parts: PartClasses = {}
  for (const token of (className ?? '').split(/\s+/).filter(Boolean)) {
    const match = token.match(PART_VARIANT)
    if (!match) {
      own.push(token)
      continue
    }
    const part = match[1] as Part
    parts[part] = parts[part] ? `${parts[part]} ${match[2]}` : match[2]
  }
  return { own: own.join(' '), parts }
}

/*
 * cmdk's command-score (cmdk 1.1.1, MIT, from Superhuman's command-score):
 * 1 for an exact run, less for each word jump, character jump, skipped gap
 * and case mismatch; 0 when the letters are not all there in order.
 */
const SCORE_CONTINUE_MATCH = 1
const SCORE_SPACE_WORD_JUMP = 0.9
const SCORE_NON_SPACE_WORD_JUMP = 0.8
const SCORE_CHARACTER_JUMP = 0.17
const SCORE_TRANSPOSITION = 0.1
const PENALTY_SKIPPED = 0.999
const PENALTY_CASE_MISMATCH = 0.9999
const PENALTY_NOT_COMPLETE = 0.99
const IS_GAP = /[\\/_+.#"@[({&]/
const COUNT_GAPS = /[\\/_+.#"@[({&]/g
const IS_SPACE = /[\s-]/
const COUNT_SPACE = /[\s-]/g

function scoreFrom(
  string: string,
  abbreviation: string,
  lowerString: string,
  lowerAbbreviation: string,
  stringIndex: number,
  abbreviationIndex: number,
  memo: Map<string, number>
): number {
  if (abbreviationIndex === abbreviation.length) {
    return stringIndex === string.length ? SCORE_CONTINUE_MATCH : PENALTY_NOT_COMPLETE
  }
  const key = `${stringIndex},${abbreviationIndex}`
  const memoized = memo.get(key)
  if (memoized !== undefined) return memoized
  const char = lowerAbbreviation.charAt(abbreviationIndex)
  let index = lowerString.indexOf(char, stringIndex)
  let high = 0
  while (index >= 0) {
    let score = scoreFrom(string, abbreviation, lowerString, lowerAbbreviation, index + 1, abbreviationIndex + 1, memo)
    if (score > high) {
      if (index === stringIndex) {
        score *= SCORE_CONTINUE_MATCH
      } else if (IS_GAP.test(string.charAt(index - 1))) {
        score *= SCORE_NON_SPACE_WORD_JUMP
        const breaks = string.slice(stringIndex, index - 1).match(COUNT_GAPS)
        if (breaks && stringIndex > 0) score *= PENALTY_SKIPPED ** breaks.length
      } else if (IS_SPACE.test(string.charAt(index - 1))) {
        score *= SCORE_SPACE_WORD_JUMP
        const breaks = string.slice(stringIndex, index - 1).match(COUNT_SPACE)
        if (breaks && stringIndex > 0) score *= PENALTY_SKIPPED ** breaks.length
      } else {
        score *= SCORE_CHARACTER_JUMP
        if (stringIndex > 0) score *= PENALTY_SKIPPED ** (index - stringIndex)
      }
      if (string.charAt(index) !== abbreviation.charAt(abbreviationIndex)) score *= PENALTY_CASE_MISMATCH
    }
    if (
      (score < SCORE_TRANSPOSITION &&
        lowerString.charAt(index - 1) === lowerAbbreviation.charAt(abbreviationIndex + 1)) ||
      (lowerAbbreviation.charAt(abbreviationIndex + 1) === lowerAbbreviation.charAt(abbreviationIndex) &&
        lowerString.charAt(index - 1) !== lowerAbbreviation.charAt(abbreviationIndex))
    ) {
      const transposed = scoreFrom(string, abbreviation, lowerString, lowerAbbreviation, index + 1, abbreviationIndex + 2, memo)
      if (transposed * SCORE_TRANSPOSITION > score) score = transposed * SCORE_TRANSPOSITION
    }
    if (score > high) high = score
    index = lowerString.indexOf(char, index + 1)
  }
  memo.set(key, high)
  return high
}

const lowered = (value: string) => value.toLowerCase().replace(COUNT_SPACE, ' ')

/** cmdk's default filter: the item's value and keywords scored against the search. */
export function commandScore(value: string, search: string, keywords: readonly string[] = []): number {
  const string = keywords.length > 0 ? `${value} ${keywords.join(' ')}` : value
  return scoreFrom(string, search, lowered(string), lowered(search), 0, 0, new Map())
}

/** Where an item renders: its slot among the list's children, its group, and its slot in that group. */
export interface Placement {
  listSlot: number
  group: string | null
  groupSlot: number
}

/** The display order cmdk's sort produces, as child slots of the list and of each group; unlisted slots render first. */
export interface SlotOrder {
  list: number[]
  groups: Map<string, number[]>
}

const bestFirst = (scores: Map<number, number>): number[] =>
  [...scores].sort(([slotA, a], [slotB, b]) => b - a || slotA - slotB).map(([slot]) => slot)

/**
 * cmdk's sort for a non-empty search: in each group its items by score, and
 * the ungrouped items by score moved after everything else in the list. Ties
 * keep source order. cmdk also means to sort groups by their best item, but
 * it looks each group up by id in `data-value`, which holds the heading, so
 * groups keep source order; this keeps them there too.
 */
export function slotOrder(visible: readonly { placement: Placement; score: number }[]): SlotOrder {
  const groupSlots = new Map<string, Map<number, number>>()
  const ungrouped = new Map<number, number>()
  for (const { placement, score } of visible) {
    const { listSlot, group, groupSlot } = placement
    if (group === null) {
      ungrouped.set(listSlot, Math.max(score, ungrouped.get(listSlot) ?? 0))
      continue
    }
    const slots = groupSlots.get(group) ?? new Map<number, number>()
    slots.set(groupSlot, Math.max(score, slots.get(groupSlot) ?? 0))
    groupSlots.set(group, slots)
  }
  return {
    list: bestFirst(ungrouped),
    groups: new Map([...groupSlots].map(([group, slots]) => [group, bestFirst(slots)]))
  }
}

/** `slots` in display order: unranked ones first in source order, then `ranked`. */
export function orderedSlots(count: number, ranked: readonly number[] | undefined): number[] {
  const all = Array.from({ length: count }, (_, i) => i)
  if (!ranked) return all
  const listed = ranked.filter((slot) => slot < count)
  const set = new Set(listed)
  return [...all.filter((slot) => !set.has(slot)), ...listed]
}
