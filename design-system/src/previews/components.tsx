import { useState } from 'react'
import robotIcon from '@/assets/agent-icons/robot.svg'
import {
  Check,
  ChevronDown,
  Copy,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Terminal,
  Trash2
} from '@/components/icons'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Bubble, BubbleContent, BubbleGroup, BubbleReactions } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CountBadge } from '@/components/ui/count-badge'
import { DiffStatCounts } from '@/components/ui/diff-stat-counts'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { IconActionButton, IconActionGroup } from '@/components/ui/icon-action-button'
import { IconSwap } from '@/components/ui/icon-swap'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import { MarqueeText } from '@/components/ui/marquee-text'
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader
} from '@/components/ui/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import {
  FOCUS_RING_CLASS,
  PANEL_FIELD_CLASS,
  PANEL_HEADER_CLASS,
  PANEL_ICON_BUTTON_CLASS,
  pressedToggleClass,
  QUIET_ICON_BUTTON_CLASS,
  SEGMENTED_TRACK_CLASS,
  segmentClass
} from '@/components/ui/panel-styles'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PopoverSearchBand } from '@/components/ui/popover-search-band'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { WriteGate, WriteGateReason } from '@/components/ui/write-gate'
import { cn } from '@/lib/utils'
import { Caption, Pad, Row } from './kit'
import { MOCK_BRANCHES, MOCK_FILES, MOCK_MESSAGES } from './mocks'

/* ------------------------------------------------------------------ Button */

const BUTTON_VARIANTS = [
  'default',
  'secondary',
  'outline',
  'ghost',
  'destructive',
  'link',
  'composer'
] as const

export function ButtonVariants() {
  return (
    <Pad className="gap-4">
      {BUTTON_VARIANTS.map((variant) => (
        <Row key={variant} label={variant}>
          <Button variant={variant}>Run task</Button>
          <Button variant={variant}>
            <Plus aria-hidden />
            New session
          </Button>
          <Button variant={variant} disabled>
            Disabled
          </Button>
        </Row>
      ))}
      <Caption>
        One default button per view. composer is reserved for send, stop and launch.
      </Caption>
    </Pad>
  )
}

export function ButtonSizes() {
  return (
    <Pad className="gap-4">
      {(['xs', 'sm', 'default', 'lg', 'touch'] as const).map((size) => (
        <Row key={size} label={size}>
          <Button size={size} variant="outline">
            Open folder
          </Button>
        </Row>
      ))}
      <Row label="icon sizes">
        {(['icon-xs', 'icon-sm', 'icon', 'icon-lg'] as const).map((size) => (
          <Button key={size} size={size} variant="outline" aria-label={`Settings, ${size}`}>
            <Settings aria-hidden />
          </Button>
        ))}
      </Row>
    </Pad>
  )
}

export function ButtonStates() {
  return (
    <Pad className="gap-4">
      <Row label="loading">
        <Button disabled>
          <Spinner size={14} decorative />
          Connecting
        </Button>
        <Button variant="outline" disabled>
          <Spinner size={14} decorative />
          Fetching
        </Button>
      </Row>
      <Row label="focus">
        <Button variant="outline" className="ring-2 ring-ring">
          Forced focus ring
        </Button>
      </Row>
      <Row label="as link">
        <Button variant="link" asChild>
          <a href="#termul-docs">Read the docs</a>
        </Button>
      </Row>
    </Pad>
  )
}

/* ------------------------------------------------- Badge, counts, keys */

export function Badges() {
  return (
    <Pad className="gap-4">
      <Row label="Badge">
        {(['default', 'secondary', 'outline', 'destructive'] as const).map((variant) => (
          <Badge key={variant} variant={variant}>
            {variant}
          </Badge>
        ))}
      </Row>
      <Row label="CountBadge">
        <CountBadge count={3} />
        <CountBadge count={42} />
        <CountBadge count={1500} max={99} />
      </Row>
      <Row label="DiffStat">
        <DiffStatCounts added={128} removed={14} />
        <DiffStatCounts added={7} removed={0} omitZero />
      </Row>
      <Row label="Kbd">
        <Kbd className="px-1.5 py-0.5">Ctrl+K</Kbd>
        <Kbd className="px-1.5 py-0.5">Esc</Kbd>
        <Kbd className="px-1.5 py-0.5">⌘ ⇧ P</Kbd>
      </Row>
    </Pad>
  )
}

