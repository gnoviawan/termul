# ADR-0005: Selection contexts are sent as leading quote blocks

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-10-26 |
| Author | julianromli |

## Context

The user can select text in any message of an Agent chat and add it to the
composer as a Selection context chip (see `CONTEXT.md`, "Agent chats"). The
agent must receive the selected text and know where each chip sits in the
user's sentence. Termul talks to every agent through ACP, and ACP has no
content block for "quoted conversation text", so the context must travel as
prompt text.

The wire text is persisted. The durable `user_prompt` record and replayed
user chunks store it, and a restored chat rebuilds chips from it
(`wireTextToDisplay`). The live/persisted twin check compares the restored
display text with the live one. A format change after release would show raw
quote blocks for older chats and break the twin check for them.

## Decision

Each chip is a display-string token `\uE008[<language>\u001F]<URI-encoded
text>\uE009` (private-use sentinels, like the skill, command, and file
pills). On send, `serializeSelectionContexts`
(`src/renderer/lib/composer/selection-context.ts`) produces:

````text
Context 1 (selected from the conversation):
> first quoted line
>
> third quoted line

Context 2 (selected from the conversation):
> ```ts
> const x = 1
> ```

Compare [Context 1] with [Context 2]
````

- One labeled quote block per chip, numbered by chip order, at the start of
  the prompt text. A leading slash command stays first.
- Each chip becomes `[Context N]` at its position. A marker the user typed is
  escaped with one more leading backslash.
- Skill framing (`# Agent Skills`) still wraps the whole user text.

`selectionContextsToDisplay` is the exact inverse. It returns the input
unchanged for any text that is not an exact match.

## Consequences

- Works for every ACP agent with no protocol change and no new content block.
- Restored chats show the same chips as the live chat, and the twin check
  keeps working, because the reverse is lossless for every serialized value
  (prose that is exactly one fenced block is stored as code to keep it so).
- The label text, the quote prefix, and the marker shape are now a persisted
  contract. A future change must keep a parser for this format.
- The selected text is sent inline, so a very long selection uses prompt
  tokens. There is no size limit in this version.
