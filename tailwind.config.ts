import type { Config } from 'tailwindcss'
import tailwindcssAnimate from 'tailwindcss-animate'

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
        ring: 'oklch(var(--ring) / <alpha-value>)',
        background: 'oklch(var(--background) / <alpha-value>)',
        foreground: 'oklch(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'oklch(var(--primary) / <alpha-value>)',
          foreground: 'oklch(var(--primary-foreground) / <alpha-value>)'
        },
        secondary: {
          DEFAULT: 'oklch(var(--secondary) / <alpha-value>)',
          foreground: 'oklch(var(--secondary-foreground) / <alpha-value>)'
        },
        destructive: {
          DEFAULT: 'oklch(var(--destructive) / <alpha-value>)',
          foreground: 'oklch(var(--destructive-foreground) / <alpha-value>)'
        },
        success: {
          DEFAULT: 'oklch(var(--success) / <alpha-value>)',
          foreground: 'oklch(var(--success-foreground) / <alpha-value>)'
        },
        connection: {
          DEFAULT: 'oklch(var(--connection) / <alpha-value>)'
        },
        'diff-modified': 'oklch(var(--diff-modified) / <alpha-value>)',
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
          bar: 'oklch(var(--status-bar) / <alpha-value>)'
        },
        project: {
          blue: 'oklch(var(--project-blue) / <alpha-value>)',
          purple: 'oklch(var(--project-purple) / <alpha-value>)',
          green: 'oklch(var(--project-green) / <alpha-value>)',
          yellow: 'oklch(var(--project-yellow) / <alpha-value>)',
          red: 'oklch(var(--project-red) / <alpha-value>)',
          cyan: 'oklch(var(--project-cyan) / <alpha-value>)',
          pink: 'oklch(var(--project-pink) / <alpha-value>)',
          orange: 'oklch(var(--project-orange) / <alpha-value>)'
        }
      },
      fontSize: {
        // Sub-xs scale. Tailwind's default fontSize stops at `xs` (12px),
        // which forced ad-hoc `text-[Npx]` values for captions / badges /
        // micro-labels across the renderer. These three size-only tokens
        // fill that gap. Size-only (no [size, lineHeight] tuple) on purpose
        // so existing `leading-*` and inherited line-heights are preserved.
        '2xs': '0.6875rem', // 11px
        '3xs': '0.625rem', // 10px
        '4xs': '0.5625rem' // 9px
      },
      fontFamily: {
        // Variable Inter (bundled). Fall through to native UI fonts so we still
        // look right if the bundled font fails to load. Ubuntu/Cantarell are
        // the actual GNOME UI fonts on Linux.
        sans: [
          '"Inter Variable"',
          'Inter',
          '"SF Pro Text"',
          '"Segoe UI"',
          'Ubuntu',
          'Cantarell',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'sans-serif'
        ],
        mono: [
          '"JetBrains Mono Variable"',
          '"JetBrains Mono"',
          '"Cascadia Code"',
          '"SF Mono"',
          'Menlo',
          'Consolas',
          '"Ubuntu Mono"',
          '"DejaVu Sans Mono"',
          '"Liberation Mono"',
          'monospace'
        ]
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' }
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' }
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(-10px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(-10px)' },
          to: { opacity: '1', transform: 'translateX(0)' }
        },
        // Chat "agent is typing" dots: a gentle hop + scale, staggered per dot
        // via animation-delay at the call site.
        'typing-bounce': {
          '0%, 80%, 100%': { transform: 'translateY(0) scale(0.8)', opacity: '0.5' },
          '40%': { transform: 'translateY(-3px) scale(1)', opacity: '1' }
        },
        // Streaming caret: a steady blink while the agent is writing.
        'caret-blink': {
          '0%, 45%': { opacity: '1' },
          '50%, 95%': { opacity: '0' },
          '100%': { opacity: '1' }
        }
      },
      animation: {
        // Use custom ease-out token (cubic-bezier(0.23, 1, 0.32, 1)) so
        // these keyframe animations have the same character as the
        // tailwindcss-animate Radix overrides in index.css.
        'accordion-down': 'accordion-down 200ms cubic-bezier(0.23, 1, 0.32, 1)',
        'accordion-up': 'accordion-up 200ms cubic-bezier(0.23, 1, 0.32, 1)',
        'fade-in': 'fade-in 200ms cubic-bezier(0.23, 1, 0.32, 1)',
        'slide-in': 'slide-in 180ms cubic-bezier(0.23, 1, 0.32, 1)',
        'typing-bounce': 'typing-bounce 1s cubic-bezier(0.77, 0, 0.175, 1) infinite',
        'caret-blink': 'caret-blink 1s step-end infinite'
      },
      boxShadow: {
        'glow-blue': '0 0 15px oklch(0.625 0.187 259.7 / 0.3)',
        'glow-purple': '0 0 15px oklch(0.557 0.251 301.9 / 0.3)',
        'glow-green': '0 0 15px oklch(0.72 0.192 149.5 / 0.3)'
      }
    }
  },
  plugins: [tailwindcssAnimate]
} satisfies Config
