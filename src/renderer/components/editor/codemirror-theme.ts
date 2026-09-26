import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import type { ResolvedSyntaxColors } from '@/lib/themes/types'

const defaultDarkSyntax: ResolvedSyntaxColors = {
  keyword: '#c586c0',
  comment: '#6a9955',
  string: '#ce9178',
  number: '#b5cea8',
  bool: '#569cd6',
  variable: '#9cdcfe',
  function: '#dcdcaa',
  type: '#4ec9b0',
  property: '#9cdcfe',
  operator: '#d4d4d4',
  punctuation: '#d4d4d4',
  tag: '#569cd6',
  attributeName: '#9cdcfe',
  attributeValue: '#ce9178',
  heading: '#569cd6',
  link: '#9cdcfe'
}

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
  const colors = syntaxColors ?? defaultDarkSyntax
  const highlightStyle = buildHighlightStyle(isDark ? colors : colors)

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
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: '13px',
          lineHeight: '1.6'
        },
        '.cm-cursor, .cm-dropCursor': {
          borderLeftColor: 'oklch(var(--primary))'
        },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
          backgroundColor: 'oklch(var(--accent))'
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
          backgroundColor: 'oklch(var(--accent) / 0.3)',
          outline: '1px solid oklch(var(--accent))'
        },
        '.cm-searchMatch.cm-searchMatch-selected': {
          backgroundColor: 'oklch(var(--primary) / 0.3)'
        },
        '.cm-activeLine': {
          backgroundColor: 'oklch(var(--accent) / 0.15)'
        },
        '.cm-selectionMatch': {
          backgroundColor: 'oklch(var(--accent) / 0.2)'
        },
        '.cm-matchingBracket, .cm-nonmatchingBracket': {
          backgroundColor: 'oklch(var(--accent) / 0.3)',
          outline: '1px solid oklch(var(--accent) / 0.5)'
        },
        '.cm-gutters': {
          backgroundColor: 'oklch(var(--card))',
          color: 'oklch(var(--muted-foreground))',
          borderRight: '1px solid oklch(var(--border))'
        },
        '.cm-activeLineGutter': {
          backgroundColor: 'oklch(var(--accent) / 0.15)',
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
        '.cm-tooltip-autocomplete': {
          '& > ul > li[aria-selected]': {
            backgroundColor: 'oklch(var(--accent))',
            color: 'oklch(var(--accent-foreground))'
          }
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
