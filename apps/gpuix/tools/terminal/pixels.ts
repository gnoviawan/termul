export interface RgbImage {
  width: number
  height: number
  data: Uint8Array
}

export interface DiffResult {
  width: number
  height: number
  total: number
  differing: number
  percent: number
  sizeMismatch?: { a: [number, number]; b: [number, number] }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function pngSize(header: Uint8Array, path: string): { width: number; height: number } {
  const isPng = PNG_SIGNATURE.every((byte, i) => header[i] === byte)
  const ihdr = String.fromCharCode(...header.subarray(12, 16))
  if (!isPng || ihdr !== 'IHDR') throw new Error(`not a PNG with a leading IHDR chunk: ${path}`)
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

async function ffmpeg(args: string[], stdin?: Uint8Array): Promise<Uint8Array> {
  const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', ...args], {
    stdin: stdin ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (stdin && proc.stdin) {
    proc.stdin.write(stdin)
    await proc.stdin.end()
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  if (code !== 0) throw new Error(`ffmpeg ${args.join(' ')} exited ${code}: ${err.trim()}`)
  return new Uint8Array(out)
}

export async function readPng(path: string): Promise<RgbImage> {
  const header = new Uint8Array(await Bun.file(path).slice(0, 24).arrayBuffer())
  const { width, height } = pngSize(header, path)
  const data = await ffmpeg(['-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  if (data.length !== width * height * 3) {
    throw new Error(`decoded ${data.length} bytes from ${path}, expected ${width}x${height}x3`)
  }
  return { width, height, data }
}

export async function writePng(path: string, img: RgbImage): Promise<void> {
  if (img.data.length !== img.width * img.height * 3) {
    throw new Error(
      `rgb24 buffer is ${img.data.length} bytes, expected ${img.width}x${img.height}x3`
    )
  }
  await ffmpeg(
    [
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-s',
      `${img.width}x${img.height}`,
      '-i',
      '-',
      '-frames:v',
      '1',
      '-update',
      '1',
      path
    ],
    img.data
  )
}

export function crop(img: RgbImage, x: number, y: number, w: number, h: number): RgbImage {
  if (x < 0 || y < 0 || w < 0 || h < 0 || x + w > img.width || y + h > img.height) {
    throw new Error(`crop ${x},${y} ${w}x${h} is outside ${img.width}x${img.height}`)
  }
  const data = new Uint8Array(w * h * 3)
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * img.width + x) * 3
    data.set(img.data.subarray(from, from + w * 3), row * w * 3)
  }
  return { width: w, height: h, data }
}

export async function diffImages(
  a: RgbImage,
  b: RgbImage,
  opts: { threshold?: number; outDiff?: string } = {}
): Promise<DiffResult> {
  const threshold = opts.threshold ?? 24
  const width = Math.min(a.width, b.width)
  const height = Math.min(a.height, b.height)
  const diff = opts.outDiff ? new Uint8Array(width * height * 3) : undefined
  let differing = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ai = (y * a.width + x) * 3
      const bi = (y * b.width + x) * 3
      const delta = Math.max(
        Math.abs(a.data[ai] - b.data[bi]),
        Math.abs(a.data[ai + 1] - b.data[bi + 1]),
        Math.abs(a.data[ai + 2] - b.data[bi + 2])
      )
      const di = (y * width + x) * 3
      if (delta > threshold) {
        differing++
        diff?.set([255, 0, 0], di)
      } else if (diff) {
        const grey = Math.round(
          (a.data[ai] * 0.299 + a.data[ai + 1] * 0.587 + a.data[ai + 2] * 0.114) * 0.3
        )
        diff.set([grey, grey, grey], di)
      }
    }
  }
  if (diff && opts.outDiff) await writePng(opts.outDiff, { width, height, data: diff })
  const total = width * height
  const result: DiffResult = {
    width,
    height,
    total,
    differing,
    percent: total === 0 ? 0 : (differing / total) * 100
  }
  if (a.width !== b.width || a.height !== b.height) {
    result.sizeMismatch = { a: [a.width, a.height], b: [b.width, b.height] }
  }
  return result
}

async function main(argv: string[]): Promise<void> {
  const [aPath, bPath, diffPath] = argv
  if (!aPath || !bPath) {
    console.error('usage: bun tools/terminal/pixels.ts a.png b.png [diff.png]')
    process.exit(2)
  }
  const [a, b] = await Promise.all([readPng(aPath), readPng(bPath)])
  console.log(JSON.stringify(await diffImages(a, b, { outDiff: diffPath })))
}

if (import.meta.main) await main(process.argv.slice(2))
