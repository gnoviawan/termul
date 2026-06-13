export interface HighlightToken {
  text: string
  type: 'keyword' | 'string' | 'comment' | 'number' | 'punctuation' | 'plain'
}

const KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'return',
  'function',
  'class',
  'struct',
  'enum',
  'interface',
  'type',
  'extends',
  'implements',
  'import',
  'export',
  'from',
  'default',
  'const',
  'let',
  'var',
  'async',
  'await',
  'yield',
  'throw',
  'try',
  'catch',
  'finally',
  'new',
  'delete',
  'typeof',
  'instanceof',
  'in',
  'of',
  'pub',
  'fn',
  'let',
  'mut',
  'match',
  'use',
  'mod',
  'impl',
  'trait',
  'def',
  'self',
  'super',
  'True',
  'False',
  'None',
  'int',
  'float',
  'double',
  'bool',
  'char',
  'void',
  'string',
  'public',
  'private',
  'protected',
  'static',
  'final',
  'abstract',
  'nil',
  'true',
  'false',
  'null',
  'undefined',
  'this'
])

function isKeyword(word: string): boolean {
  return KEYWORDS.has(word)
}

const NUMBER_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/
const PUNCTUATION_RE = /^[{}()[\];:,.<>+\-*/%=!&|^~@#?]$/

function tokenizeLine(line: string): HighlightToken[] {
  const tokens: HighlightToken[] = []
  let i = 0

  while (i < line.length) {
    // Whitespace — skip
    if (line[i] === ' ' || line[i] === '\t') {
      let end = i
      while (end < line.length && (line[end] === ' ' || line[end] === '\t')) {
        end++
      }
      tokens.push({ text: line.slice(i, end), type: 'plain' })
      i = end
      continue
    }

    // Single-line comment: // or #
    if ((line[i] === '/' && line[i + 1] === '/') || line[i] === '#') {
      tokens.push({ text: line.slice(i), type: 'comment' })
      break
    }

    // Block comment /*
    if (line[i] === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2)
      if (end !== -1) {
        tokens.push({ text: line.slice(i, end + 2), type: 'comment' })
        i = end + 2
      } else {
        tokens.push({ text: line.slice(i), type: 'comment' })
        break
      }
      continue
    }

    // String (double-quoted)
    if (line[i] === '"') {
      let end = i + 1
      while (end < line.length) {
        if (line[end] === '\\') {
          end += 2
          continue
        }
        if (line[end] === '"') {
          end++
          break
        }
        end++
      }
      tokens.push({ text: line.slice(i, end), type: 'string' })
      i = end
      continue
    }

    // String (single-quoted)
    if (line[i] === "'") {
      let end = i + 1
      while (end < line.length) {
        if (line[end] === '\\') {
          end += 2
          continue
        }
        if (line[end] === "'") {
          end++
          break
        }
        end++
      }
      tokens.push({ text: line.slice(i, end), type: 'string' })
      i = end
      continue
    }

    // Backtick string (template literals)
    if (line[i] === '`') {
      let end = i + 1
      while (end < line.length) {
        if (line[end] === '\\') {
          end += 2
          continue
        }
        if (line[end] === '`') {
          end++
          break
        }
        end++
      }
      tokens.push({ text: line.slice(i, end), type: 'string' })
      i = end
      continue
    }

    // Word (alphanumeric + underscore)
    if (/[a-zA-Z_]/.test(line[i])) {
      let end = i
      while (end < line.length && /[a-zA-Z0-9_]/.test(line[end])) {
        end++
      }
      const word = line.slice(i, end)
      tokens.push({ text: word, type: isKeyword(word) ? 'keyword' : 'plain' })
      i = end
      continue
    }

    // Number
    if (
      /[0-9]/.test(line[i]) ||
      (line[i] === '-' && i + 1 < line.length && /[0-9]/.test(line[i + 1]))
    ) {
      let end = i + 1
      while (end < line.length && /[0-9.eE+-]/.test(line[end])) {
        end++
      }
      const num = line.slice(i, end)
      tokens.push({ text: num, type: NUMBER_RE.test(num) ? 'number' : 'plain' })
      i = end
      continue
    }

    // Punctuation
    tokens.push({ text: line[i], type: 'punctuation' })
    i++
  }

  return tokens
}

export function highlightLine(line: string): HighlightToken[] {
  return tokenizeLine(line)
}

export function lineToHtml(tokens: HighlightToken[]): string {
  return tokens
    .map((t) => {
      if (t.type === 'plain') return t.text
      return `<span class="hl-${t.type}">${t.text}</span>`
    })
    .join('')
}
