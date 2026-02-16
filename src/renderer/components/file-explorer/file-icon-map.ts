import type { LucideIcon } from 'lucide-react'
import {
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen
} from 'lucide-react'

const extensionIconMap: Record<string, LucideIcon> = {
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  json: FileJson,
  md: FileText,
  css: FileCode,
  scss: FileCode,
  html: FileCode,
  yaml: FileCode,
  yml: FileCode,
  xml: FileCode,
  svg: FileCode,
  sh: FileCode,
  bash: FileCode,
  py: FileCode,
  rs: FileCode,
  go: FileCode,
  toml: FileCode
}

export function getFileIcon(
  extension: string | null,
  isDirectory: boolean,
  isExpanded: boolean
): LucideIcon {
  if (isDirectory) {
    return isExpanded ? FolderOpen : Folder
  }

  if (extension && extensionIconMap[extension]) {
    return extensionIconMap[extension]
  }

  return File
}
