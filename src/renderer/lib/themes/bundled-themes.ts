import { BUNDLED_LIGHT_COLOR_THEMES } from './bundled-light-themes'
import type { ColorThemeDefinition } from './types'

export interface ColorThemeFamily {
  familyId: string
  name: string
  darkThemeId: string
  lightThemeId: string
}

/** Built-in dark appearance themes (OpenCode palette-compatible). */
const BUNDLED_DARK_COLOR_THEMES: Record<string, ColorThemeDefinition> = {
  // syntax: VS Code Dark+ (Termul default editor)
  termul: {
    id: 'termul',
    name: 'Termul',
    appearance: 'dark',
    familyId: 'termul',
    dark: {
      palette: {
        neutral: '#121212',
        ink: '#e5e5e5',
        primary: '#3b82f6',
        accent: '#3b82f6',
        success: '#22c55e',
        warning: '#eab308',
        error: '#ef4444',
        info: '#38bdf8'
      },
      overrides: {
        'syntax-comment': '#6a9955',
        'syntax-keyword': '#c586c0',
        'syntax-string': '#ce9178',
        'syntax-type': '#4ec9b0',
        'syntax-constant': '#b5cea8',
        'syntax-variable': '#9cdcfe',
        'syntax-property': '#9cdcfe',
        'syntax-function': '#dcdcaa'
      }
    }
  },
  // syntax: opencode cursor + vscode fallback
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    appearance: 'dark',
    familyId: 'cursor',
    dark: {
      palette: {
        neutral: '#181818',
        ink: '#e4e4e4',
        primary: '#88c0d0',
        accent: '#f38ba8',
        success: '#3fa266',
        warning: '#f1b467',
        error: '#e34671',
        info: '#81a1c1'
      },
      overrides: {
        'syntax-comment': '#e4e4e45e',
        'syntax-keyword': '#82d2ce',
        'syntax-string': '#e394dc',
        'syntax-type': '#efb080',
        'syntax-constant': '#f8c762',
        'syntax-property': '#81a1c1',
        'syntax-function': '#efb080'
      }
    }
  },
  // syntax: opencode catppuccin mocha + vscode fallback
  catppuccin: {
    id: 'catppuccin',
    name: 'Catppuccin',
    appearance: 'dark',
    familyId: 'catppuccin',
    dark: {
      palette: {
        neutral: '#1e1e2e',
        ink: '#cdd6f4',
        primary: '#b4befe',
        accent: '#f38ba8',
        success: '#a6e3a1',
        warning: '#fab387',
        error: '#f38ba8',
        info: '#89dceb'
      },
      overrides: {
        'syntax-comment': '#6c7086',
        'syntax-keyword': '#cba6f7',
        'syntax-string': '#a6e3a1',
        'syntax-primitive': '#89b4fa',
        'syntax-constant': '#fab387',
        'syntax-type': '#f9e2af',
        'syntax-function': '#89b4fa'
      }
    }
  },
  // syntax: opencode dracula
  dracula: {
    id: 'dracula',
    name: 'Dracula',
    appearance: 'dark',
    familyId: 'dracula',
    dark: {
      palette: {
        neutral: '#1d1e28',
        ink: '#f8f8f2',
        primary: '#bd93f9',
        accent: '#ff79c6',
        success: '#50fa7b',
        warning: '#ffb86c',
        error: '#ff5555',
        info: '#8be9fd'
      },
      overrides: {
        'syntax-comment': '#6272a4',
        'syntax-keyword': '#ff79c6',
        'syntax-string': '#f1fa8c',
        'syntax-primitive': '#50fa7b',
        'syntax-constant': '#bd93f9',
        'syntax-property': '#8be9fd',
        'syntax-function': '#50fa7b'
      }
    }
  },
  // syntax: opencode nord + vscode fallback
  nord: {
    id: 'nord',
    name: 'Nord',
    appearance: 'dark',
    familyId: 'nord',
    dark: {
      palette: {
        neutral: '#2e3440',
        ink: '#eceff4',
        primary: '#88c0d0',
        accent: '#bf616a',
        success: '#a3be8c',
        warning: '#ebcb8b',
        error: '#bf616a',
        info: '#81a1c1'
      },
      overrides: {
        'syntax-comment': '#616e88',
        'syntax-keyword': '#81a1c1',
        'syntax-string': '#a3be8c',
        'syntax-type': '#8fbcbb',
        'syntax-constant': '#b48ead',
        'syntax-function': '#88c0d0'
      }
    }
  },
  // syntax: opencode gruvbox
  gruvbox: {
    id: 'gruvbox',
    name: 'Gruvbox',
    appearance: 'dark',
    familyId: 'gruvbox',
    dark: {
      palette: {
        neutral: '#282828',
        ink: '#ebdbb2',
        primary: '#83a598',
        accent: '#d3869b',
        success: '#b8bb26',
        warning: '#fabd2f',
        error: '#fb4934',
        info: '#8ec07c'
      },
      overrides: {
        'syntax-comment': '#928374',
        'syntax-keyword': '#fb4934',
        'syntax-string': '#b8bb26',
        'syntax-type': '#fabd2f',
        'syntax-constant': '#d3869b',
        'syntax-function': '#83a598'
      }
    }
  },
  // syntax: opencode tokyonight
  tokyonight: {
    id: 'tokyonight',
    name: 'Tokyo Night',
    appearance: 'dark',
    familyId: 'tokyonight',
    dark: {
      palette: {
        neutral: '#1a1b26',
        ink: '#c0caf5',
        primary: '#7aa2f7',
        accent: '#bb9af7',
        success: '#9ece6a',
        warning: '#e0af68',
        error: '#f7768e',
        info: '#7dcfff'
      },
      overrides: {
        'syntax-comment': '#565f89',
        'syntax-keyword': '#bb9af7',
        'syntax-string': '#9ece6a',
        'syntax-type': '#2ac3de',
        'syntax-constant': '#ff9e64',
        'syntax-property': '#7dcfff',
        'syntax-function': '#7aa2f7'
      }
    }
  },
  // syntax: opencode ayu dark
  ayu: {
    id: 'ayu',
    name: 'Ayu',
    appearance: 'dark',
    familyId: 'ayu',
    dark: {
      palette: {
        neutral: '#0b0e14',
        ink: '#bfbdb6',
        primary: '#39bae6',
        accent: '#ff8f40',
        success: '#7fd962',
        warning: '#ffb454',
        error: '#f26d78',
        info: '#59c2ff'
      },
      overrides: {
        'syntax-comment': '#5a6673',
        'syntax-keyword': '#ff8f40',
        'syntax-string': '#aad94c',
        'syntax-type': '#59c2ff',
        'syntax-constant': '#d2a6ff',
        'syntax-property': '#39bae6',
        'syntax-function': '#ffb454'
      }
    }
  },
  // syntax: opencode one-dark
  'one-dark': {
    id: 'one-dark',
    name: 'One Dark',
    appearance: 'dark',
    familyId: 'one-dark',
    dark: {
      palette: {
        neutral: '#282c34',
        ink: '#abb2bf',
        primary: '#61afef',
        accent: '#c678dd',
        success: '#98c379',
        warning: '#e5c07b',
        error: '#e06c75',
        info: '#56b6c2'
      },
      overrides: {
        'syntax-comment': '#5c6370',
        'syntax-keyword': '#c678dd',
        'syntax-string': '#98c379',
        'syntax-type': '#e5c07b',
        'syntax-constant': '#d19a66',
        'syntax-variable': '#e06c75',
        'syntax-property': '#56b6c2',
        'syntax-function': '#61afef'
      }
    }
  },
  // syntax: opencode github dark
  github: {
    id: 'github',
    name: 'GitHub',
    appearance: 'dark',
    familyId: 'github',
    dark: {
      palette: {
        neutral: '#0d1117',
        ink: '#c9d1d9',
        primary: '#58a6ff',
        accent: '#f78166',
        success: '#3fb950',
        warning: '#d29922',
        error: '#f85149',
        info: '#79c0ff'
      },
      overrides: {
        'syntax-comment': '#8b949e',
        'syntax-keyword': '#ff7b72',
        'syntax-string': '#39c5cf',
        'syntax-type': '#d29922',
        'syntax-constant': '#79c0ff',
        'syntax-variable': '#d29922',
        'syntax-property': '#39c5cf',
        'syntax-function': '#bc8cff'
      }
    }
  }
}

