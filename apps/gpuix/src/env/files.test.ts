import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BlobFileReader, openDroppedFile } from './files'

const dir = mkdtempSync(path.join(tmpdir(), 'gpuix-files-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function read(file: File, how: 'readAsText' | 'readAsDataURL'): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reader = new BlobFileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader[how](file)
  })
}

describe('dropped files', () => {
  test('a dropped text file has the browser name, size and type, and reads as text', async () => {
    const p = path.join(dir, 'notes.md')
    writeFileSync(p, '# hello\n')
    const file = openDroppedFile(p)
    expect([file.name, file.size, file.type]).toEqual(['notes.md', 8, 'text/markdown'])
    expect(await read(file, 'readAsText')).toBe('# hello\n')
  })

  test('a dropped png reads as a data URL the image attachment path splits on its comma', async () => {
    const p = path.join(dir, 'dot.png')
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const file = openDroppedFile(p)
    expect(file.type).toBe('image/png')
    expect(await read(file, 'readAsDataURL')).toBe('data:image/png;base64,iVBORw==')
  })

  test('unknown bytes have no type, as in a browser', () => {
    const p = path.join(dir, 'blob.bin7')
    writeFileSync(p, Buffer.from([1, 2, 3]))
    expect(openDroppedFile(p).type).toBe('')
  })
})
