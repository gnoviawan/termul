import type { ColorThemeDefinition } from './types'

/** Light appearance twins (`{family}-light`). Syntax: opencode light + vscode fallback. */
export const BUNDLED_LIGHT_COLOR_THEMES: Record<string, ColorThemeDefinition> = {
  // syntax: VS Code Light+ fallback
  'termul-light': {
    id: 'termul-light',
    name: 'Termul Light',
    appearance: 'light',
    familyId: 'termul',
    dark: {
      palette: {
        neutral: '#ffffff',
        ink: '#1e1e1e',
        primary: '#0451a5',
        accent: '#811f3f',
        success: '#098658',
        warning: '#cd9731',
        error: '#cd3131',
        info: '#0598bc'
      },
      overrides: {
        'syntax-comment': '#008000',
        'syntax-keyword': '#0000ff',
        'syntax-string': '#a31515',
        'syntax-type': '#267f99',
        'syntax-constant': '#098658',
        'syntax-variable': '#001080',
        'syntax-property': '#001080',
        'syntax-function': '#795e26'
      }
    }
  },
  // syntax: opencode cursor light
  'cursor-light': {
    id: 'cursor-light',
    name: 'Cursor Light',
    appearance: 'light',
    familyId: 'cursor',
    dark: {
      palette: {
        neutral: '#fcfcfc',
        ink: '#141414',
        primary: '#6f9ba6',
        accent: '#6f9ba6',
        success: '#1f8a65',
        warning: '#db704b',
        error: '#cf2d56',
        info: '#3c7cab'
      },
      overrides: {
        'syntax-comment': '#141414ad',
        'syntax-keyword': '#b3003f',
        'syntax-string': '#9e94d5',
        'syntax-type': '#206595',
        'syntax-constant': '#b8448b',
        'syntax-function': '#db704b'
      }
    }
  },
  // syntax: opencode catppuccin latte
  'catppuccin-light': {
    id: 'catppuccin-light',
    name: 'Catppuccin Light',
    appearance: 'light',
    familyId: 'catppuccin',
    dark: {
      palette: {
        neutral: '#f5e0dc',
        ink: '#4c4f69',
        primary: '#7287fd',
        accent: '#d20f39',
        success: '#40a02b',
        warning: '#df8e1d',
        error: '#d20f39',
        info: '#04a5e5'
      },
      overrides: {
        'syntax-comment': '#6c7086',
        'syntax-keyword': '#8839ef',
        'syntax-string': '#40a02b',
        'syntax-primitive': '#1e66f5',
        'syntax-constant': '#ca6702',
        'syntax-type': '#df8e1d',
        'syntax-function': '#1e66f5'
      }
    }
  },
  // syntax: opencode dracula light
  'dracula-light': {
    id: 'dracula-light',
    name: 'Dracula Light',
    appearance: 'light',
    familyId: 'dracula',
    dark: {
      palette: {
        neutral: '#f8f8f2',
        ink: '#1f1f2f',
        primary: '#7c6bf5',
        accent: '#d16090',
        success: '#2fbf71',
        warning: '#f7a14d',
        error: '#d9536f',
        info: '#1d7fc5'
      },
      overrides: {
        'syntax-comment': '#7d7f97',
        'syntax-keyword': '#d16090',
        'syntax-string': '#596600',
        'syntax-primitive': '#2f8f57',
        'syntax-constant': '#7c6bf5',
        'syntax-property': '#1d7fc5',
        'syntax-function': '#2f8f57'
      }
    }
  },
  // syntax: opencode nord light
  'nord-light': {
    id: 'nord-light',
    name: 'Nord Light',
    appearance: 'light',
    familyId: 'nord',
    dark: {
      palette: {
        neutral: '#eceff4',
        ink: '#2e3440',
        primary: '#5e81ac',
        accent: '#bf616a',
        success: '#8fbcbb',
        warning: '#d08770',
        error: '#bf616a',
        info: '#81a1c1'
      },
      overrides: {
        'syntax-comment': '#6b7282',
        'syntax-keyword': '#5e81ac',
        'syntax-string': '#6f8758',
        'syntax-type': '#8fbcbb',
        'syntax-constant': '#8d6886'
      }
    }
  },
  // syntax: opencode gruvbox light
  'gruvbox-light': {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    appearance: 'light',
    familyId: 'gruvbox',
    dark: {
      palette: {
        neutral: '#fbf1c7',
        ink: '#3c3836',
        primary: '#076678',
        accent: '#9d0006',
        success: '#79740e',
        warning: '#b57614',
        error: '#9d0006',
        info: '#8f3f71'
      },
      overrides: {
        'syntax-comment': '#928374',
        'syntax-keyword': '#9d0006',
        'syntax-string': '#79740e',
        'syntax-type': '#b57614',
        'syntax-constant': '#8f3f71',
        'syntax-function': '#076678'
      }
    }
  },
  // syntax: opencode tokyonight light
  'tokyonight-light': {
    id: 'tokyonight-light',
    name: 'Tokyo Night Light',
    appearance: 'light',
    familyId: 'tokyonight',
    dark: {
      palette: {
        neutral: '#e1e2e7',
        ink: '#273153',
        primary: '#2e7de9',
        accent: '#b15c00',
        success: '#587539',
        warning: '#8c6c3e',
        error: '#c94060',
        info: '#007197'
      },
      overrides: {
        'syntax-comment': '#6b6f7a',
        'syntax-keyword': '#9854f1',
        'syntax-string': '#587539',
        'syntax-type': '#007197',
        'syntax-constant': '#b15c00',
        'syntax-property': '#007197',
        'syntax-function': '#2e7de9'
      }
    }
  },
  // syntax: opencode ayu light
  'ayu-light': {
    id: 'ayu-light',
    name: 'Ayu Light',
    appearance: 'light',
    familyId: 'ayu',
    dark: {
      palette: {
        neutral: '#fdfaf4',
        ink: '#4f5964',
        primary: '#4aa8c8',
        accent: '#ef7d71',
        success: '#5fb978',
        warning: '#ea9f41',
        error: '#e6656a',
        info: '#2f9bce'
      },
      overrides: {
        'syntax-comment': '#6e7681',
        'syntax-keyword': '#c76a1a',
        'syntax-string': '#6f8f00',
        'syntax-type': '#227fc0',
        'syntax-constant': '#a37acc',
        'syntax-property': '#2f86b7',
        'syntax-function': '#b87500'
      }
    }
  },
  // syntax: opencode one-dark light
  'one-dark-light': {
    id: 'one-dark-light',
    name: 'One Dark Light',
    appearance: 'light',
    familyId: 'one-dark',
    dark: {
      palette: {
        neutral: '#fafafa',
        ink: '#383a42',
        primary: '#4078f2',
        accent: '#0184bc',
        success: '#50a14f',
        warning: '#c18401',
        error: '#e45649',
        info: '#986801'
      },
      overrides: {
        'syntax-comment': '#a0a1a7',
        'syntax-keyword': '#a626a4',
        'syntax-string': '#50a14f',
        'syntax-type': '#c18401',
        'syntax-constant': '#986801',
        'syntax-variable': '#e45649',
        'syntax-property': '#0184bc',
        'syntax-function': '#4078f2'
      }
    }
  },
  // syntax: opencode github light
  'github-light': {
    id: 'github-light',
    name: 'GitHub Light',
    appearance: 'light',
    familyId: 'github',
    dark: {
      palette: {
        neutral: '#ffffff',
        ink: '#24292f',
        primary: '#0969da',
        accent: '#1b7c83',
        success: '#1a7f37',
        warning: '#9a6700',
        error: '#cf222e',
        info: '#bc4c00'
      },
      overrides: {
        'syntax-comment': '#57606a',
        'syntax-keyword': '#cf222e',
        'syntax-string': '#0969da',
        'syntax-type': '#bc4c00',
        'syntax-constant': '#1b7c83',
        'syntax-variable': '#bc4c00',
        'syntax-property': '#1b7c83',
        'syntax-function': '#8250df'
      }
    }
  }
}
