/**
 * Every visible cell of an xterm buffer as one string per row: chars, width,
 * colour mode and value for fg and bg, and the attribute flags. The function
 * is self-contained so the parity driver can run its source inside the
 * Chromium page against xterm.js, and in GPUIX against `@xterm/headless`:
 * one serializer, two buffers, compared as exact strings. Both builds share
 * the `IBuffer` API, so the headless type stands for the browser one too.
 */

import type { Terminal } from '@xterm/headless'

export function cellRows(term: Pick<Terminal, 'rows' | 'cols' | 'buffer'>): string[] {
  const buffer = term.buffer.active
  const cell = buffer.getNullCell()
  const out: string[] = []
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y)
    const cells: string[] = []
    for (let x = 0; x < term.cols; x++) {
      const c = line?.getCell(x, cell)
      if (!c) {
        cells.push('-')
        continue
      }
      const flags =
        (c.isBold() ? 'b' : '') +
        (c.isItalic() ? 'i' : '') +
        (c.isDim() ? 'd' : '') +
        (c.isUnderline() ? 'u' : '') +
        (c.isInverse() ? 'v' : '') +
        (c.isInvisible() ? 'h' : '') +
        (c.isStrikethrough() ? 's' : '')
      cells.push(
        `${JSON.stringify(c.getChars())}/${c.getWidth()}/${c.getFgColorMode()}:${c.getFgColor()}/${c.getBgColorMode()}:${c.getBgColor()}/${flags}`
      )
    }
    out.push(cells.join(' '))
  }
  return out
}
