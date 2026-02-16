import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

export function createTermulTheme(isDark: boolean): Extension {
  return EditorView.theme(
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
  )
}