export const BUNDLED_COLOR_THEMES: Record<string, ColorThemeDefinition> = {
  ...BUNDLED_DARK_COLOR_THEMES,
  ...BUNDLED_LIGHT_COLOR_THEMES
}

export const COLOR_THEME_FAMILIES: ColorThemeFamily[] = Object.values(
  BUNDLED_DARK_COLOR_THEMES
).map((theme) => ({
  familyId: theme.familyId,
  name: theme.name.replace(/ Light$/, ''),
  darkThemeId: theme.id,
  lightThemeId: `${theme.familyId}-light`
}))

export interface ThemePickerRow {
  themeId: string
  familyId: string
  label: string
  variant: 'dark' | 'light'
}

export const THEME_PICKER_ROWS: ThemePickerRow[] = COLOR_THEME_FAMILIES.flatMap((family) => [
  {
    themeId: family.darkThemeId,
    familyId: family.familyId,
    label: family.name,
    variant: 'dark' as const
  },
  {
    themeId: family.lightThemeId,
    familyId: family.familyId,
    label: `${family.name} Light`,
    variant: 'light' as const
  }
])

export const DEFAULT_COLOR_THEME_ID = 'termul'

export const COLOR_THEME_LIST = Object.values(BUNDLED_COLOR_THEMES)

export function getColorThemeDefinition(themeId: string): ColorThemeDefinition {
  if (!Object.prototype.hasOwnProperty.call(BUNDLED_COLOR_THEMES, themeId)) {
    return BUNDLED_COLOR_THEMES[DEFAULT_COLOR_THEME_ID]
  }
  return BUNDLED_COLOR_THEMES[themeId]
}
