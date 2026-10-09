import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { BUNDLED_COLOR_THEMES } from '@/lib/themes/bundled-themes'
import { resolveSyntaxColors } from '@/lib/themes/resolve-syntax'
import type { ResolvedSyntaxColors } from '@/lib/themes/types'

const defaultDarkSyntax: ResolvedSyntaxColors = resolveSyntaxColors(BUNDLED_COLOR_THEMES.termul)
const defaultLightSyntax: ResolvedSyntaxColors = resolveSyntaxColors(
  BUNDLED_COLOR_THEMES['termul-light']
)

function buildHighlightStyle(colors: ResolvedSyntaxColors): HighlightStyle {
  return HighlightStyle.define([
    { tag: tags.keyword, color: colors.keyword },
    {
      tag: [tags.comment, tags.lineComment, tags.blockComment],
      color: colors.comment,
      fontStyle: 'italic'
    },
    { tag: [tags.string, tags.special(tags.string)], color: colors.string },
    { tag: [tags.number, tags.integer, tags.float], color: colors.number },
    { tag: tags.bool, color: colors.bool },
    { tag: tags.null, color: colors.bool },
    { tag: tags.variableName, color: colors.variable },
    { tag: tags.definition(tags.variableName), color: colors.variable },
    { tag: tags.function(tags.variableName), color: colors.function },
    { tag: [tags.typeName, tags.className], color: colors.type },
    { tag: tags.propertyName, color: colors.property },
    { tag: tags.operator, color: colors.operator },
    { tag: tags.punctuation, color: colors.punctuation },
    { tag: tags.meta, color: colors.keyword },
    { tag: tags.regexp, color: colors.string },
    { tag: tags.tagName, color: colors.tag },
    { tag: tags.attributeName, color: colors.attributeName },
    { tag: tags.attributeValue, color: colors.attributeValue },
    { tag: tags.heading, color: colors.heading, fontWeight: 'bold' },
    { tag: tags.link, color: colors.link, textDecoration: 'underline' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strong, fontWeight: 'bold' }
  ])
}

export function createTermulTheme(
  isDark: boolean,
  syntaxColors?: ResolvedSyntaxColors | null
): Extension[] {
  const colors = syntaxColors ?? (isDark ? defaultDarkSyntax : defaultLightSyntax)
  const highlightStyle = buildHighlightStyle(colors)

  return [
    EditorView.theme(
      {
        '&': {
          backgroundColor: 'oklch(var(--background))',
          color: 'oklch(var(--foreground))',
          height: '100%'
        },
        '.cm-content': {
          caretColor: 'oklch(var(--primary))',
          /* Own feature set so Inter's cv/ss tags on body do not restyle this face. */
          fontFamily:
            '"Ioskeley Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontFeatureSettings: '"calt"',
          fontSize: '13px',
          lineHeight: '1.6'
        },
        '.cm-cursor, .cm-dropCursor': {
          borderLeftColor: 'oklch(var(--primary))'
        },
        /* Selection and highlights are neutral foreground washes, not the accent hue:
           see docs/design/colors.md. Search uses the warning hue. */
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
          backgroundColor: 'oklch(var(--foreground) / 0.14)'
        },
        '.cm-panels': {
          backgroundColor: 'oklch(var(--card))',
          color: 'oklch(var(--card-foreground))'
        },
        '.cm-panels.cm-panels-top': {
          borderBottom: '1px solid oklch(var(--border))'
        },
        '.cm-panels.cm-panels-bottom': {
          borderTop: '1px solid oklch(var(--border))'
        },
        '.cm-searchMatch': {
          backgroundColor: 'oklch(var(--warning) / 0.15)'
        },
        '.cm-searchMatch.cm-searchMatch-selected': {
          backgroundColor: 'oklch(var(--warning) / 0.4)',
          outline: '1px solid oklch(var(--warning))'
        },
        '.cm-activeLine': {
          backgroundColor: 'oklch(var(--foreground) / 0.03)'
        },
        '.cm-selectionMatch': {
          backgroundColor: 'oklch(var(--foreground) / 0.08)'
        },
        '.cm-matchingBracket, .cm-nonmatchingBracket': {
          backgroundColor: 'transparent',
          outline: '1px solid oklch(var(--foreground) / 0.4)'
        },
        '.cm-gutters': {
          backgroundColor: 'oklch(var(--card))',
          color: 'oklch(var(--muted-foreground))',
          borderRight: '1px solid oklch(var(--border))'
        },
        '.cm-activeLineGutter': {
          backgroundColor: 'transparent',
          color: 'oklch(var(--foreground))'
        },
        '.cm-foldPlaceholder': {
          backgroundColor: 'oklch(var(--secondary))',
          color: 'oklch(var(--muted-foreground))',
          border: 'none'
        },
        '.cm-tooltip': {
          backgroundColor: 'oklch(var(--popover))',
          color: 'oklch(var(--popover-foreground))',
          border: '1px solid oklch(var(--border))'
        },
        '.cm-tooltip .cm-tooltip-arrow:before': {
          borderTopColor: 'oklch(var(--border))',
          borderBottomColor: 'oklch(var(--border))'
        },
        '.cm-tooltip .cm-tooltip-arrow:after': {
          borderTopColor: 'oklch(var(--popover))',
          borderBottomColor: 'oklch(var(--popover))'
        },
        '.cm-tooltip.cm-tooltip-autocomplete': {
          borderRadius: '10px',
          padding: '4px',
          '& > ul > li': {
            padding: '4px 8px',
            borderRadius: '6px'
          },
          '& > ul > li[aria-selected]': {
            backgroundColor: 'oklch(var(--foreground) / 0.06)',
            color: 'oklch(var(--foreground))'
          }
        },
        '.cm-completionMatchedText': {
          fontWeight: '700',
          textDecoration: 'none'
        },
        '.cm-scroller': {
          overflow: 'auto'
        }
      },
      { dark: isDark }
    ),
    syntaxHighlighting(highlightStyle)
  ]
}
