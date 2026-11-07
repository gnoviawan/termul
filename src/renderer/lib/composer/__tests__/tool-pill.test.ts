import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import { ConversationPill } from '@/components/chat/composer/ConversationPillNode'
import { ToolPill } from '@/components/chat/composer/ToolPillNode'
import { buildComposerSend } from '@/components/chat/composer-send-blocks'
import { deriveTitle } from '@/lib/acp-history-persistence'
import { docToDisplayText, TOOL_PILL_NODE } from '@/lib/composer/doc-to-prompt'
import { draftFromTokens } from '@/lib/composer/draft-from-tokens'
import { hasToolTokens, parseToolSegments, toolToken } from '@/lib/composer/tool-tokens'
import { composerWireText } from '@/lib/composer/wire-text'
import {
  conversationToken,
  isComposerTriggerBoundary,
  sanitizeDisplayText
} from '@/lib/skill-tokens'
import { wireBlocksToDisplay } from '@/lib/skills-wire-reverse'

const schema = getSchema([StarterKit, ConversationPill, ToolPill])
const roundTrip = (value: string): string =>
  docToDisplayText(schema.nodeFromJSON(draftFromTokens(value)))

// The host titles chats from these literals; normalize_tests.rs pins the same strings.
const BROWSER_WIRE = '(Use the browser tool from the troupe MCP server)'

describe('Termul tool pill', () => {
  it('parses a tool token into a pill node carrying the tool id', () => {
    expect(draftFromTokens(`${toolToken('browser')} open localhost`)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: TOOL_PILL_NODE, attrs: { id: 'browser' } },
            { type: 'text', text: ' open localhost' }
          ]
        }
      ]
    })
  })

  it('round-trips tool pills next to other pills back to the same string', () => {
    const value = `${toolToken('canvas')} draw ${conversationToken('Login', 's-1')} with ${toolToken('automations')} `
    expect(roundTrip(value)).toBe(value)
  })

  it('sends agent-neutral wire text in place of each pill', () => {
    expect(
      composerWireText(`${toolToken('browser')} open localhost and ${toolToken('canvas')}`, [])
    ).toBe(`${BROWSER_WIRE} open localhost and (Use the canvas tools from the troupe MCP server)`)
    expect(composerWireText(`schedule it ${toolToken('automations')}`, [])).toBe(
      'schedule it (Use the automation tools from the troupe MCP server)'
    )
  })

  it('sends the wire text to the agent and keeps the pill for the timeline', () => {
    const value = `${toolToken('browser')} open localhost`
    const wire = composerWireText(value, [])
    const send = buildComposerSend(
      {
        skills: [],
        hasSkills: false,
        hasCommand: false,
        hasSelectionContexts: false,
        wireText: wire,
        displayText: value,
        wireWithCommand: wire,
        displayWithCommand: value,
        wireTrimmed: wire.trim(),
        displayTrimmed: value.trim(),
        fileBlocks: [],
        hasConversations: false,
        hasTools: true,
        contextBlocks: []
      },
      []
    )
    expect(send).toEqual({
      kind: 'blocks',
      wire: [{ type: 'text', text: `${BROWSER_WIRE} open localhost` }],
      display: [{ type: 'text', text: value }]
    })
  })

  it('titles a chat that opens with a tool pill by the tool label', () => {
    expect(
      deriveTitle(
        [
          {
            id: 'u1',
            role: 'user',
            blocks: [{ type: 'text', text: `${toolToken('browser')} open localhost` }],
            streaming: false,
            timestamp: 1
          }
        ],
        'Untitled'
      )
    ).toBe('Browser open localhost')
  })

  it('reads as the wire text in copies and previews', () => {
    expect(sanitizeDisplayText(`${toolToken('browser')} open localhost`)).toBe(
      `${BROWSER_WIRE} open localhost`
    )
  })

  it('turns the persisted wire text back into the pill when a chat reopens', () => {
    expect(wireBlocksToDisplay([{ type: 'text', text: `${BROWSER_WIRE} open localhost` }])).toEqual(
      [{ type: 'text', text: `${toolToken('browser')} open localhost` }]
    )
  })

  it('turns a 0.4.x prompt naming the termul server back into pills when a chat reopens', () => {
    expect(
      wireBlocksToDisplay([
        {
          type: 'text',
          text: '(Use the browser tool from the termul MCP server) open localhost and (Use the canvas tools from the termul MCP server)'
        }
      ])
    ).toEqual([{ type: 'text', text: '\uE00Cbrowser\uE00D open localhost and \uE00Ccanvas\uE00D' }])
  })

  it('keeps an unknown tool id as plain text without leaking a sentinel', () => {
    const value = '\uE00Cscreenshot\uE00D now'
    expect(composerWireText(value, [])).toBe('screenshot now')
    expect(roundTrip(value)).toBe('screenshot now')
  })

  it('keeps a valid pill after an unclosed start and strips every stray sentinel', () => {
    const value = `a\uE00Cbroken ${toolToken('browser')} b\uE00D c`
    expect(parseToolSegments(value)).toEqual([
      { kind: 'text', text: 'abroken ' },
      { kind: 'tool', tool: expect.objectContaining({ id: 'browser' }) },
      { kind: 'text', text: ' b c' }
    ])
    expect(composerWireText(`x\uE00D ${toolToken('canvas')}`, [])).toBe(
      'x (Use the canvas tools from the troupe MCP server)'
    )
  })

  it('counts only well-formed known tool pills as tools', () => {
    expect(hasToolTokens(`${toolToken('browser')} go`)).toBe(true)
    expect(hasToolTokens('\uE00Cscreenshot\uE00D now')).toBe(false)
    expect(hasToolTokens('\uE00Cbrowser')).toBe(false)
  })

  it('lets @ and / open right after a tool pill', () => {
    const value = `${toolToken('browser')}@`
    expect(isComposerTriggerBoundary(value, value.length - 1)).toBe(true)
  })
})
