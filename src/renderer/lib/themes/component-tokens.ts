/**
 * Per-theme component tokens. Each value is a complete CSS value (a color or
 * a shadow list), read as `var(--token)`. The defaults restate what the
 * components drew before these tokens existed, so a theme that sets nothing
 * renders exactly as it did. Termul themes override them through
 * `ThemeChrome.tokens`.
 */
export const COMPONENT_TOKEN_DEFAULTS = {
  /** Primary button fill on hover. */
  '--primary-fill-hover': 'color-mix(in oklch, oklch(var(--primary-fill)) 85%, black)',
  /** Primary button fill while pressed. */
  '--primary-fill-active': 'var(--primary-fill-hover)',
  /** Primary button depth at rest. */
  '--shadow-emboss':
    '0 1px 2px oklch(0 0 0 / 0.22), 0 4px 8px oklch(0 0 0 / 0.16), inset 0 1px 0 oklch(1 0 0 / 0.28), inset 0 -1px 1px oklch(0 0 0 / 0.16)',
  /** Primary button depth on hover and press. */
  '--shadow-emboss-hover':
    '0 1px 2px oklch(0 0 0 / 0.26), 0 5px 10px oklch(0 0 0 / 0.2), inset 0 1px 0 oklch(1 0 0 / 0.34), inset 0 -1px 1px oklch(0 0 0 / 0.2)',
  '--switch-track-on': 'oklch(var(--foreground))',
  '--switch-track-on-hover': 'var(--switch-track-on)',
  '--switch-track-on-active': 'var(--switch-track-on-hover)',
  '--switch-track-off': 'oklch(var(--input))',
  '--switch-track-off-hover': 'var(--switch-track-off)',
  '--switch-track-off-active': 'var(--switch-track-off-hover)',
  '--switch-track-on-disabled': 'var(--switch-track-on)',
  '--switch-track-off-disabled': 'var(--switch-track-off)',
  '--switch-thumb-on': 'oklch(var(--background))',
  '--switch-thumb-off': 'oklch(var(--muted-foreground))',
  '--switch-thumb-on-disabled': 'var(--switch-thumb-on)',
  '--switch-thumb-off-disabled': 'var(--switch-thumb-off)',
  '--switch-thumb-shadow': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  /** Whole-control opacity when disabled. */
  '--switch-disabled-opacity': '0.5',
  /** Loading placeholder block. */
  '--skeleton': 'oklch(var(--muted))',
  /** Ghost and outline button text on the hover wash. */
  '--ghost-hover-foreground': 'oklch(var(--accent-foreground))',
  /** Elevation ladder behind Tailwind's `shadow-*` scale. */
  '--elevation-2xs': '0 1px rgb(0 0 0 / 0.05)',
  '--elevation-xs': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  '--elevation-sm': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  '--elevation-md': '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  '--elevation-lg': '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  '--elevation-xl': '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  '--elevation-2xl': '0 25px 50px -12px rgb(0 0 0 / 0.25)',
  // Floating chat chrome that used one-off shadows tuned for dark canvases.
  /** Subagent pill. */
  '--elevation-pill': '0 4px 16px oklch(0 0 0 / 0.4)',
  /** Question panel that replaces the composer. */
  '--elevation-panel': '0 12px 32px oklch(0 0 0 / 0.45)',
  /** Subagent pill menu. */
  '--elevation-menu': '0 12px 32px oklch(0 0 0 / 0.6)',
  /**
   * Chat composer card at rest. Flat by default; its border separates it.
   * Never `none`: Tailwind joins shadow-* and ring-* into one box-shadow list,
   * where `none` is invalid and drops the focus ring.
   */
  '--composer-shadow': '0 0 #0000',
  /**
   * Prompt panels that replace the composer (AskUserQuestion, ElicitationPrompt).
   * Defaults to the panel elevation; a theme can tie it to the composer's lift.
   */
  '--prompt-panel-shadow': 'var(--elevation-panel)',
  /** Raised "you are here" fill (active tab, row, segment), read by .keycap. */
  '--keycap-fill': 'oklch(var(--muted))',
  /** Raised "you are here" depth, read by .keycap and the Rail keycap default. */
  '--keycap-shadow': 'inset 0 1px 0 oklch(var(--ring) / 0.08), 0 1px 2px #00000040',
  /** Rail keycap fill (active row on the sidebar). Defaults to the computed --rail-keycap. */
  '--rail-keycap-fill': 'var(--rail-keycap)',
  /** Rail keycap depth. Defaults to the shared keycap shadow. */
  '--rail-keycap-shadow': 'var(--keycap-shadow)',
  /**
   * Keyboard focus color, read by `ring-focus-ring` and `border-focus-ring`
   * (panel-styles.ts). Defaults to `--ring`, the theme ink, which clears 3:1
   * on every surface it sits on.
   */
  '--focus-ring': 'oklch(var(--ring))'
} as const

export type ComponentToken = keyof typeof COMPONENT_TOKEN_DEFAULTS
export type ThemeComponentTokens = Partial<Record<ComponentToken, string>>

/** Defaults with the theme's overrides on top. */
export function componentTokenVars(overrides?: ThemeComponentTokens): Record<string, string> {
  return { ...COMPONENT_TOKEN_DEFAULTS, ...overrides }
}
