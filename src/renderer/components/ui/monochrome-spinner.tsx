import { GradientSpin, type GradientSpinProps } from 'gradient-spin'
import { type JSX, useEffect, useState } from 'react'
import { COLOR_THEME_CHANGED_EVENT } from '@/lib/themes'
import { oklchComponentsToHex } from '@/lib/themes/color-utils'
import { readCssTokenComponents } from '@/lib/themes/read-css-token'

type GradientStop = { color: string; position: number }

/**
 * Same "L C H" values as `:root` in index.css. The spinner uses these when
 * the document has no token yet, so a missing stylesheet does not crash render.
 */
const FIRST_PAINT_COMPONENTS = {
  '--foreground': '0.909 0.008 260.7',
  '--muted-foreground': '0.652 0.008 260.7',
  '--background': '0.2 0.01 268.2'
} as const

type SpinnerToken = keyof typeof FIRST_PAINT_COMPONENTS

function spinnerStopColor(token: SpinnerToken): string {
  const components = readCssTokenComponents(token)
  return oklchComponentsToHex(components || FIRST_PAINT_COMPONENTS[token])
}

export function readMonochromeGradient(): GradientStop[] {
  return [
    { color: spinnerStopColor('--foreground'), position: 0 },
    { color: spinnerStopColor('--muted-foreground'), position: 0.5 },
    { color: spinnerStopColor('--background'), position: 1 }
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
