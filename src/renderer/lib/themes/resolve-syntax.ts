import { mixHex } from './color-utils'
import type { ColorThemeDefinition, ResolvedSyntaxColors, ThemeVariant } from './types'

function resolveVariant(variant: ThemeVariant): ResolvedSyntaxColors {
  const { palette, overrides = {} } = variant
  const muted = mixHex(palette.ink, palette.neutral, 0.45)

  return {
    keyword: overrides['syntax-keyword'] ?? palette.primary,
    comment: overrides['syntax-comment'] ?? muted,
    string: overrides['syntax-string'] ?? palette.success,
    number: overrides['syntax-constant'] ?? palette.warning,
    bool: overrides['syntax-primitive'] ?? palette.info,
    variable: overrides['syntax-variable'] ?? palette.ink,
    function: overrides['syntax-function'] ?? palette.accent,
    type: overrides['syntax-type'] ?? palette.info,
    property: overrides['syntax-property'] ?? palette.ink,
    operator: overrides['syntax-operator'] ?? palette.ink,
    punctuation: overrides['syntax-punctuation'] ?? mixHex(palette.ink, palette.neutral, 0.2),
    tag: overrides['syntax-tag'] ?? palette.primary,
    attributeName: overrides['syntax-property'] ?? palette.info,
    attributeValue: overrides['syntax-string'] ?? palette.success,
    heading: overrides['syntax-type'] ?? palette.primary,
    link: palette.primary
  }
}

/** v1: always use the dark variant. */
export function resolveSyntaxColors(theme: ColorThemeDefinition): ResolvedSyntaxColors {
  return resolveVariant(theme.dark)
}
