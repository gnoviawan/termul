import { describe, expect, it } from 'vitest'
import {
  ACP_REFERENCE_KEYS,
  collectAcpReference,
  docTableNames,
  readApiContracts
} from './acp-reference'

describe('docs/api-contracts.md ACP reference', () => {
  const reference = collectAcpReference()
  const doc = readApiContracts()

  it('finds the commands, requests, events and routes the code defines', () => {
    expect(reference['tauri-commands']).toContain('acp_history_get_tail')
    expect(reference['ws-requests']).toContain('send_prompt')
    expect(reference['acp-events']).toContain('acp:prompt_complete')
    expect(reference['acp-events']).toContain('acp:browser_ticket_closed')
    expect(reference['relay-frames']).toEqual(['auth_required', 'gap', 'heartbeat'])
    expect(reference['http-routes']).toContain('/acp/install')
  })

  it.each(ACP_REFERENCE_KEYS)('lists exactly the code names in the %s table', (key) => {
    const documented = docTableNames(doc, key)
    const inCode = reference[key]
    expect({
      missingFromDoc: inCode.filter((name) => !documented.includes(name)),
      notInCode: documented.filter((name) => !inCode.includes(name))
    }).toEqual({ missingFromDoc: [], notInCode: [] })
  })
})
