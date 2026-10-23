/**
 * Key -> editor intent, mirroring the web editor's keymaps
 * (`defaultKeymap`, `historyKeymap`, `indentWithTab` and the Mod-s save
 * binding in `hooks/use-codemirror.ts`). Keys this table does not own come
 * back as `null` so the app's own shortcuts keep working.
 */

import type { CommandName, EditorCommand, Motion } from './model'

export interface KeyInput {
  /** GPUI key name: `a`, `left`, `pageup`, `backspace`, `enter`. */
  key: string
  /** The character the key produced, when it produced one. */
  keyChar?: string | null
  modifiers?: { shift?: boolean; ctrl?: boolean; alt?: boolean; cmd?: boolean }
}

export type KeyIntent =
  | { kind: 'edit'; command: EditorCommand }
  | { kind: 'save' }
  | { kind: 'copy' }
  | { kind: 'cut' }
  | { kind: 'paste' }

/** Mod is Cmd on macOS and Ctrl elsewhere, as CodeMirror resolves it. */
export const IS_MAC = typeof process !== 'undefined' && process.platform === 'darwin'

const MOTIONS: Readonly<Record<string, Motion>> = {
  left: 'charLeft',
  right: 'charRight',
  up: 'lineUp',
  down: 'lineDown',
  pageup: 'pageUp',
  pagedown: 'pageDown',
  home: 'lineStart',
  end: 'lineEnd'
}

const run = (command: CommandName): KeyIntent => ({
  kind: 'edit',
  command: { kind: 'run', command }
})
const moveBy = (motion: Motion, extend: boolean): KeyIntent => ({
  kind: 'edit',
  command: { kind: 'move', motion, extend }
})

export function keyIntent(input: KeyInput): KeyIntent | null {
  const { key } = input
  const shift = input.modifiers?.shift === true
  const ctrl = input.modifiers?.ctrl === true
  const alt = input.modifiers?.alt === true
  const cmd = input.modifiers?.cmd === true
  const mod = IS_MAC ? cmd : ctrl
  const wordMod = IS_MAC ? alt : ctrl

  const motion = MOTIONS[key]
  if (motion) {
    if (alt && !mod && (key === 'up' || key === 'down')) {
      if (shift) return run(key === 'up' ? 'copyLineUp' : 'copyLineDown')
      return run(key === 'up' ? 'moveLineUp' : 'moveLineDown')
    }
    if (wordMod && (key === 'left' || key === 'right')) {
      return moveBy(key === 'left' ? 'groupLeft' : 'groupRight', shift)
    }
    if (mod && (key === 'home' || key === 'end')) {
      return moveBy(key === 'home' ? 'docStart' : 'docEnd', shift)
    }
    if (IS_MAC && cmd && (key === 'up' || key === 'down')) {
      return moveBy(key === 'up' ? 'docStart' : 'docEnd', shift)
    }
    if (IS_MAC && cmd && (key === 'left' || key === 'right')) {
      return moveBy(key === 'left' ? 'lineStart' : 'lineEnd', shift)
    }
    if (ctrl || cmd || alt) return null
    return moveBy(motion, shift)
  }

  switch (key) {
    case 'backspace':
      return run(wordMod ? 'deleteGroupBackward' : 'deleteCharBackward')
    case 'delete':
      return run(wordMod ? 'deleteGroupForward' : 'deleteCharForward')
    case 'enter':
      return run(mod ? 'insertBlankLine' : 'insertNewlineAndIndent')
    case 'tab':
      return mod || alt ? null : run(shift ? 'indentLess' : 'indentMore')
    case 'escape':
      return run('simplifySelection')
  }

  if (mod && !alt) {
    switch (key) {
      case 's':
        return shift ? null : { kind: 'save' }
      case 'a':
        return shift ? null : run('selectAll')
      case 'z':
        return run(shift ? 'redo' : 'undo')
      case 'y':
        return IS_MAC || shift ? null : run('redo')
      case 'c':
        return shift ? null : { kind: 'copy' }
      case 'x':
        return shift ? null : { kind: 'cut' }
      case 'v':
        return shift ? null : { kind: 'paste' }
      case '/':
        return run('toggleComment')
      case '[':
        return run('indentLess')
      case ']':
        return run('indentMore')
    }
    return null
  }
  if (ctrl || cmd) return null

  const char = key === 'space' ? ' ' : input.keyChar
  if (char && [...char].every((c) => (c.codePointAt(0) ?? 0) >= 0x20 && c !== '\u007f')) {
    return { kind: 'edit', command: { kind: 'insert', text: char } }
  }
  return null
}
