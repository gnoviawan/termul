import '@fontsource-variable/inter/index.css'
import '@/index.css'
import { createRoot } from 'react-dom/client'
import { applyColorTheme } from '@/lib/themes/apply-color-theme'
import { Gallery } from '../Gallery'
import { isScene } from '../layout'

const params = new URLSearchParams(location.search)
const scene = params.get('scene') ?? 'controls'
if (!isScene(scene)) throw new Error(`unknown gallery scene ${scene}`)
applyColorTheme(params.get('theme') ?? 'termul')
const root = document.getElementById('root')
if (!root) throw new Error('no #root')
createRoot(root).render(<Gallery scene={scene} />)
document.body.dataset.galleryReady = '1'
