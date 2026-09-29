import { GradientSpin, type GradientSpinProps } from 'gradient-spin'
import { type JSX, useEffect, useState } from 'react'
import { COLOR_THEME_CHANGED_EVENT } from '@/lib/themes'
import { readCssTokenHex } from '@/lib/themes/read-css-token'

type GradientStop = { color: string; position: number }

/** :root fallbacks from index.css — used before applyColorTheme runs. */
const FALLBACK_FOREGROUND = '0.925 0 0'
const FALLBACK_MUTED_FOREGROUND = '0.64 0 0'
const FALLBACK_BACKGROUND = '0.182 0 0'

export function readMonochromeGradient(): GradientStop[] {
  return [
    { color: readCssTokenHex('--foreground', FALLBACK_FOREGROUND), position: 0 },
    { color: readCssTokenHex('--muted-foreground', FALLBACK_MUTED_FOREGROUND), position: 0.5 },
    { color: readCssTokenHex('--background', FALLBACK_BACKGROUND), position: 1 }
  ]
}

type MonochromeSpinnerProps = Omit<GradientSpinProps, 'gradient'>

export function MonochromeSpinner(props: MonochromeSpinnerProps): JSX.Element {
  const [gradient, setGradient] = useState(readMonochromeGradient)

  useEffect(() => {
    const sync = (): void => {
      setGradient(readMonochromeGradient())
    }
    window.addEventListener(COLOR_THEME_CHANGED_EVENT, sync)
    return () => {
      window.removeEventListener(COLOR_THEME_CHANGED_EVENT, sync)
    }
  }, [])

  return <GradientSpin gradient={gradient} {...props} />
}
