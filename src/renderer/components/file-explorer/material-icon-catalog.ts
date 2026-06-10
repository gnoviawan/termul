import { generateManifest, type Manifest } from 'material-icon-theme'
import type { AppSettings } from '@/types/settings'
import {
  getIconDefinitionFileName,
  type MaterialIconResolveInput,
  mergeLightManifest,
  resolveMaterialIconKey
} from './material-icon-resolver'

const svgModules = import.meta.glob<string>(
  '../../../../node_modules/material-icon-theme/icons/*.svg',
  {
    eager: true,
    query: '?raw',
    import: 'default'
  }
)

const svgByFileName = new Map<string, string>()

for (const [modulePath, svg] of Object.entries(svgModules)) {
  const fileName = modulePath.split(/[/\\]/).pop()
  if (fileName && svg) {
    svgByFileName.set(fileName, svg)
  }
}

let darkManifest: Manifest | null = null
let lightManifest: Manifest | null = null

function getManifestForAppearance(appearanceMode: AppSettings['appearanceMode']): Manifest {
  if (appearanceMode === 'light') {
    if (!lightManifest) {
      lightManifest = mergeLightManifest(generateManifest())
    }
    return lightManifest
  }

  if (!darkManifest) {
    darkManifest = generateManifest()
  }

  return darkManifest
}

export function formatMaterialIconSvg(svg: string, size: number): string {
  return svg.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    const withoutDimensions = attrs.replace(/\s(width|height)="[^"]*"/gi, '')
    return `<svg${withoutDimensions} width="${size}" height="${size}">`
  })
}

export function getMaterialIconSvg(
  input: MaterialIconResolveInput,
  appearanceMode: AppSettings['appearanceMode']
): string | null {
  const manifest = getManifestForAppearance(appearanceMode)
  const iconKey = resolveMaterialIconKey(manifest, input)
  const fileName = getIconDefinitionFileName(manifest, iconKey)
  if (!fileName) return null

  return svgByFileName.get(fileName) ?? null
}

/** @internal Test helper */
export function resetMaterialIconManifestCache(): void {
  darkManifest = null
  lightManifest = null
}

/** @internal Test helper */
export function getLoadedMaterialIconCount(): number {
  return svgByFileName.size
}