/* -------------------------------------------------------- Toggle, switch */

export function Toggles() {
  const [bold, setBold] = useState(true)
  const [on, setOn] = useState(true)
  return (
    <Pad className="gap-4">
      {(['default', 'outline'] as const).map((variant) => (
        <Row key={variant} label={variant}>
          {(['sm', 'default', 'lg'] as const).map((size) => (
            <Toggle key={size} variant={variant} size={size} aria-label={`Wrap, ${size}`}>
              <Terminal aria-hidden />
            </Toggle>
          ))}
          <Toggle variant={variant} pressed={bold} onPressedChange={setBold}>
            {bold ? 'Pressed' : 'Not pressed'}
          </Toggle>
          <Toggle variant={variant} disabled>
            Disabled
          </Toggle>
        </Row>
      ))}
      <Row label="Switch">
        <div className="flex items-center gap-2">
          <Switch id="ds-switch-on" checked={on} onCheckedChange={setOn} />
          <Label htmlFor="ds-switch-on">{on ? 'On' : 'Off'}</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="ds-switch-disabled" disabled />
          <Label htmlFor="ds-switch-disabled">Disabled</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="ds-switch-disabled-on" disabled checked />
          <Label htmlFor="ds-switch-disabled-on">Disabled, on</Label>
        </div>
      </Row>
    </Pad>
  )
}

/* ---------------------------------------------------------------- Fields */

export function TextFields() {
  return (
    <Pad className="gap-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="ds-input-default">Default</Label>
          <Input id="ds-input-default" placeholder="api-server" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="ds-input-filled">Filled</Label>
          <Input id="ds-input-filled" defaultValue="~/code/termul" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="ds-input-invalid">Invalid</Label>
          <Input id="ds-input-invalid" aria-invalid defaultValue="no spaces allowed" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="ds-input-disabled">Disabled</Label>
          <Input id="ds-input-disabled" disabled defaultValue="Read only" />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="ds-textarea">Textarea</Label>
        <Textarea id="ds-textarea" placeholder="Describe the change for the agent…" rows={3} />
      </div>
    </Pad>
  )
}

