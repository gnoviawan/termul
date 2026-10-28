/**
 * Hostile images for the GPUIX chat path: an agent reply's markdown image
 * becomes a native `<img>`, which decodes PNG, GIF and SVG(Z) with no budget
 * of its own. Each attack is small on the wire and huge once decoded. The
 * bytes are generated once per state dir, since the bombs take seconds to
 * deflate.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createDeflate, deflateSync, gzipSync } from 'node:zlib'
import { ATTACK_STATE } from './svg-attack-shared'
import { SVG_ATTACKS } from './svg-attacks'

export interface ImageAttack {
  id: string
  mime: string
  /** What a budgeted decoder does with it. */
  expect: 'refuse' | 'render'
  bytes: () => Promise<Buffer>
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** An RGBA PNG of `width` x `height` whose IDAT is `idat`. */
function png(width: number, height: number, idat: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** The zlib stream of `rows` all-zero scanlines, deflated without holding them. */
async function zeroRows(rows: number, rowBytes: number): Promise<Buffer> {
  const deflate = createDeflate({ level: 9 })
  const out: Buffer[] = []
  deflate.on('data', (data: Buffer) => out.push(data))
  const done = new Promise((resolve) => deflate.on('end', resolve))
  const row = Buffer.alloc(rowBytes)
  for (let y = 0; y < rows; y++)
    if (!deflate.write(row)) await new Promise((resolve) => deflate.once('drain', resolve))
  deflate.end()
  await done
  return Buffer.concat(out)
}

/** A GIF89a with a `width` x `height` canvas and `frames` 1x1 frames. */
function gif(width: number, height: number, frames: number): Buffer {
  const screen = Buffer.alloc(7)
  screen.writeUInt16LE(width, 0)
  screen.writeUInt16LE(height, 2)
  screen.set([0x80, 0, 0], 4)
  const frame = Buffer.from([
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02,
    0x44, 0x01, 0x00
  ])
  return Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    screen,
    Buffer.from([0, 0, 0, 0xff, 0xff, 0xff]),
    ...Array.from({ length: frames }, () => frame),
    Buffer.from([0x3b])
  ])
}

/** `make`'s bytes, generated once into the attack state dir. */
function cached(id: string, make: () => Buffer | Promise<Buffer>): () => Promise<Buffer> {
  return async () => {
    const dir = path.join(ATTACK_STATE, 'images')
    const file = path.join(dir, id)
    if (existsSync(file)) return readFileSync(file)
    mkdirSync(dir, { recursive: true })
    const bytes = await make()
    writeFileSync(file, bytes)
    return bytes
  }
}

const GREEN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#00ff00"/></svg>'

export const IMAGE_ATTACKS: ImageAttack[] = [
  {
    id: 'control-svg',
    mime: 'image/svg+xml',
    expect: 'render',
    bytes: async () => Buffer.from(GREEN_SVG)
  },
  {
    id: 'control-png',
    mime: 'image/png',
    expect: 'render',
    bytes: cached('control-png', () => {
      const row = Buffer.alloc(1 + 64 * 4)
      for (let x = 0; x < 64; x++) row.set([0, 255, 0, 255], 1 + x * 4)
      return png(64, 64, deflateSync(Buffer.concat(Array.from({ length: 64 }, () => row))))
    })
  },
  {
    // 256 MiB of whitespace inflated from about 256 KB; usvg inflates svgz with no bound.
    id: 'svgz-bomb',
    mime: 'image/svg+xml',
    expect: 'refuse',
    bytes: cached('svgz-bomb', () =>
      gzipSync(
        Buffer.concat([
          Buffer.from(GREEN_SVG.replace('</svg>', '<!--')),
          Buffer.alloc(256 << 20, 0x20),
          Buffer.from('--></svg>')
        ]),
        { level: 9 }
      )
    )
  },
  {
    // 484 MB of RGBA from about 470 KB: just under the image crate's default 512 MiB cap.
    id: 'png-decompression-bomb',
    mime: 'image/png',
    expect: 'refuse',
    bytes: cached('png-decompression-bomb', async () =>
      png(11_000, 11_000, await zeroRows(11_000, 1 + 11_000 * 4))
    )
  },
  {
    id: 'png-huge-dimensions',
    mime: 'image/png',
    expect: 'refuse',
    bytes: cached('png-huge-dimensions', () => png(100_000, 100_000, deflateSync(Buffer.alloc(4096))))
  },
  {
    id: 'png-wide-strip',
    mime: 'image/png',
    expect: 'refuse',
    bytes: cached('png-wide-strip', async () => png(40_000, 1, await zeroRows(1, 1 + 40_000 * 4)))
  },
  {
    // A 12000 px canvas (576 MB) per frame: GIF decoding sets no limit of its own.
    id: 'gif-canvas-bomb',
    mime: 'image/gif',
    expect: 'refuse',
    bytes: cached('gif-canvas-bomb', () => gif(12_000, 12_000, 2))
  },
  {
    // 64 frames of a 2048 px canvas: 1 GiB decoded, cut to the 64 MiB animation budget.
    id: 'gif-frame-flood',
    mime: 'image/gif',
    expect: 'render',
    bytes: cached('gif-frame-flood', () => gif(2048, 2048, 64))
  }
]

/** Every attack as the chat path meets it: a markdown image's `data:` URL. */
export interface ChatImage {
  id: string
  dataUrl: () => Promise<string>
}

export const CHAT_IMAGES: ChatImage[] = [
  ...IMAGE_ATTACKS.map((attack) => ({
    id: attack.id,
    dataUrl: async () => `data:${attack.mime};base64,${(await attack.bytes()).toString('base64')}`
  })),
  ...SVG_ATTACKS.map((attack) => ({
    id: `svg:${attack.id}`,
    dataUrl: async () =>
      `data:image/svg+xml;base64,${Buffer.from(attack.markup).toString('base64')}`
  }))
]
