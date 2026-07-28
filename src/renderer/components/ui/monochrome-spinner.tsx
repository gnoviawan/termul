import { GradientSpin, type GradientSpinProps } from 'gradient-spin'

const MONOCHROME_GRADIENT = [
  { color: '#d4d4d8', position: 0 },
  { color: '#71717a', position: 0.5 },
  { color: '#27272a', position: 1 }
]

type MonochromeSpinnerProps = Omit<GradientSpinProps, 'gradient'>

export function MonochromeSpinner(props: MonochromeSpinnerProps): React.JSX.Element {
  return <GradientSpin gradient={MONOCHROME_GRADIENT} {...props} />
}
