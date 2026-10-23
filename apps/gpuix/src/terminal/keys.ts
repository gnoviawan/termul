/**
 * Key press to PTY bytes, following xterm.js `evaluateKeyboardEvent`
 * (xterm/src/common/input/Keyboard.ts, MIT) for a non-mac platform: Alt
 * prefixes ESC, Ctrl maps letters to C0 and digits 3..7 to ESC..US. GPUIX
 * reports `key` as GPUI's lowercase key name and `keyChar` as the typed
 * character. Kybern's `terminal/keys.ts` (MIT) was the reference for the GPUI
 * key names.
 */
export interface KeyModifiers {
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
  cmd?: boolean
}

export interface KeyPress {
  key?: string
  keyChar?: string
  modifiers?: KeyModifiers
}

export type KeyAction =
  | { type: 'send'; data: string }
  | { type: 'page'; direction: -1 | 1 }
  | { type: 'copy' }
  | { type: 'paste' }
  | { type: 'none' }

const ESC = '\x1b'

const SHIFTED_DIGITS: Record<string, string> = {
  '0': ')',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '('
}

const CTRL_PUNCTUATION: Record<string, string> = {
  '[': ESC,
  '\\': '\x1c',
  ']': '\x1d',
  '/': '\x1f',
  '3': '\x1b',
  '4': '\x1c',
  '5': '\x1d',
  '6': '\x1e',
  '7': '\x1f',
  '8': '\x7f'
}

const FUNCTION_KEYS: Record<string, [string, string]> = {
  f1: ['OP', '[1;{m}P'],
  f2: ['OQ', '[1;{m}Q'],
  f3: ['OR', '[1;{m}R'],
  f4: ['OS', '[1;{m}S'],
  f5: ['[15~', '[15;{m}~'],
  f6: ['[17~', '[17;{m}~'],
  f7: ['[18~', '[18;{m}~'],
  f8: ['[19~', '[19;{m}~'],
  f9: ['[20~', '[20;{m}~'],
  f10: ['[21~', '[21;{m}~'],
  f11: ['[23~', '[23;{m}~'],
  f12: ['[24~', '[24;{m}~']
}

const CURSOR_KEYS: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' }

export function encodeKey(event: KeyPress, applicationCursor: boolean): KeyAction {
  const key = event.key ?? ''
  const m = event.modifiers ?? {}
  const modifiers = (m.shift ? 1 : 0) | (m.alt ? 2 : 0) | (m.ctrl ? 4 : 0) | (m.cmd ? 8 : 0)
  const mod = String(modifiers + 1)
  const send = (data: string): KeyAction => ({ type: 'send', data })

  if (m.ctrl && m.shift && !m.alt) {
    if (key === 'c') return { type: 'copy' }
    if (key === 'v') return { type: 'paste' }
  }
  if (key === 'insert' && m.shift && !m.ctrl) return { type: 'paste' }
  if (key === 'insert' && m.ctrl && !m.shift) return { type: 'copy' }

  switch (key) {
    case 'backspace':
      return send((m.alt ? ESC : '') + (m.ctrl ? '\b' : '\x7f'))
    case 'tab':
      return send(m.shift ? `${ESC}[Z` : '\t')
    case 'enter':
      return send(m.alt ? `${ESC}\r` : '\r')
    case 'escape':
      return send(m.alt ? `${ESC}${ESC}` : ESC)
    case 'up':
    case 'down':
    case 'left':
    case 'right':
    case 'home':
    case 'end': {
      if (m.cmd) return { type: 'none' }
      const final = CURSOR_KEYS[key]!
      if (modifiers) return send(`${ESC}[1;${mod}${final}`)
      return send(`${ESC}${applicationCursor ? 'O' : '['}${final}`)
    }
    case 'insert':
      return send(`${ESC}[2~`)
    case 'delete':
      return send(modifiers ? `${ESC}[3;${mod}~` : `${ESC}[3~`)
    case 'pageup':
      if (m.shift) return { type: 'page', direction: -1 }
      return send(m.ctrl ? `${ESC}[5;${mod}~` : `${ESC}[5~`)
    case 'pagedown':
      if (m.shift) return { type: 'page', direction: 1 }
      return send(m.ctrl ? `${ESC}[6;${mod}~` : `${ESC}[6~`)
  }
  const fn = FUNCTION_KEYS[key]
  if (fn) return send(ESC + (modifiers ? fn[1].replace('{m}', mod) : fn[0]))

  const letter = key.length === 1 && key >= 'a' && key <= 'z'
  if (m.ctrl && !m.shift && !m.alt && !m.cmd) {
    if (letter) return send(String.fromCharCode(key.charCodeAt(0) - 96))
    if (key === 'space') return send('\0')
    const punctuation = CTRL_PUNCTUATION[key]
    if (punctuation) return send(punctuation)
    return { type: 'none' }
  }
  if (m.alt && !m.cmd) {
    if (letter) {
      const code = m.ctrl ? key.charCodeAt(0) - 96 : key.charCodeAt(0)
      const text = String.fromCharCode(code)
      return send(ESC + (m.shift ? text.toUpperCase() : text))
    }
    if (key === 'space') return send(ESC + (m.ctrl ? '\0' : ' '))
    if (key.length === 1) {
      const shifted = m.shift ? (SHIFTED_DIGITS[key] ?? event.keyChar ?? key) : key
      return send(ESC + shifted)
    }
    return { type: 'none' }
  }
  if (m.ctrl && m.shift) {
    if (key === '-') return send('\x1f')
    if (key === '2') return send('\0')
    if (key === '6') return send('\x1e')
    return { type: 'none' }
  }
  if (m.ctrl || m.cmd) return { type: 'none' }
  if (key === 'space') return send(' ')
  if (event.keyChar && event.keyChar.length >= 1 && !/^[\x00-\x1f]$/.test(event.keyChar)) {
    return send(event.keyChar)
  }
  if (key.length === 1) return send(m.shift ? key.toUpperCase() : key)
  return { type: 'none' }
}

/** Pasted text as xterm.js sends it: CR line ends, bracketed when the app asked. */
export function encodePaste(text: string, bracketed: boolean): string {
  const normalised = text.replace(/\r?\n/g, '\r')
  return bracketed ? `${ESC}[200~${normalised.replaceAll(ESC, '')}${ESC}[201~` : normalised
}
