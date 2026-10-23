/**
 * The GPUIX code editor's document model: a CodeMirror `EditorState` (the
 * web editor's own buffer, selection, history and language) plus the goal
 * column of a run of vertical moves. Every change goes through `execute`.
 *
 * `@codemirror/state`, `@codemirror/language` and the state commands of
 * `@codemirror/commands` run without a DOM, so undo grouping, Enter
 * indentation, Tab indent and comment toggling are the web's. Motions that
 * CodeMirror computes from a DOM view (by character, word, line, page,
 * line boundary) are reimplemented here over the document text: lines never
 * wrap on this client, and one character is one column (tabs expand to
 * `tabSize`).
 */

import {
  copyLineDown,
  copyLineUp,
  deleteCharBackward,
  deleteCharForward,
  deleteGroupBackward,
  deleteGroupForward,
  history,
  indentLess,
  indentMore,
  insertBlankLine,
  insertNewlineAndIndent,
  moveLineDown,
  moveLineUp,
  redo,
  selectAll,
  simplifySelection,
  toggleComment,
  undo
} from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import {
  CharCategory,
  countColumn,
  EditorSelection,
  EditorState,
  type Extension,
  findClusterBreak,
  findColumn,
  type SelectionRange,
  type StateCommand,
  StateEffect,
  Transaction
} from '@codemirror/state'
import type { Command } from '@codemirror/view'

export const TAB_SIZE = 4

export type Motion =
  | 'charLeft'
  | 'charRight'
  | 'groupLeft'
  | 'groupRight'
  | 'lineUp'
  | 'lineDown'
  | 'pageUp'
  | 'pageDown'
  | 'lineStart'
  | 'lineEnd'
  | 'docStart'
  | 'docEnd'

/**
 * `deleteCharBackward`/`Forward` are typed as view commands, but they read only
 * `state` and `dispatch` (their atomic-range step runs only for an
 * `EditorView`), which the model tests pin.
 */
const viewFree = (command: Command): StateCommand => command as unknown as StateCommand

const STATE_COMMANDS = {
  deleteCharBackward: viewFree(deleteCharBackward),
  deleteCharForward: viewFree(deleteCharForward),
  deleteGroupBackward,
  deleteGroupForward,
  insertNewlineAndIndent,
  insertBlankLine,
  indentMore,
  indentLess,
  undo,
  redo,
  selectAll,
  simplifySelection,
  toggleComment,
  moveLineUp,
  moveLineDown,
  copyLineUp,
  copyLineDown
} satisfies Record<string, StateCommand>

export type CommandName = keyof typeof STATE_COMMANDS

export type EditorCommand =
  | { kind: 'move'; motion: Motion; extend: boolean }
  | { kind: 'insert'; text: string }
  | { kind: 'run'; command: CommandName }
  | { kind: 'cursor'; pos: number; extend: boolean }
  | { kind: 'select'; anchor: number; head: number }

export interface EditorModel {
  readonly state: EditorState
  /** Column a run of vertical moves aims for; null after any other command. */
  readonly goalColumn: number | null
}

export interface ExecuteContext {
  /** Lines a page motion moves by. */
  pageLines: number
}

function baseExtensions(extensions: readonly Extension[]): Extension[] {
  return [
    history(),
    EditorState.tabSize.of(TAB_SIZE),
    indentUnit.of('  '),
    EditorState.allowMultipleSelections.of(false),
    ...extensions
  ]
}

export function createModel(doc: string, extensions: readonly Extension[] = []): EditorModel {
  return {
    state: EditorState.create({ doc, extensions: baseExtensions(extensions) }),
    goalColumn: null
  }
}

/** Swap the configuration (language, read-only); the document, selection and history stay. */
export function reconfigure(model: EditorModel, extensions: readonly Extension[]): EditorModel {
  const tr = model.state.update({ effects: StateEffect.reconfigure.of(baseExtensions(extensions)) })
  return { state: tr.state, goalColumn: model.goalColumn }
}

/** A file reload or other external content: replaces the text outside the undo history. */
export function replaceDocument(model: EditorModel, text: string): EditorModel {
  const { state } = model
  if (state.doc.toString() === text) return model
  const tr = state.update({
    changes: { from: 0, to: state.doc.length, insert: text },
    selection: EditorSelection.cursor(Math.min(state.selection.main.head, text.length)),
    annotations: Transaction.addToHistory.of(false)
  })
  return { state: tr.state, goalColumn: null }
}

function runStateCommand(state: EditorState, command: StateCommand): EditorState {
  let next = state
  command({
    state,
    dispatch: (tr: Transaction) => {
      next = tr.state
    }
  })
  return next
}

/** Visual column of `pos` on its line, tabs expanded. */
export function columnAt(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos)
  return countColumn(line.text.slice(0, pos - line.from), state.tabSize)
}

/** Document position on line `lineNumber` closest to visual column `column`. */
export function posAtColumn(state: EditorState, lineNumber: number, column: number): number {
  const line = state.doc.line(Math.min(Math.max(1, lineNumber), state.doc.lines))
  return line.from + findColumn(line.text, Math.max(0, column), state.tabSize, false)
}

function moveByChar(state: EditorState, pos: number, forward: boolean): number {
  const line = state.doc.lineAt(pos)
  if (forward ? pos === line.to : pos === line.from) {
    return forward ? Math.min(state.doc.length, pos + 1) : Math.max(0, pos - 1)
  }
  return line.from + findClusterBreak(line.text, pos - line.from, forward)
}

