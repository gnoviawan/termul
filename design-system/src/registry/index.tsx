import * as C from '../previews/components'
import * as F from '../previews/foundations'
import * as P from '../previews/patterns'
import * as S from '../previews/surfaces'
import * as T from '../previews/tokens'
import type { CanvasEntry, CanvasSection } from './types'

const THEMES = 'src/renderer/lib/themes'
const INDEX_CSS = 'src/renderer/index.css'
const UI = 'src/renderer/components/ui'

function tokens(id: string, name: string, list: readonly F.TokenSpec[], width = 480): CanvasEntry {
  return {
    id,
    name,
    source: INDEX_CSS,
    width,
    height: Math.ceil(22 + list.length * 52.5),
    Preview: F.tokenPreview(list)
  }
}

export const SECTIONS: CanvasSection[] = [
  {
    id: 'foundations',
    title: 'Foundations',
    description:
      'Tokens read live from the running theme: color, type, space, radius, elevation, motion and icons.',
    groups: [
      {
        id: 'color-surface',
        title: 'Color: surface and text',
        entries: [
          tokens('color.surface', 'Surface tokens', F.SURFACE_TOKENS),
          tokens('color.text', 'Text tokens', F.TEXT_TOKENS)
        ]
      },
      {
        id: 'color-accent',
        title: 'Color: accent and status',
        entries: [
          tokens('color.accent', 'Accent tokens', F.ACCENT_TOKENS),
          tokens('color.status', 'Status tokens', F.STATUS_TOKENS),
          {
            id: 'color.brand',
            name: 'Brand scale',
            source: `${THEMES}/termul-brand.ts`,
            width: 560,
            height: 316,
            Preview: T.BrandScale
          }
        ]
      },
      {
        id: 'color-line',
        title: 'Color: lines and diff',
        entries: [
          tokens('color.line', 'Line and focus tokens', F.LINE_TOKENS),
          tokens('color.diff', 'Diff tokens', F.DIFF_TOKENS)
        ]
      },
      {
        id: 'color-chrome',
        title: 'Color: app chrome',
        entries: [
          tokens('color.sidebar', 'Sidebar tokens', F.SIDEBAR_TOKENS),
          tokens('color.project', 'Project tokens', F.PROJECT_TOKENS),
          tokens('color.status-bar', 'Status bar tokens', F.STATUS_BAR_TOKENS)
        ]
      },
      {
        id: 'themes',
        title: 'Themes',
        entries: [
          {
            id: 'themes.palettes',
            name: 'Bundled themes',
            source: THEMES,
            width: 720,
            height: 784,
            Preview: F.ThemePalettes
          },
          {
            id: 'themes.syntax',
            name: 'Syntax colors',
            source: `${THEMES}/syntax`,
            width: 560,
            height: 348,
            Preview: F.SyntaxColors
          }
        ]
      },
      {
        id: 'type',
        title: 'Typography',
        entries: [
          {
            id: 'type.scale',
            name: 'Type scale',
            source: 'tailwind.config.ts',
            width: 640,
            height: 380,
            Preview: F.TypeScale
          },
          {
            id: 'type.families',
            name: 'Font families',
            source: INDEX_CSS,
            width: 560,
            height: 252,
            Preview: F.FontFamilies
          },
          {
            id: 'type.labels',
            name: 'Label roles',
            source: INDEX_CSS,
            width: 480,
            height: 192,
            Preview: F.LabelRoles
          }
        ]
      },
      {
        id: 'space',
        title: 'Spacing, radius, elevation',
        entries: [
          {
            id: 'space.scale',
            name: 'Spacing scale',
            source: 'tailwind.config.ts',
            width: 520,
            height: 376,
            Preview: F.SpacingScale
          },
          {
            id: 'space.radius',
            name: 'Radius scale',
            source: 'tailwind.config.ts',
            width: 560,
            height: 196,
            Preview: F.RadiusScale
          },
          {
            id: 'space.shadow',
            name: 'Shadows',
            source: INDEX_CSS,
            width: 560,
            height: 304,
            Preview: F.ShadowScale
          },
          {
            id: 'space.elevation',
            name: 'Elevation ladder',
            source: `${THEMES}/component-tokens.ts`,
            width: 600,
            height: 410,
            Preview: T.ElevationLadder
          }
        ]
      },
      {
        id: 'motion',
        title: 'Motion',
        entries: [
          {
            id: 'motion.durations',
            name: 'Durations',
            source: INDEX_CSS,
            width: 560,
            height: 276,
            Preview: F.MotionDurations
          },
          {
            id: 'motion.easings',
            name: 'Easings',
            source: INDEX_CSS,
            width: 640,
            height: 304,
            Preview: F.MotionEasings
          },
          {
            id: 'motion.tokens',
            name: 'Distance, scale, blur',
            source: INDEX_CSS,
            width: 480,
            height: 228,
            Preview: F.MotionTokens
          }
        ]
      },
      {
        id: 'icons',
        title: `Icons (${F.ICON_COUNT})`,
        entries: [
          {
            id: 'icons.grid',
            name: 'Icon set',
            source: 'src/renderer/components/icons',
            width: 880,
            height: 1248,
            Preview: F.IconGrid
          }
        ]
      }
    ]
  },
  {
    id: 'components',
    title: 'Components',
    description: 'Primitives from components/ui, mounted with mock props.',
    groups: [
      {
        id: 'actions',
        title: 'Actions',
        entries: [
          {
            id: 'button.variants',
            name: 'Button variants',
            source: `${UI}/button.tsx`,
            width: 560,
            height: 456,
            Preview: C.ButtonVariants
          },
          {
            id: 'button.sizes',
            name: 'Button sizes',
            source: `${UI}/button.tsx`,
            width: 560,
            height: 356,
            Preview: C.ButtonSizes
          },
          {
            id: 'button.states',
            name: 'Button states',
            source: `${UI}/button.tsx`,
            width: 560,
            height: 196,
            Preview: C.ButtonStates
          },
          {
            id: 'toggle',
            name: 'Toggle and Switch',
            source: `${UI}/toggle.tsx`,
            width: 520,
            height: 288,
            Preview: C.Toggles
          },
          {
            id: 'switch.states',
            name: 'Switch states',
            source: `${UI}/switch.tsx`,
            width: 560,
            height: 292,
            Preview: T.SwitchStates
          },
          {
            id: 'button.emboss',
            name: 'Emboss and fill states',
            source: `${UI}/button.tsx`,
            width: 560,
            height: 260,
            Preview: T.EmbossStates
          },
          {
            id: 'icon-actions',
            name: 'Icon actions',
            source: `${UI}/icon-action-button.tsx`,
            width: 480,
            height: 144,
            Preview: C.IconActions
          }
        ]
      },
      {
        id: 'display',
        title: 'Display',
        entries: [
          {
            id: 'badges',
            name: 'Badges and counts',
            source: `${UI}/badge.tsx`,
            width: 520,
            height: 184,
            Preview: C.Badges
          },
          {
            id: 'loading',
            name: 'Loading',
            source: `${UI}/spinner.tsx`,
            width: 520,
            height: 236,
            Preview: C.Loading
          },
          {
            id: 'text-motion',
            name: 'Text motion',
            source: `${UI}/marquee-text.tsx`,
            width: 480,
            height: 156,
            Preview: C.TextMotion
          },
          {
            id: 'write-gate',
            name: 'Write gate',
            source: `${UI}/write-gate.tsx`,
            width: 480,
            height: 188,
            Preview: C.WriteGates
          }
        ]
      },
      {
        id: 'inputs',
        title: 'Inputs',
        entries: [
          {
            id: 'text-fields',
            name: 'Input and Textarea',
            source: `${UI}/input.tsx`,
            width: 520,
            height: 300,
            Preview: C.TextFields
          },
          {
            id: 'select',
            name: 'Select',
            source: `${UI}/select.tsx`,
            width: 480,
            height: 196,
            Preview: C.SelectPreview
          },
          {
            id: 'panel-styles',
            name: 'Panel styles',
            source: `${UI}/panel-styles.ts`,
            width: 560,
            height: 272,
            Preview: C.PanelStyles
          }
        ]
      },
      {
        id: 'disclosure',
        title: 'Disclosure and floating',
        entries: [
          {
            id: 'accordion',
            name: 'Accordion',
            source: `${UI}/accordion.tsx`,
            width: 480,
            height: 340,
            Preview: C.AccordionPreview
          },
          {
            id: 'collapsible',
            name: 'Collapsible',
            source: `${UI}/collapsible.tsx`,
            width: 480,
            height: 304,
            Preview: C.CollapsiblePreview
          },
          {
            id: 'floating',
            name: 'Tooltip, HoverCard, Popover, Lightbox',
            source: `${UI}/tooltip.tsx`,
            width: 560,
            height: 252,
            Preview: C.FloatingPreview
          }
        ]
      },
      {
        id: 'layout',
        title: 'Layout',
        entries: [
          {
            id: 'scroll-area',
            name: 'ScrollArea',
            source: `${UI}/scroll-area.tsx`,
            width: 420,
            height: 252,
            Preview: C.ScrollAreaPreview
          },
          {
            id: 'resizable',
            name: 'Resizable panels',
            source: `${UI}/resizable.tsx`,
            width: 560,
            height: 268,
            Preview: C.ResizablePreview
          }
        ]
      },
      {
        id: 'chat',
        title: 'Chat parts',
        entries: [
          {
            id: 'bubble',
            name: 'Bubble variants',
            source: `${UI}/bubble.tsx`,
            width: 520,
            height: 384,
            Preview: C.BubbleVariants
          },
          {
            id: 'marker',
            name: 'Marker variants',
            source: `${UI}/marker.tsx`,
            width: 480,
            height: 132,
            Preview: C.MarkerVariants
          },
          {
            id: 'message',
            name: 'Message scroller',
            source: `${UI}/message-scroller.tsx`,
            width: 560,
            height: 432,
            Preview: C.MessagePreview
          }
        ]
      }
    ]
  },
  {
    id: 'patterns',
    title: 'Patterns',
    description: 'Overlays, menus, feedback and forms composed from the primitives.',
    groups: [
      {
        id: 'overlays',
        title: 'Overlays',
        entries: [
          {
            id: 'dialog',
            name: 'Dialog and AlertDialog',
            source: `${UI}/dialog.tsx`,
            width: 480,
            height: 140,
            Preview: P.DialogPreview
          },
          {
            id: 'sheet',
            name: 'Sheet',
            source: `${UI}/sheet.tsx`,
            width: 480,
            height: 116,
            Preview: P.SheetPreview
          },
          {
            id: 'confirm-dialog',
            name: 'ConfirmDialog',
            source: 'src/renderer/components/ConfirmDialog.tsx',
            width: 480,
            height: 120,
            Preview: P.ConfirmDialogPreview
          }
        ]
      },
      {
        id: 'menus',
        title: 'Menus and command',
        entries: [
          {
            id: 'menus',
            name: 'DropdownMenu and ContextMenu',
            source: `${UI}/dropdown-menu.tsx`,
            width: 480,
            height: 180,
            Preview: P.DropdownMenuPreview
          },
          {
            id: 'command',
            name: 'Command',
            source: `${UI}/command.tsx`,
            width: 520,
            height: 372,
            Preview: P.CommandPreview
          }
        ]
      },
      {
        id: 'feedback',
        title: 'Feedback and status',
        entries: [
          {
            id: 'toast',
            name: 'Toasts',
            source: `${UI}/sonner.tsx`,
            width: 560,
            height: 216,
            Preview: P.ToastPreview
          },
          {
            id: 'status',
            name: 'Status',
            source: 'src/renderer/components/sidebar/indicators.tsx',
            width: 560,
            height: 220,
            Preview: P.StatusPreview
          },
          {
            id: 'connection',
            name: 'Connection states',
            source: 'src/renderer/components/ssh/ssh-host-status.tsx',
            width: 520,
            height: 348,
            Preview: P.ConnectionStatesPreview
          }
        ]
      },
      {
        id: 'forms',
        title: 'Forms',
        entries: [
          {
            id: 'form',
            name: 'Settings form',
            source: `${UI}/input.tsx`,
            width: 480,
            height: 532,
            Preview: P.FormPreview
          }
        ]
      }
    ]
  },
  {
    id: 'surfaces',
    title: 'Product surfaces',
    description:
      'Small product parts with mock data. Store-bound surfaces (sidebar, palette, terminal, chat) are not mounted.',
    groups: [
      {
        id: 'identity',
        title: 'Identity',
        entries: [
          {
            id: 'project-icon',
            name: 'ProjectIcon',
            source: 'src/renderer/components/ProjectIcon.tsx',
            width: 480,
            height: 220,
            Preview: S.ProjectIcons
          },
          {
            id: 'brand-mark',
            name: 'TermulMark',
            source: 'src/renderer/components/TermulMark.tsx',
            width: 420,
            height: 192,
            Preview: S.BrandMark
          }
        ]
      },
      {
        id: 'shell',
        title: 'Shell',
        entries: [
          {
            id: 'sidebar-rows',
            name: 'Sidebar project rows',
            source: 'src/renderer/components/sidebar/indicators.tsx',
            width: 320,
            height: 276,
            Preview: S.SidebarRows
          },
          {
            id: 'status-bar',
            name: 'Status bar anatomy',
            source: 'src/renderer/components/status-bar-hit.ts',
            width: 680,
            height: 272,
            Preview: S.StatusBarAnatomy
          }
        ]
      }
    ]
  }
]
