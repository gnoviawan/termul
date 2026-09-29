# In-Chat Agent Switch

Termul lets you move a running Agent chat to a different agent mid-conversation,
with a summarized context handoff, without leaving the chat tab.

You pick the agent once at launch today. When you outgrow that choice — the
agent lacks a capability you now need, or a stronger model lives elsewhere —
switching in place keeps the conversation, the tab, and the workspace context.

## How it works

1. Open the **agent control** in the chat composer's chip row (the agent pill,
   left-most in the right cluster). It lists the same selectable entries as the
   launcher — icon, name, status — minus the chat's current agent.
2. Pick an entry:
   - **Ready** entries arm the switch. The pill shows the armed target
     (→ *name*) with a cancel affordance.
   - **Install-required** entries install inline (the same host-owned,
     verified-atomic install the launcher uses) and arm once ready.
   - **Manual-install** / **unavailable** entries are disabled with their
     reason.
3. Type your next message and send. That send executes the switch: the draft
   becomes the first prompt the new agent receives, alongside the handoff
   summary built from the transcript so far.

An armed switch does nothing until you send. Cancel it (the ✕ on the pill) to
stay with the current agent; closing the picker without picking cancels
nothing.

## What happens on the wire

The new agent gets a fresh session whose first prompt carries a structured
handoff: a summary derived from the old transcript (user and agent text, tool
calls referenced compactly, the prior agent named) followed by your draft. The
summary is not a verbatim transcript replay — it is bounded by the live
transcript window. The user bubble in the chat shows only your prompt; the
summary travels on the wire.

## What you see

- A borderless separator row at the switch point: `(old-agent icon) →
  (new-agent icon)`, no divider chrome.
- Beneath it, the handoff summary renders as a collapsible section, visible by
  default. Collapse is ephemeral UI state; reopening the chat resets it to
  expanded.
- The pre-switch transcript stays above the separator, rendered normally.
- The conversation continues in the same tab (same pane, same focus).
- The sidebar row for the chat shows the ordered agent icon sequence
  (original → current) instead of a single icon.

## Busy behavior

While the chat is busy — a turn is streaming, prompts are queued, a permission
or question is pending, or the agent is waiting on a sign-in — the control
presents an explicit choice instead of a silent block:

- **Wait** for the turn to finish (close the popover; nothing changes).
- **Cancel-then-switch** (offered only when cancelling a live turn actually
  clears the gate): the turn is cancelled, the arm proceeds once the turn
  clears.

Queued prompts, pending permissions/questions, history replay, and sign-in
states are wait-only — cancelling the turn would not clear them, so no
cancel-then-switch is offered there.

## The old agent

The old agent is retired, not killed mid-flight. After a switch:

- The old session is closed and its process detached from the project's
  reuse key. The idle reaper stops the process once it is idle and no chat
  tab still shows its sessions — a running turn or an open tab keeps it up.
- No further old-agent output lands in the chat after the separator.

If a switch fails (spawn error, new-session error), the chat stays on the
original agent, live and usable, with the failure surfaced on the session's
banner.

## Reopen behavior

The switch marker is a durable transcript record on both the desktop history
store and the standalone server persistence. Reopening a switched chat — from
the sidebar, history, or an app restart, on desktop or web — reconnects with
the agent the conversation ended with:

- Resolution follows the **last** switch record's target session and agent,
  walking a multi-switch chain (A → B → C reopens on C) so the whole chain's
  transcript renders above the separator.
- The pre-switch transcript remains visible above the separator; new prompts
  go to the current agent.
- Unswitched chats reopen exactly as before — no switch machinery runs.
- A corrupt or missing marker degrades to the original reopen path: the old
  transcript stays readable, nothing crashes.

## Both surfaces

The flow works identically on the Tauri desktop app and the web client over
`termul-server`: the picker, separator, and marker persistence are shared
renderer + host code, and the durable record type is implemented on both the
IPC command and the WS route side.
