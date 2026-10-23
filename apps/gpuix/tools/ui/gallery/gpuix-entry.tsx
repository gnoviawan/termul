/**
 * GPUIX side of the ui gallery. Bundled by tools/ui/gallery/build.ts with the
 * ui aliases, so Gallery.tsx renders apps/gpuix/src/ui.
 *   GALLERY_SCENE=controls GALLERY_THEME=termul bun <bundle>
 * The root gains testId "gallery-ready" once fonts are registered.
 */
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { registerTermulFonts } from '../../../src/style/fonts'
import { setTwTheme, tw } from '../../../src/style/tw'
import { SANS_FAMILY } from '../../../src/style/utilities'
import { Gallery } from './Gallery'
import { GALLERY_HEIGHT, GALLERY_WIDTH, isScene, type SceneId } from './layout'

const requested = process.env.GALLERY_SCENE
if (!isScene(requested))
  throw new Error(`GALLERY_SCENE must name a gallery scene, got ${requested}`)
const scene: SceneId = requested
setTwTheme(process.env.GALLERY_THEME ?? 'termul')

function Root() {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    registerTermulFonts(renderer)
    setReady(true)
  }, [renderer])
  return (
    <div
      testId={ready ? 'gallery-ready' : undefined}
      style={{
        ...tw('bg-background text-foreground'),
        position: 'relative',
        width: GALLERY_WIDTH,
        height: GALLERY_HEIGHT,
        fontFamily: SANS_FAMILY,
        fontSize: 16,
        lineHeight: 24
      }}
    >
      {ready && <Gallery scene={scene} interactive={process.env.GALLERY_INTERACTIVE === '1'} />}
    </div>
  )
}

render(<Root />, {
  title: 'ui gallery',
  width: GALLERY_WIDTH,
  height: GALLERY_HEIGHT,
  focus: false,
  keyboardFocusDim: false
})
