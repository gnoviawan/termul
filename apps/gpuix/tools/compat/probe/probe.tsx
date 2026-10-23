import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { registerTermulFonts } from '../../../src/style/fonts'

const SANS = 'Inter Variable'
const W = '#e6e6e6'

function Probe() {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    registerTermulFonts(renderer)
    setReady(true)
  }, [renderer])
  if (!ready) return null
  return (
    <div testId="probe" style={{ width: 1280, height: 800, backgroundColor: '#111', padding: 16, display: 'flex', flexDirection: 'column', gap: 10, fontFamily: SANS }}>
      <div style={{ color: '#ff6666', fontSize: 20 }}>A div-inherit: Hello {'world'} again</div>
      <text style={{ color: W, fontSize: 16 }}>B text-multi: Hello {'world'} again</text>
      <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', color: W, fontSize: 16 }}>
        C row: Plain <text style={{ fontWeight: 700 }}>Bold</text> tail
      </div>
      <div style={{ display: 'flex', gap: 12, color: W, fontSize: 18 }}>
        <text style={{ fontWeight: 400 }}>D w400</text>
        <text style={{ fontWeight: 500 }}>w500</text>
        <text style={{ fontWeight: 600 }}>w600</text>
        <text style={{ fontWeight: 700 }}>w700</text>
        <text style={{ fontWeight: 'bold' as never }}>bold-str</text>
      </div>
      <div style={{ width: 320, borderWidth: 1, borderColor: '#444' }}>
        <markdown
          source={'E md: Done. I renamed **StatusItem** and kept the `project-name` tooltip, plus a long tail that must wrap.'}
          style={{ color: W, fontSize: 14, fontFamily: SANS, lineHeight: 20 }}
        />
      </div>
      <div style={{ width: 320, borderWidth: 1, borderColor: '#444' }}>
        <markdown source={'- bullet one\n- bullet **two**'} style={{ color: W, fontSize: 14, fontFamily: SANS }} />
      </div>
      <div style={{ color: W, fontSize: 16 }}>
        <text>F block-children-1</text>
        <text>F block-children-2</text>
      </div>
      <div style={{ display: 'flex', color: W }}>
        <div style={{ flexGrow: 1, display: 'flex', justifyContent: 'flex-end', backgroundColor: '#222' }}>
          <text>G pushed right</text>
        </div>
      </div>
      <div
        style={{ color: W, width: 200, height: 30, backgroundColor: '#233' }}
        onLayout={(e) => console.log(`layout ${JSON.stringify({ x: e.x, y: e.y, w: e.width, h: e.height })}`)}
      >
        <text>H onLayout</text>
      </div>
    </div>
  )
}

render(<Probe />, { title: 'probe', width: 1280, height: 800, focus: false })