/** Word motion: skip spaces, then one run of characters of the same category; a line edge is its own stop. */
function moveByGroup(state: EditorState, start: number, forward: boolean): number {
  const line = state.doc.lineAt(start)
  if (forward ? start === line.to : start === line.from) return moveByChar(state, start, forward)
  const categorize = state.charCategorizer(start)
  let pos = start
  let category: CharCategory | null = null
  while (forward ? pos < line.to : pos > line.from) {
    const next = line.from + findClusterBreak(line.text, pos - line.from, forward)
    const char = line.text.slice(Math.min(pos, next) - line.from, Math.max(pos, next) - line.from)
    const nextCategory = categorize(char)
    if (category === null) {
      if (nextCategory !== CharCategory.Space) category = nextCategory
    } else if (nextCategory !== category) {
      break
    }
    pos = next
  }
  return pos
}

/** Home: the end of the indentation, or the line start when already there. */
function lineStart(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos)
  const indentEnd = line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0)
  return pos === indentEnd ? line.from : indentEnd
}

interface MoveResult {
  head: number
  goalColumn: number | null
}

function move(
  state: EditorState,
  range: SelectionRange,
  motion: Motion,
  extend: boolean,
  goalColumn: number | null,
  pageLines: number
): MoveResult {
  const collapse = !extend && !range.empty
  switch (motion) {
    case 'charLeft':
      return {
        head: collapse ? range.from : moveByChar(state, range.head, false),
        goalColumn: null
      }
    case 'charRight':
      return { head: collapse ? range.to : moveByChar(state, range.head, true), goalColumn: null }
    case 'groupLeft':
      return { head: moveByGroup(state, range.head, false), goalColumn: null }
    case 'groupRight':
      return { head: moveByGroup(state, range.head, true), goalColumn: null }
    case 'lineUp':
    case 'lineDown':
    case 'pageUp':
    case 'pageDown': {
      const by = motion === 'lineUp' || motion === 'lineDown' ? 1 : Math.max(1, pageLines)
      const up = motion === 'lineUp' || motion === 'pageUp'
      const goal = goalColumn ?? columnAt(state, range.head)
      const current = state.doc.lineAt(range.head).number
      const target = current + (up ? -by : by)
      if (target < 1) return { head: 0, goalColumn: goal }
      if (target > state.doc.lines) return { head: state.doc.length, goalColumn: goal }
      return { head: posAtColumn(state, target, goal), goalColumn: goal }
    }
    case 'lineStart':
      return { head: lineStart(state, range.head), goalColumn: null }
    case 'lineEnd':
      return { head: state.doc.lineAt(range.head).to, goalColumn: null }
    case 'docStart':
      return { head: 0, goalColumn: null }
    case 'docEnd':
      return { head: state.doc.length, goalColumn: null }
  }
}

function withSelection(
  model: EditorModel,
  selection: EditorSelection,
  goalColumn: number | null
): EditorModel {
  const tr = model.state.update({ selection, scrollIntoView: true, userEvent: 'select' })
  return { state: tr.state, goalColumn }
}

export function execute(
  model: EditorModel,
  command: EditorCommand,
  context: ExecuteContext
): EditorModel {
  const { state } = model
  switch (command.kind) {
    case 'move': {
      const range = state.selection.main
      const { head, goalColumn } = move(
        state,
        range,
        command.motion,
        command.extend,
        model.goalColumn,
        context.pageLines
      )
      const next = command.extend
        ? EditorSelection.range(range.anchor, head)
        : EditorSelection.cursor(head)
      return withSelection(model, EditorSelection.create([next]), goalColumn)
    }
    case 'cursor': {
      const pos = Math.min(Math.max(0, command.pos), state.doc.length)
      const range = command.extend
        ? EditorSelection.range(state.selection.main.anchor, pos)
        : EditorSelection.cursor(pos)
      return withSelection(model, EditorSelection.create([range]), null)
    }
    case 'select': {
      const clamp = (pos: number) => Math.min(Math.max(0, pos), state.doc.length)
      return withSelection(
        model,
        EditorSelection.create([EditorSelection.range(clamp(command.anchor), clamp(command.head))]),
        null
      )
    }
    case 'insert': {
      if (state.readOnly || command.text === '') return model
      const tr = state.update(state.replaceSelection(command.text), {
        scrollIntoView: true,
        userEvent: command.text.length === 1 ? 'input.type' : 'input.paste'
      })
      return { state: tr.state, goalColumn: null }
    }
    case 'run': {
      const next = runStateCommand(state, STATE_COMMANDS[command.command])
      return next === state ? model : { state: next, goalColumn: null }
    }
  }
}

export function selectedText(model: EditorModel): string {
  const { from, to } = model.state.selection.main
  return model.state.sliceDoc(from, to)
}

/** 1-based line and column of the caret, as the editor store records it. */
export function caretLineCol(state: EditorState): { line: number; col: number } {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  return { line: line.number, col: head - line.from + 1 }
}

/** The position the store's 1-based line and column point at, clamped into the document. */
export function posAtLineCol(state: EditorState, line: number, col: number): number {
  const target = state.doc.line(Math.min(Math.max(1, Math.trunc(line)), state.doc.lines))
  return Math.min(target.to, target.from + Math.max(1, Math.trunc(col)) - 1)
}
