import {
  type ForwardRefExoticComponent,
  forwardRef,
  type RefAttributes,
  type SVGProps,
  useId
} from 'react'
import backSvg from './assets/back.svg?raw'
import checkSvg from './assets/check.svg?raw'
import closeSvg from './assets/close.svg?raw'
import deleteSvg from './assets/delete.svg?raw'
import downloadSvg from './assets/download.svg?raw'
import eyeSvg from './assets/eye.svg?raw'
import filterSvg from './assets/filter.svg?raw'
import gridSvg from './assets/grid.svg?raw'
import homeSvg from './assets/home.svg?raw'
import infoSvg from './assets/info.svg?raw'
import internetSvg from './assets/internet.svg?raw'
import messageSvg from './assets/message.svg?raw'
import minusSvg from './assets/minus.svg?raw'
import moreSvg from './assets/more.svg?raw'
import plusSvg from './assets/plus.svg?raw'
import saveSvg from './assets/save.svg?raw'
import searchSvg from './assets/search.svg?raw'
import settingsSvg from './assets/settings.svg?raw'
import textSvg from './assets/text.svg?raw'
import uploadSvg from './assets/upload.svg?raw'
import videoSvg from './assets/video.svg?raw'
import zoomInSvg from './assets/zoom-in.svg?raw'
import zoomOutSvg from './assets/zoom-out.svg?raw'

export interface TermulIconProps extends SVGProps<SVGSVGElement> {
  size?: number | string
}

export type TermulIcon = ForwardRefExoticComponent<TermulIconProps & RefAttributes<SVGSVGElement>>

