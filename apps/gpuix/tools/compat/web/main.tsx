/**
 * Web side of a compat fixture: the same `FixtureRoot` under react-dom with
 * the real stylesheet and theme. `?fixture=<name>` picks the target.
 */

import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/index.css'
import 'streamdown/styles.css'
import '@/index.css'
import { getAcpTransport } from '@/lib/acp-transport'
import { applyColorTheme } from '@/lib/themes/apply-color-theme'
import { DEFAULT_COLOR_THEME_ID } from '@/lib/themes/bundled-themes'
import { checkWebAuthGate } from '@/lib/web-auth-gate'
import { ensureClientIdentity } from '@/lib/web-client-identity'
import { FixtureRoot } from '../fixtures/dom'

applyColorTheme(DEFAULT_COLOR_THEME_ID)
ensureClientIdentity()
checkWebAuthGate()
void getAcpTransport().connect()
const name = new URLSearchParams(window.location.search).get('fixture') ?? 'statusbar'
const root = document.getElementById('root')
if (!root) throw new Error('no #root')
createRoot(root).render(<FixtureRoot name={name} />)