export function SelectPreview() {
  return (
    <Pad className="gap-4">
      <Row label="default">
        <Select defaultValue="main">
          <SelectTrigger aria-label="Branch" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Local branches</SelectLabel>
              {MOCK_BRANCHES.map((branch) => (
                <SelectItem key={branch} value={branch}>
                  {branch}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Row>
      <Row label="placeholder">
        <Select>
          <SelectTrigger aria-label="Shell" className="w-56">
            <SelectValue placeholder="Choose a shell" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bash">bash</SelectItem>
            <SelectItem value="zsh">zsh</SelectItem>
            <SelectItem value="fish">fish</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="disabled">
        <Select disabled defaultValue="bash">
          <SelectTrigger aria-label="Shell, disabled" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bash">bash</SelectItem>
          </SelectContent>
        </Select>
      </Row>
    </Pad>
  )
}

export function PanelStyles() {
  const [segment, setSegment] = useState('changes')
  const [pills, setPills] = useState<Record<string, boolean>>({ ts: true, css: false })
  return (
    <Pad className="gap-4">
      <Row label="segmented">
        <div className={SEGMENTED_TRACK_CLASS} role="tablist" aria-label="Git view">
          {['changes', 'history', 'stash'].map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={segment === id}
              className={cn(segmentClass(segment === id), 'h-7 capitalize')}
              onClick={() => setSegment(id)}
            >
              {id}
            </button>
          ))}
        </div>
      </Row>
      <Row label="pressed">
        {Object.entries(pills).map(([id, pressed]) => (
          <button
            key={id}
            type="button"
            aria-pressed={pressed}
            className={cn(
              'h-7 rounded-md border px-2.5 text-xs transition-colors',
              pressedToggleClass(pressed),
              FOCUS_RING_CLASS
            )}
            onClick={() => setPills((current) => ({ ...current, [id]: !pressed }))}
          >
            .{id}
          </button>
        ))}
      </Row>
      <Row label="panel field">
        <input
          aria-label="Filter files"
          placeholder="Filter files"
          className={cn(PANEL_FIELD_CLASS, 'h-8 w-56 px-2.5')}
        />
      </Row>
      <Row label="panel header">
        <div className={cn(PANEL_HEADER_CLASS, 'w-72 rounded-lg border border-border bg-card')}>
          <span className="label-section text-foreground">Explorer</span>
          <div className="flex">
            <button type="button" aria-label="New file" className={PANEL_ICON_BUTTON_CLASS}>
              <Plus size={14} aria-hidden />
            </button>
            <button type="button" aria-label="Refresh" className={PANEL_ICON_BUTTON_CLASS}>
              <RefreshCw size={14} aria-hidden />
            </button>
          </div>
        </div>
      </Row>
      <Row label="quiet icon">
        <button type="button" aria-label="More" className={cn(QUIET_ICON_BUTTON_CLASS, 'size-8')}>
          <MoreHorizontal size={16} aria-hidden />
        </button>
      </Row>
    </Pad>
  )
}

/* -------------------------------------------------------------- Feedback */

export function Loading() {
  return (
    <Pad className="gap-4">
      <Row label="Spinner">
        <Spinner size={12} label="Loading, small" />
        <Spinner size={16} label="Loading" />
        <Spinner size={24} label="Loading, large" />
      </Row>
      <Row label="Shimmer">
        <ShimmerText text="Thinking about the diff…" />
      </Row>
      <Row label="Skeleton">
        <div className="flex w-full flex-col gap-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-16 w-full" />
        </div>
      </Row>
    </Pad>
  )
}

export function TextMotion() {
  const [copied, setCopied] = useState(false)
  return (
    <Pad className="gap-4">
      <Row label="Marquee">
        <div className="w-48 rounded-md border border-border px-2 py-1 text-xs">
          <MarqueeText text="feature/very-long-branch-name-that-overflows-the-tab" />
        </div>
      </Row>
      <Row label="IconSwap">
        <Button variant="outline" size="sm" onClick={() => setCopied((value) => !value)}>
          <IconSwap iconKey={copied}>{copied ? <Check /> : <Copy />}</IconSwap>
          {copied ? 'Copied' : 'Copy path'}
        </Button>
      </Row>
      <Caption>Hover the marquee to scroll it. IconSwap cross-fades on each click.</Caption>
    </Pad>
  )
}

export function WriteGates() {
  return (
    <Pad className="gap-4">
      <Row label="gated">
        <WriteGate gated>
          <Button variant="outline" disabled>
            <Pencil aria-hidden />
            Edit file
          </Button>
        </WriteGate>
      </Row>
      <Row label="ungated">
        <WriteGate gated={false}>
          <Button variant="outline">
            <Pencil aria-hidden />
            Edit file
          </Button>
        </WriteGate>
      </Row>
      <Row label="reason">
        <span className="text-xs text-muted-foreground">
          <WriteGateReason />
          Screen readers hear the reason; sighted users get it on hover.
        </span>
      </Row>
    </Pad>
  )
}

/* ------------------------------------------------------------ Disclosure */

export function AccordionPreview() {
  return (
    <Pad>
      <Accordion type="single" collapsible defaultValue="shell">
        <AccordionItem value="shell">
          <AccordionTrigger>Shell</AccordionTrigger>
          <AccordionContent>Default shell, login arguments and environment.</AccordionContent>
        </AccordionItem>
        <AccordionItem value="font">
          <AccordionTrigger>Font</AccordionTrigger>
          <AccordionContent>Terminal font family, size and ligatures.</AccordionContent>
        </AccordionItem>
        <AccordionItem value="keys">
          <AccordionTrigger>Keyboard</AccordionTrigger>
          <AccordionContent>Shortcut scheme and copy-on-select.</AccordionContent>
        </AccordionItem>
      </Accordion>
    </Pad>
  )
}

export function CollapsiblePreview() {
  const [open, setOpen] = useState(true)
  const [motionOpen, setMotionOpen] = useState(false)
  return (
    <Pad className="gap-4">
      <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="w-fit">
            <ChevronDown
              aria-hidden
              className={cn('transition-transform duration-150', !open && '-rotate-90')}
            />
            Collapsible · {MOCK_FILES.length} files
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-1 pl-7 font-mono text-xs text-muted-foreground">
          {MOCK_FILES.map((file) => (
            <span key={file.path}>{file.path}</span>
          ))}
        </CollapsibleContent>
      </Collapsible>
      <Separator />
      <div className="flex flex-col gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="w-fit"
          onClick={() => setMotionOpen((v) => !v)}
        >
          CollapseExpandMotion · {motionOpen ? 'open' : 'closed'}
        </Button>
        <CollapseExpandMotion open={motionOpen} motion="chat">
          <p className="rounded-lg bg-card p-3 text-xs text-muted-foreground">
            Height and opacity animate on the chat accordion token.
          </p>
        </CollapseExpandMotion>
      </div>
    </Pad>
  )
}

/* ------------------------------------------------------- Floating layers */

export function FloatingPreview() {
  const [query, setQuery] = useState('')
  return (
    <Pad className="gap-4">
      <Row label="Tooltip">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon-sm" aria-label="Split terminal">
              <Terminal aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Split terminal</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm">
              Hover or focus
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Opens after --tt-delay</TooltipContent>
        </Tooltip>
      </Row>
      <Row label="HoverCard">
        <HoverCard openDelay={120}>
          <HoverCardTrigger asChild>
            <Button variant="link" className="px-0">
              <GitBranch aria-hidden />
              feature/canvas
            </Button>
          </HoverCardTrigger>
          <HoverCardContent className="w-64 text-xs">
            <p className="font-medium text-foreground">feature/canvas</p>
            <p className="text-muted-foreground">3 commits ahead of dev · updated 2h ago</p>
          </HoverCardContent>
        </HoverCard>
      </Row>
      <Row label="Popover">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <Search aria-hidden />
              Find branch
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-0" align="start">
            <PopoverSearchBand
              value={query}
              onChange={setQuery}
              placeholder="Search branches"
              ariaLabel="Search branches"
              autoFocus
            />
            <ul className="p-1">
              {MOCK_BRANCHES.filter((branch) => branch.includes(query)).map((branch) => (
                <li key={branch} className="rounded-md px-2 py-1.5 text-xs hover:bg-row-hover">
                  {branch}
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      </Row>
      <Row label="Lightbox">
        <ImageLightbox src={robotIcon} alt="Robot agent icon">
          <img
            src={robotIcon}
            alt="Robot agent icon thumbnail"
            className="size-12 rounded-md border border-border bg-card p-2"
          />
        </ImageLightbox>
      </Row>
    </Pad>
  )
}

/* ----------------------------------------------------------- Layout */

export function ScrollAreaPreview() {
  return (
    <Pad className="gap-3">
      <ScrollArea className="h-44 rounded-lg border border-border">
        <ul className="p-2">
          {Array.from({ length: 24 }, (_, index) => (
            <li
              key={index}
              className="rounded-md px-2 py-1.5 font-mono text-xs text-muted-foreground hover:bg-row-hover"
            >
              session-{String(index + 1).padStart(2, '0')} · zsh
            </li>
          ))}
        </ul>
      </ScrollArea>
      <Caption>The wheel scrolls this list first, then pans the canvas at its edge.</Caption>
    </Pad>
  )
}

export function ResizablePreview() {
  return (
    <Pad className="gap-3">
      <div className="h-48 overflow-hidden rounded-lg border border-border">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={35} minSize={20}>
            <div className="flex h-full items-center justify-center bg-card text-xs text-muted-foreground">
              Explorer
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={65}>
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel defaultSize={60}>
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  Editor
                </div>
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize={40}>
                <div className="flex h-full items-center justify-center bg-terminal-bg font-mono text-xs text-terminal-fg">
                  terminal
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <Row label="Separator">
        <span className="text-xs">Left</span>
        <Separator orientation="vertical" className="h-4" />
        <span className="text-xs">Right</span>
      </Row>
    </Pad>
  )
}

export function IconActions() {
  return (
    <Pad className="gap-4">
      <Row label="group">
        <IconActionGroup>
          <IconActionButton label="Copy" onClick={() => undefined}>
            <Copy aria-hidden />
          </IconActionButton>
          <IconActionButton label="Edit" onClick={() => undefined}>
            <Pencil aria-hidden />
          </IconActionButton>
          <IconActionButton label="Delete" onClick={() => undefined}>
            <Trash2 aria-hidden />
          </IconActionButton>
        </IconActionGroup>
      </Row>
      <Row label="dense, sm">
        <IconActionGroup dense>
          <IconActionButton label="Copy" size="sm" onClick={() => undefined}>
            <Copy aria-hidden />
          </IconActionButton>
          <IconActionButton label="Retry" size="sm" onClick={() => undefined}>
            <RefreshCw aria-hidden />
          </IconActionButton>
          <IconActionButton label="Delete, disabled" size="sm" disabled onClick={() => undefined}>
            <Trash2 aria-hidden />
          </IconActionButton>
        </IconActionGroup>
      </Row>
    </Pad>
  )
}

/* ------------------------------------------------------------ Chat parts */

export function BubbleVariants() {
  return (
    <Pad className="gap-4">
      {(['default', 'secondary', 'outline', 'ghost', 'destructive'] as const).map((variant) => (
        <Row key={variant} label={variant}>
          <Bubble variant={variant}>
            <BubbleContent>Run the test suite before merging.</BubbleContent>
          </Bubble>
        </Row>
      ))}
      <Row label="reactions">
        <BubbleGroup>
          <Bubble variant="secondary" className="relative">
            <BubbleContent>Ship it.</BubbleContent>
            <BubbleReactions>👍 2</BubbleReactions>
          </Bubble>
        </BubbleGroup>
      </Row>
    </Pad>
  )
}

export function MarkerVariants() {
  return (
    <Pad className="gap-4">
      <Marker>
        <MarkerIcon>
          <GitBranch />
        </MarkerIcon>
        <MarkerContent>Switched to feature/canvas</MarkerContent>
      </Marker>
      <Marker variant="border">
        <MarkerIcon>
          <Check />
        </MarkerIcon>
        <MarkerContent>Tests passed in 12.4s</MarkerContent>
      </Marker>
      <Marker variant="separator">
        <MarkerContent>Today</MarkerContent>
      </Marker>
    </Pad>
  )
}

export function MessagePreview() {
  return (
    <MessageScrollerProvider>
      <MessageScroller className="h-full">
        <MessageScrollerViewport>
          <MessageScrollerContent live={false} className="gap-4 p-5">
            {MOCK_MESSAGES.map((message) => (
              <MessageScrollerItem key={message.id} messageId={message.id}>
                <MessageGroup>
                  <Message align={message.from === 'you' ? 'end' : 'start'}>
                    <MessageAvatar>
                      <span
                        data-slot="avatar"
                        className="grid place-items-center rounded-full bg-muted text-xs text-foreground"
                      >
                        {message.from === 'you' ? 'FI' : 'AI'}
                      </span>
                    </MessageAvatar>
                    <MessageContent>
                      <MessageHeader>
                        <span className="text-xs text-muted-foreground">
                          {message.from === 'you' ? 'You' : 'Agent'} · {message.time}
                        </span>
                      </MessageHeader>
                      <Bubble variant={message.from === 'you' ? 'default' : 'secondary'}>
                        <BubbleContent>{message.text}</BubbleContent>
                      </Bubble>
                      {message.from === 'agent' ? (
                        <MessageFooter>
                          <IconActionGroup dense>
                            <IconActionButton label="Copy" size="sm" onClick={() => undefined}>
                              <Copy aria-hidden />
                            </IconActionButton>
                          </IconActionGroup>
                        </MessageFooter>
                      ) : null}
                    </MessageContent>
                  </Message>
                </MessageGroup>
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
