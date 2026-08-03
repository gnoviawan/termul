/**
 * Synchronous canvas-based measurement of the invisible padding a skill token
 * needs so the transparent textarea text is as wide as the `SkillChip` pill
 * the overlay paints over it.
 *
 * Why this exists: the transparent textarea renders the token text
 * (`\uE000<name>\uE001`) as invisible glyphs, so the token's visible width is
 * just the `name` (sentinels are zero-width in most fonts). The overlay's
 * `SkillChip` is wider than that — it adds a `Sparkles` icon, pill padding
 * (`px-1.5`), border, gap, and renders the name at `text-xs` while the textarea
 * uses `text-sm`. Without compensation the textarea caret (placed at the end of
 * the token text) lands to the LEFT of the chip's right edge — "behind" the
 * chip by the chip's overhead (roughly 6 chars for a 12-char skill name).
 *
 * `measureSkillPadding` returns a run of FIGURE SPACE chars whose total width
 * fills the gap between the chip's rendered width and the token text's natural
 * width, so the caret lands at the chip's right edge. It is synchronous
 * (canvas `measureText`, no DOM layout) so it can run inside `handleSelect`
 * at pick time — no deferred value update, no render loop. Returns '' when a
 * canvas is unavailable (non-browser / jsdom), degrading to the unpadded token
 * (the prior behavior; the caret lands slightly behind the chip but nothing
 * crashes).
 */
import { SKILL_PAD_CHAR } from '@/lib/skill-tokens'

/**
 * Horizontal overhead of the `SkillChip` pill beyond its name text, in CSS px.
 * Sum of: `px-1.5` (6+6) + `border` (1+1) + `gap-1` (4) + `Sparkles size=12`
 * = 30. MUST be kept in sync with `SkillChip.tsx`'s classes; if the chip's
 * padding/border/gap/icon changes, update this constant.
 */
export const SKILL_CHIP_OVERHEAD_PX = 30

// Tailwind text-sm / text-xs rem ratios (0.875rem / 0.75rem). The textarea
// (text-sm) is the width reference; the chip name uses text-xs. Derived from
// the textarea's computed font-size so a non-standard rem base still works.
const TEXT_XS_RATIO = 12 / 14

let canvasCtx: CanvasRenderingContext2D | null = null

function getCanvasCtx(): CanvasRenderingContext2D | null {
  if (canvasCtx) return canvasCtx
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvasCtx = canvas.getContext('2d')
  return canvasCtx
}

/**
 * Measure the FIGURE-SPACE padding string needed to align the textarea caret
 * with the right edge of the `SkillChip` rendered over the token. Returns ''
 * when measurement is unavailable (jsdom / no canvas), so callers degrade to
 * the unpadded token.
 *
 * @param name the skill name (rendered both as transparent textarea text and
 *   inside the chip).
 * @param textareaEl the composer textarea — its computed font-family, weight,
 *   and size define the transparent token text's width. May be null in tests.
 */
export function measureSkillPadding(name: string, textareaEl: HTMLTextAreaElement | null): string {
  if (!textareaEl) return ''
  const ctx = getCanvasCtx()
  if (!ctx) return ''
  const cs = window.getComputedStyle(textareaEl)
  const fontFamily = cs.fontFamily || 'sans-serif'
  const taWeight = cs.fontWeight || '400'
  // The textarea renders at text-sm; read the actual computed size so a
  // non-standard rem base / zoom is respected.
  const taSize = parseFloat(cs.fontSize) || 14
  const xsSize = taSize * TEXT_XS_RATIO

  // Token text width: the name in the textarea's font (sentinels are
  // zero-width, so only the name contributes).
  ctx.font = `${taWeight} ${taSize}px ${fontFamily}`
  const tokenNameWidth = ctx.measureText(name).width
  const padCharWidth = ctx.measureText(SKILL_PAD_CHAR).width

  // Chip name width: the name in the chip's font (text-xs, font-medium=500).
  ctx.font = `500 ${xsSize}px ${fontFamily}`
  const chipNameWidth = ctx.measureText(name).width

  const chipWidth = SKILL_CHIP_OVERHEAD_PX + chipNameWidth
  const deficitPx = chipWidth - tokenNameWidth
  if (deficitPx <= 0 || padCharWidth <= 0) return ''
  // Round to the nearest figure-space. Rounding (rather than ceiling) keeps
  // the residual within half a pad char (~4px) and avoids systematically
  // over-padding — an over-padded caret floats past the chip into the trailing
  // space gap, which reads worse than a 1-2px under-pad.
  const count = Math.round(deficitPx / padCharWidth)
  return count > 0 ? SKILL_PAD_CHAR.repeat(count) : ''
}
