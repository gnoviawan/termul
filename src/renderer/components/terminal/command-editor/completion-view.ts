import {
  autocompletion,
  type Completion,
  closeCompletion,
  completionStatus,
  currentCompletions,
  insertCompletionText,
  moveCompletionSelection,
  pickedCompletion,
  selectedCompletion,
  startCompletion
} from '@codemirror/autocomplete'
import { cursorCharRight } from '@codemirror/commands'
import { type EditorState, type Extension, Prec, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from '@codemirror/view'
import { termulTooltipThemeSpec } from '@/components/editor/codemirror-theme'
import type { CompletionOutputRow } from '@/lib/command-lifecycle/completion-output'

export interface CompletionViewSource {
  /** Parsed rows of the scheduler's current valid result, or none. */
  rows: () => readonly CompletionOutputRow[]
  /** Explicit request; the scheduler decides whether an RPC starts. */
  request: () => void
}

interface RowCompletion extends Completion {
  row: CompletionOutputRow
}

class GhostWidget extends WidgetType {
  constructor(readonly suffix: string) {
    super()
  }

  eq(other: GhostWidget): boolean {
    return this.suffix === other.suffix
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-completion-ghost'
    span.textContent = this.suffix
    return span
  }
}

function ghostDecorations(state: EditorState): DecorationSet {
  if (completionStatus(state) !== 'active') return Decoration.none
  const row = (selectedCompletion(state) as RowCompletion | null)?.row
  const { head, empty } = state.selection.main
  if (!row || !empty || head !== row.to || row.from < 0 || row.from > head) return Decoration.none
  const typed = state.doc.sliceString(row.from, head)
  const suffix = row.text.startsWith(typed) ? row.text.slice(typed.length) : ''
  return suffix
    ? Decoration.set([Decoration.widget({ widget: new GhostWidget(suffix), side: 1 }).range(head)])
    : Decoration.none
}

const ghostField = StateField.define<DecorationSet>({
  create: ghostDecorations,
  update: (_decorations, transaction) => ghostDecorations(transaction.state),
  provide: (field) => EditorView.decorations.from(field)
})

export function ghostText(state: EditorState): string | null {
  const decoration = state.field(ghostField, false)?.iter().value
  return decoration ? (decoration.spec.widget as GhostWidget).suffix : null
}

function completionResult(source: CompletionViewSource) {
  const rows = source.rows()
  return rows.length
    ? {
        from: rows[0].from,
        to: rows[0].to,
        options: rows.map(
          (row): RowCompletion => ({
            label: row.text,
            row,
            apply: (view, completion) => {
              view.dispatch({
                ...insertCompletionText(view.state, row.text, row.from, row.to),
                annotations: pickedCompletion.of(completion)
              })
              closeCompletion(view)
            }
          })
        )
      }
    : null
}

export function completionView(source: CompletionViewSource): Extension {
  return [
    autocompletion({
      override: [() => completionResult(source)],
      defaultKeymap: false,
      activateOnTyping: false,
      interactionDelay: 0,
      selectOnOpen: true,
      aboveCursor: true
    }),
    ghostField,
    EditorView.baseTheme({
      '.cm-completion-ghost': { color: 'oklch(var(--muted-foreground))' }
    }),
    EditorView.theme(termulTooltipThemeSpec),
    completionKeymap(source)
  ]
}

function completionKeymap(source: CompletionViewSource): Extension {
  return Prec.highest(
    keymap.of([
      {
        key: 'Tab',
        run: (view) => {
          if (completionStatus(view.state) === 'active') return acceptHighlighted(view)
          source.request()
          return true
        }
      },
      {
        key: 'ArrowRight',
        run: (view) => {
          if (ghostText(view.state) === null) return false
          if (view.state.selection.main.head === view.state.doc.length) {
            return acceptHighlighted(view)
          }
          cursorCharRight(view)
          return true
        }
      },
      {
        key: 'Escape',
        run: (view) => {
          if (!completionStatus(view.state)) return false
          closeCompletion(view)
          return true
        }
      },
      { key: 'ArrowUp', run: moveCompletionSelection(false) },
      { key: 'ArrowDown', run: moveCompletionSelection(true) }
    ])
  )
}

export function showCompletion(view: EditorView): void {
  startCompletion(view)
}

export function acceptHighlighted(view: EditorView, index?: number): boolean {
  const completion =
    index === undefined ? selectedCompletion(view.state) : currentCompletions(view.state)[index]
  if (view.state.readOnly || typeof completion?.apply !== 'function') return false
  completion.apply(view, completion, 0, 0)
  return true
}