function normalizePackSvg(
  markup: string,
  name: string,
  reactId: string,
  strokeWidth: number
): string {
  const prefix = `termul-${name.toLowerCase()}-${reactId}`
  return markup
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}-$1)`)
    .replace(/id="([^"]+)"/g, `id="${prefix}-$1"`)
    .replace(/((?:fill|stroke))="#252525"/gi, '$1="currentColor"')
    .replace(/stroke-width="[^"]+"/g, `stroke-width="${strokeWidth}"`)
    .replace(/^[\s\S]*?<svg\b[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '')
}

function renderIcon(
  name: string,
  markup: string,
  source: 'pack' | 'custom' = 'custom'
): TermulIcon {
  const Icon = forwardRef<SVGSVGElement, TermulIconProps>(function TermulIcon(
    { size = 24, strokeWidth, children: _children, ...props },
    ref
  ) {
    const reactId = useId().replaceAll(':', '')
    const requestedStrokeWidth = Number(strokeWidth ?? 1.5)
    const safeStrokeWidth = Number.isFinite(requestedStrokeWidth) ? requestedStrokeWidth : 1.5
    const innerMarkup =
      source === 'custom' ? markup : normalizePackSvg(markup, name, reactId, safeStrokeWidth)

    return (
      <svg
        ref={ref}
        aria-hidden={props['aria-label'] ? undefined : true}
        focusable="false"
        fill="none"
        stroke="currentColor"
        strokeWidth={safeStrokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        data-termul-icon={name}
        {...props}
        // This is trusted SVG artwork bundled with the application, never user input.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Local icon assets and glyph paths are static.
        dangerouslySetInnerHTML={{ __html: innerMarkup }}
      />
    )
  })

  Icon.displayName = name
  return Icon
}

const packIcon = (name: string, svg: string) => renderIcon(name, svg, 'pack')
const glyph = (name: string, svg: string) => renderIcon(name, svg)

// Functional icons selected from the purchased Ideate Pro line set.
export const Search = packIcon('Search', searchSvg)
export const Home = packIcon('Home', homeSvg)
export const Settings = packIcon('Settings', settingsSvg)
export const Download = packIcon('Download', downloadSvg)
export const Upload = packIcon('Upload', uploadSvg)
export const X = packIcon('X', closeSvg)
export const Plus = packIcon('Plus', plusSvg)
export const Minus = packIcon('Minus', minusSvg)
export const Check = packIcon('Check', checkSvg)
export const Eye = packIcon('Eye', eyeSvg)
export const Grid3X3 = packIcon('Grid3X3', gridSvg)
export const MessageSquare = packIcon('MessageSquare', messageSvg)
export const Info = packIcon('Info', infoSvg)
export const Sliders = packIcon('Sliders', filterSvg)
export const SlidersHorizontal = Sliders
export const Trash2 = packIcon('Trash2', deleteSvg)
export const Save = packIcon('Save', saveSvg)
export const VideoIcon = packIcon('VideoIcon', videoSvg)
export const FileText = packIcon('FileText', textSvg)
export const FileTextIcon = FileText
export const Globe = packIcon('Globe', internetSvg)
export const GlobeIcon = Globe
export const MoreHorizontal = packIcon('MoreHorizontal', moreSvg)
export const ZoomIn = packIcon('ZoomIn', zoomInSvg)
export const ZoomOut = packIcon('ZoomOut', zoomOutSvg)
export const ArrowLeft = packIcon('ArrowLeft', backSvg)

export const AlertCircle = glyph(
  'AlertCircle',
  '<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16.5h.01"/>'
)
export const AlertTriangle = glyph(
  'AlertTriangle',
  '<path d="M10.3 4.3 2.9 17.1A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.9L13.7 4.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 16.5h.01"/>'
)
export const AlignLeft = glyph(
  'AlignLeft',
  '<path d="M4 6h16"/><path d="M4 10h10"/><path d="M4 14h16"/><path d="M4 18h10"/>'
)
export const Archive = glyph(
  'Archive',
  '<path d="M3 5h18v4H3z"/><path d="M5 9v11h14V9"/><path d="M10 13h4"/>'
)
export const ArchiveRestore = glyph(
  'ArchiveRestore',
  '<path d="M3 5h18v4H3z"/><path d="M5 9v11h14V9"/><path d="M12 12v5"/><path d="m10 14 2-2 2 2"/>'
)
export const ArrowDown = glyph('ArrowDown', '<path d="M12 4v15"/><path d="m6 13 6 6 6-6"/>')
export const ArrowRight = glyph('ArrowRight', '<path d="M4 12h15"/><path d="m13 6 6 6-6 6"/>')
export const ArrowRightLeft = glyph(
  'ArrowRightLeft',
  '<path d="M17 3 21 7l-4 4"/><path d="M3 7h18"/><path d="m7 21-4-4 4-4"/><path d="M21 17H3"/>'
)
export const ArrowUp = glyph('ArrowUp', '<path d="M12 20V5"/><path d="m6 11 6-6 6 6"/>')
export const ArrowUpCircle = glyph(
  'ArrowUpCircle',
  '<circle cx="12" cy="12" r="9"/><path d="M12 16V8"/><path d="m8.5 11.5 3.5-3.5 3.5 3.5"/>'
)
export const Bell = glyph(
  'Bell',
  '<path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>'
)
export const Bot = glyph(
  'Bot',
  '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4"/><path d="M9 13h.01M15 13h.01"/><path d="M9 17h6"/><path d="M2 12h2M20 12h2"/>'
)
export const Brain = glyph(
  'Brain',
  '<path d="M12 5a3 3 0 0 0-5.8-1A3.5 3.5 0 0 0 4 10a3.5 3.5 0 0 0 1 6.5A3 3 0 0 0 8 21a3 3 0 0 0 4-2.8"/><path d="M12 5a3 3 0 0 1 5.8-1A3.5 3.5 0 0 1 20 10a3.5 3.5 0 0 1-1 6.5A3 3 0 0 1 16 21a3 3 0 0 1-4-2.8"/><path d="M12 5v15"/><path d="M8 10h.01M16 10h.01M8 16h.01M16 16h.01"/>'
)
export const Bug = glyph(
  'Bug',
  '<path d="M8 8 6 5M16 8l2-3"/><rect x="7" y="8" width="10" height="13" rx="5"/><path d="M12 8v13M3 13h4M17 13h4M4 18h3M17 18h3M10 4h4"/>'
)
export const Calendar = glyph(
  'Calendar',
  '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>'
)
export const Camera = glyph(
  'Camera',
  '<path d="M4 7h3l2-3h6l2 3h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="3"/>'
)
export const CheckCircle2 = glyph(
  'CheckCircle2',
  '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>'
)
export const ChevronDown = glyph('ChevronDown', '<path d="m6 9 6 6 6-6"/>')
export const ChevronDownIcon = ChevronDown
export const ChevronLeft = glyph('ChevronLeft', '<path d="m15 6-6 6 6 6"/>')
export const ChevronRight = glyph('ChevronRight', '<path d="m9 6 6 6-6 6"/>')
export const ChevronUp = glyph('ChevronUp', '<path d="m6 15 6-6 6 6"/>')
export const ChevronsDownUp = glyph(
  'ChevronsDownUp',
  '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>'
)
export const Circle = glyph('Circle', '<circle cx="12" cy="12" r="9"/>')
export const CircleDot = glyph(
  'CircleDot',
  '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>'
)
export const Clipboard = glyph(
  'Clipboard',
  '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5.5V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5"/>'
)
export const ClipboardPaste = glyph(
  'ClipboardPaste',
  '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5.5V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5"/><path d="M9 13h6M9 17h4"/>'
)
export const Clock = glyph('Clock', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>')
export const Clock3 = Clock
export const Code2 = glyph('Code2', '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>')
export const Columns2 = glyph(
  'Columns2',
  '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>'
)
export const Copy = glyph(
  'Copy',
  '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>'
)
export const CopyX = glyph(
  'CopyX',
  '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/><path d="m12 12 5 5M17 12l-5 5"/>'
)
export const Cpu = glyph(
  'Cpu',
  '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4"/>'
)
export const Dot = glyph('Dot', '<circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>')
export const ExternalLink = glyph(
  'ExternalLink',
  '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>'
)
export const Edit2 = glyph('Edit2', '<path d="m15 5 4 4M4 20l4-.8L19 8a2.8 2.8 0 0 0-4-4L4 15z"/>')
export const EyeOff = glyph(
  'EyeOff',
  '<path d="m3 3 18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c5 0 8.5 3.5 10 7a11 11 0 0 1-3.1 4.2M6.2 6.2A12 12 0 0 0 2 12c1.5 3.5 5 7 10 7 1 0 1.9-.2 2.8-.5"/>'
)
export const File = glyph(
  'File',
  '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7"/>'
)
export const FileCode = glyph(
  'FileCode',
  '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7"/><path d="m9 14-2 2 2 2M15 14l2 2-2 2"/>'
)
export const FileDiff = glyph(
  'FileDiff',
  '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7"/><path d="M8 14h6M8 17h2M15 17h2"/>'
)
export const FileEdit = glyph(
  'FileEdit',
  '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7"/><path d="M13 3v7h7"/><path d="m15 17 4-4 2 2-4 4-3 1z"/>'
)
export const FilePen = FileEdit
export const FilePlus = glyph(
  'FilePlus',
  '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7"/><path d="M13 3v7h7"/><path d="M16 17h6M19 14v6"/>'
)
export const FileQuestion = glyph(
  'FileQuestion',
  '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7"/><path d="M10 14a2 2 0 1 1 3.5 1.3c-.8.8-1.5 1-1.5 2"/><path d="M12 19h.01"/>'
)
export const Files = glyph(
  'Files',
  '<path d="M7 7V4a2 2 0 0 1 2-2h9l4 4v12a2 2 0 0 1-2 2h-3"/><path d="M18 6h4"/><rect x="2" y="8" width="14" height="14" rx="2"/><path d="M6 13h6M6 17h4"/>'
)
export const Folder = glyph(
  'Folder',
  '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
)
export const FolderGit2 = glyph(
  'FolderGit2',
  '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v7M12 12h3M12 15h3"/><circle cx="12" cy="10" r=".7" fill="currentColor"/>'
)
export const FolderInput = glyph(
  'FolderInput',
  '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14l3 3 3-3"/>'
)
export const FolderKanban = glyph(
  'FolderKanban',
  '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8 11v5M12 11v3M16 11v5"/>'
)
export const FolderOpen = glyph(
  'FolderOpen',
  '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v1H5a2 2 0 0 0-2 2z"/><path d="m3 12 1.2 6a2 2 0 0 0 2 1.6h11.6a2 2 0 0 0 2-1.6L21 10"/>'
)
export const FolderPlus = glyph(
  'FolderPlus',
  '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14h6"/>'
)
export const FolderTree = glyph(
  'FolderTree',
  '<path d="M3 5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v4"/><path d="M3 8h10v7H3z"/><path d="M13 11h4v5h-4zM17 13h4v6h-4z"/>'
)
export const GitBranch = glyph(
  'GitBranch',
  '<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="16" r="2"/><path d="M6 6v12M18 14a8 8 0 0 0-8-8H6"/>'
)
export const GitCommit = glyph(
  'GitCommit',
  '<path d="M2 12h6M16 12h6"/><circle cx="12" cy="12" r="4"/>'
)
export const GitCommitHorizontal = GitCommit
export const GitMerge = glyph(
  'GitMerge',
  '<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="16" r="2"/><path d="M6 6v12M18 14v-2a8 8 0 0 0-8-8H6M14 16h2"/>'
)
export const GripVertical = glyph(
  'GripVertical',
  '<circle cx="9" cy="5" r="1" fill="currentColor"/><circle cx="15" cy="5" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="19" r="1" fill="currentColor"/><circle cx="15" cy="19" r="1" fill="currentColor"/>'
)
export const Hash = glyph('Hash', '<path d="M5 9h14M4 15h14M10 3 8 21M16 3l-2 18"/>')
export const History = glyph(
  'History',
  '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>'
)
export const ImageIcon = glyph(
  'ImageIcon',
  '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/>'
)
export const KeySquare = glyph(
  'KeySquare',
  '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="12" r="2.5"/><path d="M11.5 12H17l-2 2 1.5 1.5"/>'
)
export const KeyRound = glyph(
  'KeyRound',
  '<circle cx="8" cy="15" r="5"/><path d="m11.5 11.5 9-9 1 1v4h-4v4h-4"/>'
)
export const Keyboard = glyph(
  'Keyboard',
  '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 15h8"/>'
)
export const Layers = glyph(
  'Layers',
  '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>'
)
export const Link2 = glyph(
  'Link2',
  '<path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/>'
)
export const List = glyph(
  'List',
  '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>'
)
export const ListChecks = glyph(
  'ListChecks',
  '<path d="m3 6 1.5 1.5L7 5M10 6h11M3 12l1.5 1.5L7 11M10 12h11M3 18l1.5 1.5L7 17M10 18h11"/>'
)
export const Loader2 = glyph('Loader2', '<path d="M12 3a9 9 0 0 1 9 9"/>')
export const LoaderCircle = glyph('LoaderCircle', '<path d="M12 3a9 9 0 1 1-9 9"/>')
export const Maximize2 = glyph('Maximize2', '<path d="M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7"/>')
export const Minimize2 = glyph('Minimize2', '<path d="M4 14h6v6M10 14l-7 7M20 10h-6V4M14 10l7-7"/>')
export const Menu = glyph('Menu', '<path d="M4 6h16M4 12h16M4 18h16"/>')
export const MessageSquarePlus = glyph(
  'MessageSquarePlus',
  '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 4a8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/><path d="M12 8v6M9 11h6"/>'
)
export const Monitor = glyph(
  'Monitor',
  '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'
)
export const Music2Icon = glyph(
  'Music2Icon',
  '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'
)
export const Network = glyph(
  'Network',
  '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="2" y="16" width="6" height="5" rx="1"/><rect x="16" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M5 16v-4h14v4"/>'
)
export const Palette = glyph(
  'Palette',
  '<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.7-3.1 1.8 1.8 0 0 1 1.5-2.9H18a3 3 0 0 0 3-3 9 9 0 0 0-9-9Z"/><path d="M7.5 12h.01M10 7.5h.01M15 8h.01M17 12h.01"/>'
)
export const PanelLeft = glyph(
  'PanelLeft',
  '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>'
)
export const PanelRight = glyph(
  'PanelRight',
  '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>'
)
export const Paperclip = glyph(
  'Paperclip',
  '<path d="m21.4 11.1-8.5 8.5a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7L10.1 16.8a2 2 0 0 1-2.8-2.8l8.5-8.5"/>'
)
export const PaperclipIcon = Paperclip
export const PenTool = glyph(
  'PenTool',
  '<path d="m12 19 7-7 3 3-7 7-3-3ZM18 13l-1-8-3-3-8 8 8 1M2 22l5-5"/><path d="m9 6 3 3"/>'
)
export const Pencil = glyph(
  'Pencil',
  '<path d="m15 5 4 4M4 20l4-.8L19 8a2.8 2.8 0 0 0-4-4L4 15z"/>'
)
export const Pin = glyph(
  'Pin',
  '<path d="m16 3 5 5-4 1-4 4-1 4-5-5 4-1 4-4z"/><path d="m8 16-5 5"/>'
)
export const RefreshCcw = glyph(
  'RefreshCcw',
  '<path d="M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M21 3v5h-5M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 21v-5h5"/>'
)
export const RefreshCw = glyph(
  'RefreshCw',
  '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 9a7 7 0 0 1 12-2l3 3M4 14l3 3a7 7 0 0 0 12-2"/>'
)
export const RotateCcw = glyph(
  'RotateCcw',
  '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/>'
)
export const Scissors = glyph(
  'Scissors',
  '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8.1 8.1 12.8 12.8M14 14l-5.9 5.9M8.1 15.9 20 4"/>'
)
export const Server = glyph(
  'Server',
  '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6"/>'
)
export const Settings2 = Settings
export const ShieldAlert = glyph(
  'ShieldAlert',
  '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="M12 8v4M12 16h.01"/>'
)
export const ShieldCheck = glyph(
  'ShieldCheck',
  '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m8.5 12 2.3 2.3 4.7-4.8"/>'
)
export const Shuffle = glyph(
  'Shuffle',
  '<path d="m18 14 4 4-4 4M18 2l4 4-4 4"/><path d="M2 18h2a6 6 0 0 0 4-1.5l8-9A6 6 0 0 1 20 6h2M2 6h2a6 6 0 0 1 4 1.5M14 15l2 2A6 6 0 0 0 20 18h2"/>'
)
export const Skull = glyph(
  'Skull',
  '<path d="M12 3a8 8 0 0 0-5 14.2V21h10v-3.8A8 8 0 0 0 12 3Z"/><circle cx="9" cy="11" r="1.5"/><circle cx="15" cy="11" r="1.5"/><path d="M10 16h4M10 21v-3M14 21v-3"/>'
)
export const Sparkles = glyph(
  'Sparkles',
  '<path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/><path d="m19 14 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8zM5 3l.7 2.3L8 6l-2.3.7L5 9l-.7-2.3L2 6l2.3-.7z"/>'
)
export const Square = glyph('Square', '<rect x="4" y="4" width="16" height="16" rx="1"/>')
export const Terminal = glyph(
  'Terminal',
  '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>'
)
export const TerminalSquare = glyph(
  'TerminalSquare',
  '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m7 8 4 4-4 4M13 16h4"/>'
)
export const Tag = glyph(
  'Tag',
  '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V4h9l8.6 8.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="8.5" r="1"/>'
)
export const Type = glyph('Type', '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>')
export const Unlink = glyph(
  'Unlink',
  '<path d="m18 13 1.4-1.4a5 5 0 0 0-7.1-7.1L11 5.8M6 11l-1.4 1.4a5 5 0 0 0 7.1 7.1L13 18.2"/><path d="m8 12 8 0M3 3l18 18"/>'
)
export const Wifi = glyph(
  'Wifi',
  '<path d="M5 12.5a11 11 0 0 1 14 0M8 16a6.5 6.5 0 0 1 8 0M11 19.5a2 2 0 0 1 2 0"/><path d="M2 9a16 16 0 0 1 20 0"/>'
)
export const WifiOff = glyph(
  'WifiOff',
  '<path d="m3 3 18 18M5 12.5a11 11 0 0 1 6-2.5M8 16a6.5 6.5 0 0 1 3-1M16 16a6.5 6.5 0 0 0-1-.6M2 9a16 16 0 0 1 15-2"/>'
)
export const Wrench = glyph(
  'Wrench',
  '<path d="M14.7 6.3a5 5 0 0 0-6.4 6.4L3 18l3 3 5.3-5.3a5 5 0 0 0 6.4-6.4L15 12l-3-3z"/>'
)
export const XCircle = glyph(
  'XCircle',
  '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>'
)
export const XIcon = X
export const Zap = glyph('Zap', '<path d="m13 2-3 9h7L9 22l3-9H5z"/>')
