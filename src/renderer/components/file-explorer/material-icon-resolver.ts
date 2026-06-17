import type { Manifest } from 'material-icon-theme'

export interface MaterialIconResolveInput {
  name: string
  extension: string | null
  isDirectory: boolean
  isExpanded: boolean
  /** 0 = direct child of the workspace root */
  depth: number
}

function normalizeName(value: string): string {
  return value.toLowerCase()
}

function normalizeExtension(extension: string | null): string | null {
  if (!extension) return null
  const trimmed = extension.startsWith('.') ? extension.slice(1) : extension
  return trimmed ? normalizeName(trimmed) : null
}

function resolveFolderIconKey(
  manifest: Manifest,
  name: string,
  isExpanded: boolean,
  isRoot: boolean
): string {
  const folderName = normalizeName(name)

  if (isRoot) {
    const rootAssociation = isExpanded
      ? (manifest.rootFolderNamesExpanded?.[folderName] ?? manifest.rootFolderNames?.[folderName])
      : manifest.rootFolderNames?.[folderName]

    if (rootAssociation) {
      return rootAssociation
    }
  }

  const folderAssociation = isExpanded
    ? (manifest.folderNamesExpanded?.[folderName] ?? manifest.folderNames?.[folderName])
    : manifest.folderNames?.[folderName]

  if (folderAssociation) {
    return folderAssociation
  }

  if (isRoot) {
    const rootDefault = isExpanded ? manifest.rootFolderExpanded : manifest.rootFolder
    if (rootDefault) {
      return rootDefault
    }
  }

  return isExpanded
    ? (manifest.folderExpanded ?? manifest.folder ?? 'folder')
    : (manifest.folder ?? 'folder')
}

function resolveFileIconKey(manifest: Manifest, name: string, extension: string | null): string {
  const fileName = normalizeName(name)
  const normalizedExtension = normalizeExtension(extension)

  const byName = manifest.fileNames?.[fileName]
  if (byName) {
    return byName
  }

  if (normalizedExtension) {
    const byExtension = manifest.fileExtensions?.[normalizedExtension]
    if (byExtension) {
      return byExtension
    }
  }

  return manifest.file ?? 'file'
}

/** Resolve a Material Icon Theme definition key (e.g. `typescript`, `folder-src`). */
export function resolveMaterialIconKey(
  manifest: Manifest,
  input: MaterialIconResolveInput
): string {
  if (input.isDirectory) {
    return resolveFolderIconKey(manifest, input.name, input.isExpanded, input.depth === 0)
  }

  return resolveFileIconKey(manifest, input.name, input.extension)
}

export function getIconDefinitionFileName(manifest: Manifest, iconKey: string): string | null {
  const iconPath = manifest.iconDefinitions?.[iconKey]?.iconPath
  if (!iconPath) return null

  const segments = iconPath.split(/[/\\]/)
  return segments[segments.length - 1] ?? null
}

export function mergeLightManifest(base: Manifest): Manifest {
  const light = base.light
  if (!light) return base

  return {
    ...base,
    file: light.file ?? base.file,
    folder: light.folder ?? base.folder,
    folderExpanded: light.folderExpanded ?? base.folderExpanded,
    rootFolder: light.rootFolder ?? base.rootFolder,
    rootFolderExpanded: light.rootFolderExpanded ?? base.rootFolderExpanded,
    fileExtensions: { ...base.fileExtensions, ...light.fileExtensions },
    fileNames: { ...base.fileNames, ...light.fileNames },
    folderNames: { ...base.folderNames, ...light.folderNames },
    folderNamesExpanded: { ...base.folderNamesExpanded, ...light.folderNamesExpanded },
    rootFolderNames: { ...base.rootFolderNames, ...light.rootFolderNames },
    rootFolderNamesExpanded: {
      ...base.rootFolderNamesExpanded,
      ...light.rootFolderNamesExpanded
    },
    languageIds: { ...base.languageIds, ...light.languageIds },
    iconDefinitions: {
      ...base.iconDefinitions,
      ...light.iconDefinitions
    }
  }
}
