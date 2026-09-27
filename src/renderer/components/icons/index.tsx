import {
  AlertCircleIcon,
  AlignLeftIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowDown02Icon,
  ArrowExpandIcon,
  ArrowLeft02Icon,
  ArrowLeftRightIcon,
  ArrowRight02Icon,
  ArrowUp02Icon,
  BellIcon,
  BotIcon,
  BrainIcon,
  Bug01Icon,
  Calendar01Icon,
  Camera01Icon,
  CancelCircleIcon,
  CheckIcon,
  CheckmarkCircle02Icon,
  ChevronDownIcon as ChevronDownIconData,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronUpIcon,
  CircleArrowUp02Icon,
  CircleDotIcon,
  CircleIcon,
  ClipboardIcon,
  ClipboardPasteIcon,
  Clock01Icon,
  CodeIcon,
  CopyIcon,
  CopyXIcon,
  CpuIcon,
  Delete01Icon,
  DotIcon,
  Download01Icon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  File02Icon,
  FileCodeIcon,
  FileDiffIcon,
  FileEditIcon,
  FilePlusIcon,
  FileQuestionMarkIcon,
  Files01Icon,
  FileTextIcon as FileTextIconData,
  Folder01Icon,
  FolderGit2Icon,
  FolderInputIcon,
  FolderKanbanIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  Globe02Icon,
  Grid3X3Icon,
  GripVerticalIcon,
  HashIcon,
  HistoryIcon,
  Home01Icon,
  Image02Icon,
  InformationCircleIcon,
  KeyboardIcon,
  KeyRoundIcon,
  KeySquareIcon,
  Layers01Icon,
  Layout2ColumnIcon,
  Link01Icon,
  ListChecksIcon,
  ListIcon,
  LoaderCircleIcon,
  Loading02Icon,
  Menu01Icon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  MinimizeIcon,
  MinusIcon,
  MonitorIcon,
  MoreHorizontalIcon,
  MusicNote01Icon,
  NetworkIcon,
  PaletteIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PaperclipIcon as PaperclipIconData,
  PencilEdit01Icon,
  PencilIcon,
  PenTool01Icon,
  PinIcon,
  PlusIcon,
  RefreshCcwIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
  ScissorsIcon,
  Search01Icon,
  ServerIcon,
  Settings01Icon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShuffleIcon,
  SkullIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquareTerminalIcon,
  Tag01Icon,
  TerminalIcon,
  TriangleAlertIcon,
  TypeIcon,
  Unlink01Icon,
  Upload01Icon,
  Video01Icon,
  Wifi01Icon,
  WifiOff01Icon,
  Wrench01Icon,
  XIcon as XIconData,
  ZapIcon,
  ZoomInIcon,
  ZoomOutIcon
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import {
  type ForwardRefExoticComponent,
  forwardRef,
  type RefAttributes,
  type SVGProps
} from 'react'

export interface TermulIconProps extends SVGProps<SVGSVGElement> {
  size?: number | string
}

export type TermulIcon = ForwardRefExoticComponent<TermulIconProps & RefAttributes<SVGSVGElement>>

function hugeIcon(name: string, icon: IconSvgElement): TermulIcon {
  const Icon = forwardRef<SVGSVGElement, TermulIconProps>(function TermulIcon(
    { size = 24, strokeWidth, children: _children, ...props },
    ref
  ) {
    const requestedStrokeWidth = Number(strokeWidth ?? 1.5)
    const safeStrokeWidth = Number.isFinite(requestedStrokeWidth) ? requestedStrokeWidth : 1.5

    return (
      <HugeiconsIcon
        ref={ref}
        icon={icon}
        size={size}
        color="currentColor"
        strokeWidth={safeStrokeWidth}
        aria-hidden={props['aria-label'] ? undefined : true}
        focusable="false"
        data-termul-icon={name}
        {...props}
      />
    )
  })

  Icon.displayName = name
  return Icon
}

// Hugeicons free Stroke Rounded. Call sites keep the existing component names.
export const Search = hugeIcon('Search', Search01Icon)
export const Home = hugeIcon('Home', Home01Icon)
export const Settings = hugeIcon('Settings', Settings01Icon)
export const Download = hugeIcon('Download', Download01Icon)
export const Upload = hugeIcon('Upload', Upload01Icon)
export const X = hugeIcon('X', XIconData)
export const Plus = hugeIcon('Plus', PlusIcon)
export const Minus = hugeIcon('Minus', MinusIcon)
export const Check = hugeIcon('Check', CheckIcon)
export const Eye = hugeIcon('Eye', EyeIcon)
export const Grid3X3 = hugeIcon('Grid3X3', Grid3X3Icon)
export const MessageSquare = hugeIcon('MessageSquare', MessageSquareIcon)
export const Info = hugeIcon('Info', InformationCircleIcon)
export const Sliders = hugeIcon('Sliders', SlidersHorizontalIcon)
export const Trash2 = hugeIcon('Trash2', Delete01Icon)
export const Save = hugeIcon('Save', SaveIcon)
export const VideoIcon = hugeIcon('VideoIcon', Video01Icon)
export const FileText = hugeIcon('FileText', FileTextIconData)
export const Globe = hugeIcon('Globe', Globe02Icon)
export const MoreHorizontal = hugeIcon('MoreHorizontal', MoreHorizontalIcon)
export const ZoomIn = hugeIcon('ZoomIn', ZoomInIcon)
export const ZoomOut = hugeIcon('ZoomOut', ZoomOutIcon)
export const ArrowLeft = hugeIcon('ArrowLeft', ArrowLeft02Icon)
export const AlertCircle = hugeIcon('AlertCircle', AlertCircleIcon)
export const AlertTriangle = hugeIcon('AlertTriangle', TriangleAlertIcon)
export const AlignLeft = hugeIcon('AlignLeft', AlignLeftIcon)
export const Archive = hugeIcon('Archive', ArchiveIcon)
export const ArchiveRestore = hugeIcon('ArchiveRestore', ArchiveRestoreIcon)
export const ArrowDown = hugeIcon('ArrowDown', ArrowDown02Icon)
export const ArrowRight = hugeIcon('ArrowRight', ArrowRight02Icon)
export const ArrowRightLeft = hugeIcon('ArrowRightLeft', ArrowLeftRightIcon)
export const ArrowUp = hugeIcon('ArrowUp', ArrowUp02Icon)
export const ArrowUpCircle = hugeIcon('ArrowUpCircle', CircleArrowUp02Icon)
export const Bell = hugeIcon('Bell', BellIcon)
export const Bot = hugeIcon('Bot', BotIcon)
export const Brain = hugeIcon('Brain', BrainIcon)
export const Bug = hugeIcon('Bug', Bug01Icon)
export const Calendar = hugeIcon('Calendar', Calendar01Icon)
export const Camera = hugeIcon('Camera', Camera01Icon)
export const CheckCircle2 = hugeIcon('CheckCircle2', CheckmarkCircle02Icon)
export const ChevronDown = hugeIcon('ChevronDown', ChevronDownIconData)
export const ChevronLeft = hugeIcon('ChevronLeft', ChevronLeftIcon)
export const ChevronRight = hugeIcon('ChevronRight', ChevronRightIcon)
export const ChevronUp = hugeIcon('ChevronUp', ChevronUpIcon)
export const ChevronsDownUp = hugeIcon('ChevronsDownUp', ChevronsDownUpIcon)
export const Circle = hugeIcon('Circle', CircleIcon)
export const CircleDot = hugeIcon('CircleDot', CircleDotIcon)
export const Clipboard = hugeIcon('Clipboard', ClipboardIcon)
export const ClipboardPaste = hugeIcon('ClipboardPaste', ClipboardPasteIcon)
export const Clock = hugeIcon('Clock', Clock01Icon)
export const Code2 = hugeIcon('Code2', CodeIcon)
export const Columns2 = hugeIcon('Columns2', Layout2ColumnIcon)
export const Copy = hugeIcon('Copy', CopyIcon)
export const CopyX = hugeIcon('CopyX', CopyXIcon)
export const Cpu = hugeIcon('Cpu', CpuIcon)
export const Dot = hugeIcon('Dot', DotIcon)
export const ExternalLink = hugeIcon('ExternalLink', ExternalLinkIcon)
export const Edit2 = hugeIcon('Edit2', PencilEdit01Icon)
export const EyeOff = hugeIcon('EyeOff', EyeOffIcon)
export const File = hugeIcon('File', File02Icon)
export const FileCode = hugeIcon('FileCode', FileCodeIcon)
export const FileDiff = hugeIcon('FileDiff', FileDiffIcon)
export const FileEdit = hugeIcon('FileEdit', FileEditIcon)
export const FilePlus = hugeIcon('FilePlus', FilePlusIcon)
export const FileQuestion = hugeIcon('FileQuestion', FileQuestionMarkIcon)
export const Files = hugeIcon('Files', Files01Icon)
export const Folder = hugeIcon('Folder', Folder01Icon)
export const FolderGit2 = hugeIcon('FolderGit2', FolderGit2Icon)
export const FolderInput = hugeIcon('FolderInput', FolderInputIcon)
export const FolderKanban = hugeIcon('FolderKanban', FolderKanbanIcon)
export const FolderOpen = hugeIcon('FolderOpen', FolderOpenIcon)
export const FolderPlus = hugeIcon('FolderPlus', FolderPlusIcon)
export const FolderTree = hugeIcon('FolderTree', FolderTreeIcon)
export const GitBranch = hugeIcon('GitBranch', GitBranchIcon)
export const GitCommit = hugeIcon('GitCommit', GitCommitHorizontalIcon)
export const GitMerge = hugeIcon('GitMerge', GitMergeIcon)
export const GripVertical = hugeIcon('GripVertical', GripVerticalIcon)
export const Hash = hugeIcon('Hash', HashIcon)
export const History = hugeIcon('History', HistoryIcon)
export const ImageIcon = hugeIcon('ImageIcon', Image02Icon)
export const KeySquare = hugeIcon('KeySquare', KeySquareIcon)
export const KeyRound = hugeIcon('KeyRound', KeyRoundIcon)
export const Keyboard = hugeIcon('Keyboard', KeyboardIcon)
export const Layers = hugeIcon('Layers', Layers01Icon)
export const Link2 = hugeIcon('Link2', Link01Icon)
export const List = hugeIcon('List', ListIcon)
export const ListChecks = hugeIcon('ListChecks', ListChecksIcon)
export const Loader2 = hugeIcon('Loader2', Loading02Icon)
export const LoaderCircle = hugeIcon('LoaderCircle', LoaderCircleIcon)
export const Maximize2 = hugeIcon('Maximize2', ArrowExpandIcon)
export const Minimize2 = hugeIcon('Minimize2', MinimizeIcon)
export const Menu = hugeIcon('Menu', Menu01Icon)
export const MessageSquarePlus = hugeIcon('MessageSquarePlus', MessageSquarePlusIcon)
export const Monitor = hugeIcon('Monitor', MonitorIcon)
export const Music2Icon = hugeIcon('Music2Icon', MusicNote01Icon)
export const Network = hugeIcon('Network', NetworkIcon)
export const Palette = hugeIcon('Palette', PaletteIcon)
export const PanelLeft = hugeIcon('PanelLeft', PanelLeftIcon)
export const PanelRight = hugeIcon('PanelRight', PanelRightIcon)
export const Paperclip = hugeIcon('Paperclip', PaperclipIconData)
export const PenTool = hugeIcon('PenTool', PenTool01Icon)
export const Pencil = hugeIcon('Pencil', PencilIcon)
export const Pin = hugeIcon('Pin', PinIcon)
export const RefreshCcw = hugeIcon('RefreshCcw', RefreshCcwIcon)
export const RefreshCw = hugeIcon('RefreshCw', RefreshCwIcon)
export const RotateCcw = hugeIcon('RotateCcw', RotateCcwIcon)
export const Scissors = hugeIcon('Scissors', ScissorsIcon)
export const Server = hugeIcon('Server', ServerIcon)
export const ShieldAlert = hugeIcon('ShieldAlert', ShieldAlertIcon)
export const ShieldCheck = hugeIcon('ShieldCheck', ShieldCheckIcon)
export const Shuffle = hugeIcon('Shuffle', ShuffleIcon)
export const Skull = hugeIcon('Skull', SkullIcon)
export const Sparkles = hugeIcon('Sparkles', SparklesIcon)
export const Terminal = hugeIcon('Terminal', TerminalIcon)
export const TerminalSquare = hugeIcon('TerminalSquare', SquareTerminalIcon)
export const Tag = hugeIcon('Tag', Tag01Icon)
export const Type = hugeIcon('Type', TypeIcon)
export const Unlink = hugeIcon('Unlink', Unlink01Icon)
export const Wifi = hugeIcon('Wifi', Wifi01Icon)
export const WifiOff = hugeIcon('WifiOff', WifiOff01Icon)
export const Wrench = hugeIcon('Wrench', Wrench01Icon)
export const XCircle = hugeIcon('XCircle', CancelCircleIcon)
export const Zap = hugeIcon('Zap', ZapIcon)

// The stop button fills this square, so this glyph stays in the app.
export const Square = forwardRef<SVGSVGElement, TermulIconProps>(function Square(
  { size = 24, strokeWidth, children: _children, ...props },
  ref
) {
  const requestedStrokeWidth = Number(strokeWidth ?? 1.5)
  const safeStrokeWidth = Number.isFinite(requestedStrokeWidth) ? requestedStrokeWidth : 1.5

  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden is set unless the caller passes aria-label
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
      data-termul-icon="Square"
      {...props}
    >
      <rect x="4" y="4" width="16" height="16" rx="1" />
    </svg>
  )
})

export const ChevronDownIcon = ChevronDown
export const Clock3 = Clock
export const FilePen = FileEdit
export const FileTextIcon = FileText
export const GitCommitHorizontal = GitCommit
export const GlobeIcon = Globe
export const PaperclipIcon = Paperclip
export const Settings2 = Settings
export const SlidersHorizontal = Sliders
export const XIcon = X
