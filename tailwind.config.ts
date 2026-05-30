import type { Config } from 'tailwindcss'
import tailwindcssAnimate from 'tailwindcss-animate'

export default {
  darkMode: ['class'],
  content: [
    './src/renderer/**/*.{ts,tsx}'
  ],
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
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
          foreground: 'hsl(var(--popover-foreground) / <alpha-value>)'
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)'
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background) / <alpha-value>)',
          foreground: 'hsl(var(--sidebar-foreground) / <alpha-value>)',
          primary: 'hsl(var(--sidebar-primary) / <alpha-value>)',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground) / <alpha-value>)',
          accent: 'hsl(var(--sidebar-accent) / <alpha-value>)',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground) / <alpha-value>)',
          border: 'hsl(var(--sidebar-border) / <alpha-value>)',
          ring: 'hsl(var(--sidebar-ring) / <alpha-value>)'
        },
        terminal: {
          bg: 'hsl(var(--terminal-bg) / <alpha-value>)',
          fg: 'hsl(var(--terminal-fg) / <alpha-value>)'
        },
        surface: {
          dark: 'hsl(var(--surface-dark) / <alpha-value>)',
          darker: 'hsl(var(--surface-darker) / <alpha-value>)'
        },
        status: {
          bar: 'hsl(var(--status-bar) / <alpha-value>)'
        },
        project: {
          blue: 'hsl(var(--project-blue) / <alpha-value>)',
          purple: 'hsl(var(--project-purple) / <alpha-value>)',
          green: 'hsl(var(--project-green) / <alpha-value>)',
          yellow: 'hsl(var(--project-yellow) / <alpha-value>)',
          red: 'hsl(var(--project-red) / <alpha-value>)',
          cyan: 'hsl(var(--project-cyan) / <alpha-value>)',
          pink: 'hsl(var(--project-pink) / <alpha-value>)',
          orange: 'hsl(var(--project-orange) / <alpha-value>)'
        }
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
        }
      },
      animation: {
        // Use custom ease-out token (cubic-bezier(0.23, 1, 0.32, 1)) so
        // these keyframe animations have the same character as the
        // tailwindcss-animate Radix overrides in index.css.
        'accordion-down': 'accordion-down 200ms cubic-bezier(0.23, 1, 0.32, 1)',
        'accordion-up': 'accordion-up 200ms cubic-bezier(0.23, 1, 0.32, 1)',
        'fade-in': 'fade-in 200ms cubic-bezier(0.23, 1, 0.32, 1)',
        'slide-in': 'slide-in 180ms cubic-bezier(0.23, 1, 0.32, 1)'
      },
      boxShadow: {
        'glow-blue': '0 0 15px hsla(217, 91%, 60%, 0.3)',
        'glow-purple': '0 0 15px hsla(271, 81%, 56%, 0.3)',
        'glow-green': '0 0 15px hsla(142, 71%, 45%, 0.3)'
      }
    }
  },
  plugins: [tailwindcssAnimate]
} satisfies Config
