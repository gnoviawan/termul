import type { Config } from 'tailwindcss'
import tailwindcssAnimate from 'tailwindcss-animate'
import { MONO_FONT_FAMILY, SANS_FONT_FAMILY } from './src/renderer/lib/font-stacks'

export default {
  darkMode: 'class',
  content: ['./src/renderer/**/*.{ts,tsx}'],
  prefix: '',
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px'
      }
    },
    extend: {
      colors: {
        border: 'oklch(var(--border) / <alpha-value>)',
        input: 'oklch(var(--input) / <alpha-value>)',
        'field-border': 'oklch(var(--field-border) / <alpha-value>)',
        ring: 'oklch(var(--ring) / <alpha-value>)',
        // Complete CSS color (component token): no alpha modifier.
        'focus-ring': 'var(--focus-ring)',
        background: 'oklch(var(--background) / <alpha-value>)',
        foreground: 'oklch(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'oklch(var(--primary) / <alpha-value>)',
          fill: 'oklch(var(--primary-fill) / <alpha-value>)',
          // fill-hover and fill-active are complete CSS colors: an alpha modifier
          // such as bg-primary-fill-hover/50 is silently ignored.
          'fill-hover': 'var(--primary-fill-hover)',
          'fill-active': 'var(--primary-fill-active)',
          foreground: 'oklch(var(--primary-foreground) / <alpha-value>)'
        },
        secondary: {
          DEFAULT: 'oklch(var(--secondary) / <alpha-value>)',
          foreground: 'oklch(var(--secondary-foreground) / <alpha-value>)'
        },
        destructive: {
          DEFAULT: 'oklch(var(--destructive) / <alpha-value>)',
          fill: 'oklch(var(--destructive-fill) / <alpha-value>)',
          foreground: 'oklch(var(--destructive-foreground) / <alpha-value>)'
        },
        success: {
          DEFAULT: 'oklch(var(--success) / <alpha-value>)',
          fill: 'oklch(var(--success-fill) / <alpha-value>)',
          foreground: 'oklch(var(--success-foreground) / <alpha-value>)'
        },
        connection: {
          DEFAULT: 'oklch(var(--connection) / <alpha-value>)'
        },
        // Component tokens are complete CSS colors: an alpha modifier such as
        // bg-skeleton/50 is silently ignored, with no build error.
        skeleton: 'var(--skeleton)',
        'ghost-hover-foreground': 'var(--ghost-hover-foreground)',
        'diff-modified': 'oklch(var(--diff-modified) / <alpha-value>)',
        'diff-added': 'oklch(var(--diff-added) / <alpha-value>)',
        overlay: 'oklch(var(--overlay) / <alpha-value>)',
        'row-hover': 'var(--row-hover)',
        'row-hover-solid': 'var(--row-hover-solid)',
        warning: {
          DEFAULT: 'oklch(var(--warning) / <alpha-value>)',
          foreground: 'oklch(var(--warning-foreground) / <alpha-value>)'
        },
        muted: {
          DEFAULT: 'oklch(var(--muted) / <alpha-value>)',
          foreground: 'oklch(var(--muted-foreground) / <alpha-value>)'
        },
        disabled: {
          foreground: 'oklch(var(--disabled-foreground) / <alpha-value>)'
        },
        accent: {
          DEFAULT: 'oklch(var(--accent) / <alpha-value>)',
          foreground: 'oklch(var(--accent-foreground) / <alpha-value>)'
        },
        popover: {
          DEFAULT: 'oklch(var(--popover) / <alpha-value>)',
          foreground: 'oklch(var(--popover-foreground) / <alpha-value>)'
        },
        card: {
          DEFAULT: 'oklch(var(--card) / <alpha-value>)',
          foreground: 'oklch(var(--card-foreground) / <alpha-value>)'
        },
        sidebar: {
          DEFAULT: 'oklch(var(--sidebar-background) / <alpha-value>)',
          foreground: 'oklch(var(--sidebar-foreground) / <alpha-value>)',
          primary: 'oklch(var(--sidebar-primary) / <alpha-value>)',
          'primary-foreground': 'oklch(var(--sidebar-primary-foreground) / <alpha-value>)',
          accent: 'oklch(var(--sidebar-accent) / <alpha-value>)',
          'accent-foreground': 'oklch(var(--sidebar-accent-foreground) / <alpha-value>)',
          border: 'oklch(var(--sidebar-border) / <alpha-value>)',
          ring: 'oklch(var(--sidebar-ring) / <alpha-value>)'
        },
        terminal: {
          bg: 'oklch(var(--terminal-bg) / <alpha-value>)',
          fg: 'oklch(var(--terminal-fg) / <alpha-value>)'
        },
        surface: {
          dark: 'oklch(var(--surface-dark) / <alpha-value>)',
          darker: 'oklch(var(--surface-darker) / <alpha-value>)'
        },
        status: {
          bar: 'oklch(var(--status-bar) / <alpha-value>)',
          'bar-blue': 'oklch(var(--status-bar-blue) / <alpha-value>)',
          'bar-purple': 'oklch(var(--status-bar-purple) / <alpha-value>)',
          'bar-green': 'oklch(var(--status-bar-green) / <alpha-value>)',
          'bar-yellow': 'oklch(var(--status-bar-yellow) / <alpha-value>)',
          'bar-red': 'oklch(var(--status-bar-red) / <alpha-value>)',
          'bar-cyan': 'oklch(var(--status-bar-cyan) / <alpha-value>)',
          'bar-pink': 'oklch(var(--status-bar-pink) / <alpha-value>)',
          'bar-orange': 'oklch(var(--status-bar-orange) / <alpha-value>)',
          'bar-gray': 'oklch(var(--status-bar-gray) / <alpha-value>)'
        },
        project: {
          blue: 'oklch(var(--project-blue) / <alpha-value>)',
          purple: 'oklch(var(--project-purple) / <alpha-value>)',
          green: 'oklch(var(--project-green) / <alpha-value>)',
          yellow: 'oklch(var(--project-yellow) / <alpha-value>)',
          red: 'oklch(var(--project-red) / <alpha-value>)',
          cyan: 'oklch(var(--project-cyan) / <alpha-value>)',
          pink: 'oklch(var(--project-pink) / <alpha-value>)',
          orange: 'oklch(var(--project-orange) / <alpha-value>)',
          gray: 'oklch(var(--project-gray) / <alpha-value>)'
        }
      },
      fontSize: {
        // 12px floor for dense chrome (badges, chips, path labels). Three role
        // names share one size so existing call sites stay put. Size-only
        // (no [size, lineHeight] tuple) so existing `leading-*` still wins.
        '2xs': '0.75rem', // 12px
        '3xs': '0.75rem', // 12px
        '4xs': '0.75rem' // 12px
      },
      fontFamily: {
        sans: [...SANS_FONT_FAMILY],
        mono: [...MONO_FONT_FAMILY]
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      },
      // Keyframes and `animate-*` live in src/renderer/index.css (@theme inline):
      // keyframes from this JS config reach PostCSS without a source file, which
      // makes Vite warn "A PostCSS plugin did not pass the `from` option".
      boxShadow: {
        // The scale reads the per-theme elevation ladder (component-tokens.ts).
        // Plain `shadow` matches Tailwind's default, which equals the sm step.
        // shadow-inner stays Tailwind's inset; the ladder has no inset step.
        DEFAULT: 'var(--elevation-sm)',
        '2xs': 'var(--elevation-2xs)',
        xs: 'var(--elevation-xs)',
        sm: 'var(--elevation-sm)',
        md: 'var(--elevation-md)',
        lg: 'var(--elevation-lg)',
        xl: 'var(--elevation-xl)',
        '2xl': 'var(--elevation-2xl)',
        pill: 'var(--elevation-pill)',
        panel: 'var(--elevation-panel)',
        menu: 'var(--elevation-menu)',
        composer: 'var(--composer-shadow)',
        'prompt-panel': 'var(--prompt-panel-shadow)',
        emboss: 'var(--shadow-emboss)',
        'emboss-hover': 'var(--shadow-emboss-hover)',
        // Alpha kept inline here (single place); the hue components come from
        // the per-theme --glow-* tokens emitted by applyColorTheme.
        'glow-blue': '0 0 15px oklch(var(--glow-blue) / 0.3)',
        'glow-purple': '0 0 15px oklch(var(--glow-purple) / 0.3)',
        'glow-green': '0 0 15px oklch(var(--glow-green) / 0.3)'
      }
    }
  },
  plugins: [tailwindcssAnimate]
} satisfies Config
