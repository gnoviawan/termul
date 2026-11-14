import { ASCII_SHADER, FIELD_SHADER, GLYPHS, UNIFORM_FLOATS } from './shaders'

const GLYPH_CELL = { width: 48, height: 80 }
const GLYPH_MIP_LEVELS = 5
const GLYPH_FONT = '500 62px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
/** The field is soft, and the ASCII pass samples it once per cell. */
const SCENE_SCALE = 0.25
const MAX_PIXELS = 2_400_000
/** About 30 fps: the glow moves slowly, so more frames only cost battery. */
const FRAME_MS = 1000 / 30

/** WebGPU is missing or has no adapter here: an expected outcome, not a fault. */
export class WebGpuUnavailableError extends Error {}

export interface AsciiGlowHandle {
  /** Read the ink colour again (after a theme change). */
  refreshInk(): void
  destroy(): void
}

export interface AsciiGlowOptions {
  /** Glyph alpha, 0–1. */
  opacity: number
  signal: AbortSignal
  onError: (error: Error) => void
}

/** The canvas's CSS `color` as linear-ish sRGB 0–1 (any CSS colour syntax). */
function readInk(canvas: HTMLCanvasElement): [number, number, number] {
  const probe = document.createElement('canvas')
  probe.width = 1
  probe.height = 1
  const context = probe.getContext('2d', { willReadFrequently: true })
  if (!context) return [1, 1, 1]
  context.fillStyle = getComputedStyle(canvas).color
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return [r / 255, g / 255, b / 255]
}

function uploadGlyphAtlas(device: GPUDevice): GPUTexture {
  const width = GLYPH_CELL.width * GLYPHS.length
  const height = GLYPH_CELL.height
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('A 2D canvas context is needed to draw the glyph atlas.')
  context.fillStyle = '#000'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#fff'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = GLYPH_FONT
  for (let i = 0; i < GLYPHS.length; i++) {
    context.fillText(
      GLYPHS[i],
      i * GLYPH_CELL.width + GLYPH_CELL.width / 2,
      height / 2 + height * 0.04
    )
  }
  const levels = [context.getImageData(0, 0, width, height).data]
  for (let level = 1, w = width, h = height; level < GLYPH_MIP_LEVELS; level++) {
    const source = levels[level - 1]
    const next = new Uint8ClampedArray((w / 2) * (h / 2) * 4)
    for (let y = 0; y < h / 2; y++) {
      for (let x = 0; x < w / 2; x++) {
        const a = (y * 2 * w + x * 2) * 4
        const c = a + w * 4
        for (let ch = 0; ch < 4; ch++) {
          next[(y * (w / 2) + x) * 4 + ch] =
            (source[a + ch] + source[a + 4 + ch] + source[c + ch] + source[c + 4 + ch] + 2) >> 2
        }
      }
    }
    levels.push(next)
    w /= 2
    h /= 2
  }
  const texture = device.createTexture({
    size: [width, height],
    mipLevelCount: levels.length,
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  })
  levels.forEach((pixels, level) => {
    const w = width >> level
    const h = height >> level
    device.queue.writeTexture({ texture, mipLevel: level }, pixels, { bytesPerRow: w * 4 }, [w, h])
  })
  return texture
}

/**
 * Start the glow on `canvas`. Rejects when WebGPU is missing (Linux
 * WebKitGTK, older WebKit): the caller then shows nothing. Pauses while the
 * canvas or the window is hidden; draws one still frame for reduced motion.
 */
