import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

const darkHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#c586c0' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#6a9955', fontStyle: 'italic' },
  { tag: [tags.string, tags.special(tags.string)], color: '#ce9178' },
  { tag: [tags.number, tags.integer, tags.float], color: '#b5cea8' },
  { tag: tags.bool, color: '#569cd6' },
  { tag: tags.null, color: '#569cd6' },
  { tag: tags.variableName, color: '#9cdcfe' },
  { tag: tags.definition(tags.variableName), color: '#4fc1ff' },
  { tag: tags.function(tags.variableName), color: '#dcdcaa' },
  { tag: [tags.typeName, tags.className], color: '#4ec9b0' },
  { tag: tags.propertyName, color: '#9cdcfe' },
  { tag: tags.operator, color: '#d4d4d4' },
  { tag: tags.punctuation, color: '#d4d4d4' },
  { tag: tags.meta, color: '#d7ba7d' },
  { tag: tags.regexp, color: '#d16969' },
  { tag: tags.tagName, color: '#569cd6' },
  { tag: tags.attributeName, color: '#9cdcfe' },
  { tag: tags.attributeValue, color: '#ce9178' },
  { tag: tags.heading, color: '#569cd6', fontWeight: 'bold' },
  { tag: tags.link, color: '#9cdcfe', textDecoration: 'underline' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' }
])

const lightHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#af00db' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#008000', fontStyle: 'italic' },
  { tag: [tags.string, tags.special(tags.string)], color: '#a31515' },
  { tag: [tags.number, tags.integer, tags.float], color: '#098658' },
  { tag: tags.bool, color: '#0000ff' },
  { tag: tags.null, color: '#0000ff' },
  { tag: tags.variableName, color: '#001080' },
  { tag: tags.definition(tags.variableName), color: '#0070c1' },
  { tag: tags.function(tags.variableName), color: '#795e26' },
  { tag: [tags.typeName, tags.className], color: '#267f99' },
  { tag: tags.propertyName, color: '#001080' },
  { tag: tags.operator, color: '#000000' },
  { tag: tags.punctuation, color: '#000000' },
  { tag: tags.meta, color: '#af00db' },
  { tag: tags.regexp, color: '#811f3f' },
  { tag: tags.tagName, color: '#800000' },
  { tag: tags.attributeName, color: '#e50000' },
  { tag: tags.attributeValue, color: '#0000ff' },
  { tag: tags.heading, color: '#0000ff', fontWeight: 'bold' },
  { tag: tags.link, color: '#0070c1', textDecoration: 'underline' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' }
])

export function createTermulTheme(isDark: boolean): Extension[] {
  const highlightStyle = isDark ? darkHighlightStyle : lightHighlightStyle
  return [EditorView.theme(
    {
      '&': {
        backgroundColor: 'hsl(var(--background))',
        color: 'hsl(var(--foreground))',
        height: '100%'
      },
      '.cm-content': {
        caretColor: 'hsl(var(--primary))',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: '13px',
        lineHeight: '1.6'
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'hsl(var(--primary))'
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'hsl(var(--accent))'
      },
      '.cm-panels': {
        backgroundColor: 'hsl(var(--card))',
        color: 'hsl(var(--card-foreground))'
      },
      '.cm-panels.cm-panels-top': {
        borderBottom: '1px solid hsl(var(--border))'
      },
      '.cm-panels.cm-panels-bottom': {
        borderTop: '1px solid hsl(var(--border))'
      },
      '.cm-searchMatch': {
        backgroundColor: 'hsl(var(--accent) / 0.3)',
        outline: '1px solid hsl(var(--accent))'
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'hsl(var(--primary) / 0.3)'
      },
      '.cm-activeLine': {
        backgroundColor: 'hsl(var(--accent) / 0.15)'
      },
      '.cm-selectionMatch': {
        backgroundColor: 'hsl(var(--accent) / 0.2)'
      },
      '.cm-matchingBracket, .cm-nonmatchingBracket': {
        backgroundColor: 'hsl(var(--accent) / 0.3)',
        outline: '1px solid hsl(var(--accent) / 0.5)'
      },
      '.cm-gutters': {
        backgroundColor: 'hsl(var(--card))',
        color: 'hsl(var(--muted-foreground))',
        borderRight: '1px solid hsl(var(--border))'
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'hsl(var(--accent) / 0.15)',
        color: 'hsl(var(--foreground))'
      },
      '.cm-foldPlaceholder': {
        backgroundColor: 'hsl(var(--secondary))',
        color: 'hsl(var(--muted-foreground))',
        border: 'none'
      },
      '.cm-tooltip': {
        backgroundColor: 'hsl(var(--popover))',
        color: 'hsl(var(--popover-foreground))',
        border: '1px solid hsl(var(--border))'
      },
      '.cm-tooltip .cm-tooltip-arrow:before': {
        borderTopColor: 'hsl(var(--border))',
        borderBottomColor: 'hsl(var(--border))'
      },
      '.cm-tooltip .cm-tooltip-arrow:after': {
        borderTopColor: 'hsl(var(--popover))',
        borderBottomColor: 'hsl(var(--popover))'
      },
      '.cm-tooltip-autocomplete': {
        '& > ul > li[aria-selected]': {
          backgroundColor: 'hsl(var(--accent))',
          color: 'hsl(var(--accent-foreground))'
        }
      },
      '.cm-scroller': {
        overflow: 'auto'
      }
    },
    { dark: isDark }
  ), syntaxHighlighting(highlightStyle)]
}
