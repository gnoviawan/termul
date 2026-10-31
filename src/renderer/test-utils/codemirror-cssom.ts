import type { EditorView } from '@codemirror/view'

/**
 * Base theme IDs ͼ2 (light) and ͼ3 (dark) are internal fallbacks in CodeMirror
 * that define default black/white caret and background values.
 * Filtering them out ensures we query only the structural base or custom theme rules.
 */
const BASE_THEME_IDS = new Set(['ͼ2', 'ͼ3'])

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function themeClassRegexes(view: EditorView): RegExp[] {
  return (view.themeClasses ?? '')
    .split(/\s+/)
    .map((c) => c.trim())
    .filter((c) => Boolean(c) && !BASE_THEME_IDS.has(c))
    .map((cls) => new RegExp(`\\.${escapeRegex(cls)}(?![\\w\\u0080-\\uFFFF-])`))
}

function branchMatches(
  branch: string,
  classRegexes: readonly RegExp[],
  targetRegex: RegExp,
  requireEnd: RegExp | null
): boolean {
  if (!targetRegex.test(branch)) return false
  if (requireEnd && !requireEnd.test(branch)) return false
  return classRegexes.some((regex) => regex.test(branch))
}

/**
 * Searches the document styleSheets for a CSSOM rule property applied
 * to a specific selector target within an EditorView's theme.
 *
 * Matches branches where:
 * 1. The branch contains the view's theme class as a whole class token (e.g. `.ͼ1` does not match `.ͼ10`).
 * 2. The branch contains the target selector class as a whole token (e.g. `.cm-cursor` does not match `.cm-dropCursor`).
 * 3. When `selectorTarget` is `.cm-content`, the branch must end with `.cm-content` to prevent matching
 *    pseudo-elements or descendant tails like `.cm-content ::selection`.
 */
export function findThemeRuleValue(
  view: EditorView,
  selectorTarget: string,
  property: string
): string | null {
  const classRegexes = themeClassRegexes(view)
  if (classRegexes.length === 0) return null

  const targetClass = selectorTarget.startsWith('.') ? selectorTarget.slice(1) : selectorTarget
  const targetRegex = new RegExp(`\\.${escapeRegex(targetClass)}(?![\\w\\u0080-\\uFFFF-])`)
  const isContent = targetClass === 'cm-content' || selectorTarget === '.cm-content'
  const requireEnd = isContent ? new RegExp(`\\.${escapeRegex(targetClass)}$`) : null

  let result: string | null = null

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSStyleRule)) continue

        const branches = rule.selectorText
          .split(',')
          .map((b) => b.trim())
          .filter(Boolean)
        for (const branch of branches) {
          if (branchMatches(branch, classRegexes, targetRegex, requireEnd)) {
            const val = rule.style.getPropertyValue(property)
            if (val) result = val
            break
          }
        }
      }
    } catch {
      // Ignore cross-origin stylesheet access security errors or invalid rules
    }
  }

  return result
}