export async function createAsciiGlow(
  canvas: HTMLCanvasElement,
  options: AsciiGlowOptions
): Promise<AsciiGlowHandle> {
  const { signal } = options
  if (!navigator.gpu) throw new WebGpuUnavailableError('WebGPU is not available.')
  const adapter = await navigator.gpu.requestAdapter()
  signal.throwIfAborted()
  if (!adapter) throw new WebGpuUnavailableError('No WebGPU adapter is available.')
  const device = await adapter.requestDevice()
  if (signal.aborted) {
    device.destroy()
    signal.throwIfAborted()
  }

  const maybeContext = canvas.getContext('webgpu')
  if (!maybeContext) {
    device.destroy()
    throw new Error('A WebGPU canvas context could not be made.')
  }
  const context: GPUCanvasContext = maybeContext
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'premultiplied' })

  let disposed = false
  const fail = (error: Error): void => {
    if (disposed) return
    destroy()
    options.onError(error)
  }
  device.addEventListener('uncapturederror', (event) => {
    event.preventDefault()
    fail(new Error(event.error.message))
  })
  void device.lost.then((info) => {
    if (!disposed) fail(new Error(`WebGPU device lost: ${info.message || info.reason}.`))
  })

  const uniforms = device.createBuffer({
    size: UNIFORM_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  const uniformData = new Float32Array(UNIFORM_FLOATS)
  const fieldModule = device.createShaderModule({ code: FIELD_SHADER })
  const asciiModule = device.createShaderModule({ code: ASCII_SHADER })
  const [fieldPipeline, asciiPipeline] = await Promise.all([
    device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: fieldModule, entryPoint: 'vertexMain' },
      fragment: {
        module: fieldModule,
        entryPoint: 'fragmentMain',
        targets: [{ format: 'rgba8unorm' }]
      },
      primitive: { topology: 'triangle-list' }
    }),
    device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: asciiModule, entryPoint: 'vertexMain' },
      fragment: { module: asciiModule, entryPoint: 'fragmentMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    })
  ])
  if (signal.aborted) {
    context.unconfigure()
    device.destroy()
    signal.throwIfAborted()
  }

  const fieldBindGroup = device.createBindGroup({
    layout: fieldPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniforms } }]
  })
  const sceneSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  const glyphView = uploadGlyphAtlas(device).createView()
  const glyphSampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear'
  })

  let scene: GPUTexture | null = null
  let asciiBindGroup: GPUBindGroup | null = null
  function sceneFor(width: number, height: number): { view: GPUTextureView; group: GPUBindGroup } {
    const w = Math.max(1, Math.round(width * SCENE_SCALE))
    const h = Math.max(1, Math.round(height * SCENE_SCALE))
    if (!scene || !asciiBindGroup || scene.width !== w || scene.height !== h) {
      scene?.destroy()
      scene = device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      })
      asciiBindGroup = device.createBindGroup({
        layout: asciiPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: sceneSampler },
          { binding: 2, resource: scene.createView() },
          { binding: 3, resource: glyphSampler },
          { binding: 4, resource: glyphView }
        ]
      })
    }
    return { view: scene.createView(), group: asciiBindGroup }
  }

  let ink = readInk(canvas)
  let cssWidth = canvas.clientWidth
  let cssHeight = canvas.clientHeight
  let onScreen = true
  let elapsed = 0
  let frame = 0
  let previous: number | null = null
  const stillness = window.matchMedia('(prefers-reduced-motion: reduce)')

  function draw(): void {
    const dpr = window.devicePixelRatio || 1
    const scale = Math.min(
      dpr,
      2,
      Math.sqrt(MAX_PIXELS / (cssWidth * cssHeight)),
      device.limits.maxTextureDimension2D / cssWidth,
      device.limits.maxTextureDimension2D / cssHeight
    )
    const width = Math.max(1, Math.floor(cssWidth * scale))
    const height = Math.max(1, Math.floor(cssHeight * scale))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const target = sceneFor(width, height)
    uniformData.set([
      width,
      height,
      elapsed,
      width / cssWidth,
      ink[0],
      ink[1],
      ink[2],
      options.opacity,
      scene?.width ?? 1,
      scene?.height ?? 1,
      0,
      0
    ])
    device.queue.writeBuffer(uniforms, 0, uniformData)
    const encoder = device.createCommandEncoder()
    const fieldPass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }]
    })
    fieldPass.setPipeline(fieldPipeline)
    fieldPass.setBindGroup(0, fieldBindGroup)
    fieldPass.draw(3)
    fieldPass.end()
    const asciiPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    })
    asciiPass.setPipeline(asciiPipeline)
    asciiPass.setBindGroup(0, target.group)
    asciiPass.draw(3)
    asciiPass.end()
    device.queue.submit([encoder.finish()])
  }

  const canDraw = (): boolean =>
    !disposed && !document.hidden && onScreen && cssWidth > 0 && cssHeight > 0

  function tick(now: number): void {
    frame = 0
    if (!canDraw()) {
      previous = null
      return
    }
    if (previous !== null && now - previous < FRAME_MS) {
      frame = requestAnimationFrame(tick)
      return
    }
    elapsed += previous === null ? 0 : Math.min((now - previous) / 1000, 0.1)
    previous = now
    draw()
    if (!stillness.matches) frame = requestAnimationFrame(tick)
    else previous = null
  }

  function refresh(): void {
    cancelAnimationFrame(frame)
    frame = 0
    previous = null
    if (canDraw()) frame = requestAnimationFrame(tick)
  }

  const resize = new ResizeObserver(([entry]) => {
    if (!entry) return
    cssWidth = entry.contentRect.width
    cssHeight = entry.contentRect.height
    refresh()
  })
  const visibility = new IntersectionObserver(([entry]) => {
    if (!entry || onScreen === entry.isIntersecting) return
    onScreen = entry.isIntersecting
    refresh()
  })
  resize.observe(canvas)
  visibility.observe(canvas)
  document.addEventListener('visibilitychange', refresh)
  stillness.addEventListener('change', refresh)

  function destroy(): void {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(frame)
    resize.disconnect()
    visibility.disconnect()
    document.removeEventListener('visibilitychange', refresh)
    stillness.removeEventListener('change', refresh)
    signal.removeEventListener('abort', destroy)
    context.unconfigure()
    device.destroy()
  }
  signal.addEventListener('abort', destroy, { once: true })
  refresh()

  return {
    refreshInk() {
      if (disposed) return
      ink = readInk(canvas)
      refresh()
    },
    destroy
  }
}
