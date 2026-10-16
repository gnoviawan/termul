# ADR-0004: Claude accounts use linked config directories

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-10-13 |
| Author | faizintifada |

## Context

Users have more than one Claude subscription, for example a personal account
and a work account. Each Project uses one Account (see `CONTEXT.md`,
"Providers & accounts"). When an Account reaches its limit, the user can
switch the Project to another Account, and the open Agent chats must continue
with the conversation intact.

Claude Code keys all of its state to one config directory (`~/.claude` by
default, or `CLAUDE_CONFIG_DIR`):

- the login (macOS Keychain entry `Claude Code-credentials`, or
  `Claude Code-credentials-<hash>` for a custom directory; `.credentials.json`
  on Linux and Windows),
- `.claude.json` (account identity, user-scope MCP servers, project trust),
- `settings.json`, skills, plugins, rules, `CLAUDE.md`,
- session transcripts in `projects/<project>/<session-id>.jsonl`.

The Claude ACP adapter resumes a session from the transcript in its config
directory. A session that another config directory wrote is not visible.

## Decision

Each Account gets its own config directory, and Termul starts the Claude
agent for that Account with `CLAUDE_CONFIG_DIR` set to it. The Default
Account uses `~/.claude` itself.

The shared parts of the account directory are symbolic links to `~/.claude`:
`projects`, `settings.json`, `skills`, `plugins`, `rules`, `plans`,
`file-history`, `agents`, `commands`, and `CLAUDE.md`. The login and
`.claude.json` stay per Account.

Termul never refreshes or writes Claude OAuth tokens. Claude Code owns them.

## Spike results

Measured on 2026-10-13 with Claude Code 2.1.296 on macOS, with two accounts
in different organizations (a Max account in `~/.claude` and a Team account in
a linked directory):

| Check | Result |
|-------|--------|
| A linked directory has its own login | Yes. It has a separate Keychain entry; the default login does not change. |
| Claude Code writes `settings.json` through the link | Yes. `claude plugin disable/enable --scope user` changed the target file and the link stayed. |
| Skills and plugins load through the links | Yes. Plugins that claude.ai syncs stay per Account (expected). |
| Account B resumes a session that account A created | Yes. Same session id, no error, the conversation is kept. The transcript had a signed thinking block. |
| Account A continues the session after account B | Yes. |
| Prompt cache after a switch | Partly lost. The first resumed turn wrote 19,848 tokens to the cache and read 10,584. |

During the spike, a refresh of the default login failed ("OAuth session
expired and could not be refreshed") while `claude auth status` still
reported `loggedIn: true`. Claude Code then removed the login. The cause is
not known; another process that refreshed the same token is likely.

## Consequences

**Positive**

- An Account switch is a real resume of the same Claude session. A text
  handoff is only the fallback.
- Settings, skills, plugins, and history are the same on every Account.
- Login stays the normal `claude auth login` browser flow; no token is pasted
  or stored by Termul.

**Negative**

- User-scope MCP servers in `.claude.json` are per Account. Termul Global MCP
  (sent in ACP `session/new`) covers this.
- The first turn after a switch costs more usage because the prompt cache is
  rebuilt. The switch prompt must tell the user.
- Links depend on Claude Code following symbolic links. Windows needs a
  separate check (directory junctions, and file links that may need Developer
  Mode).
- `auth status` does not prove that a login works. Termul must check an
  Account with a real request before it suggests that Account, and show
  "Sign in again" when the login is gone.

**Alternatives considered**

- *One `CLAUDE_CODE_OAUTH_TOKEN` per Account with one shared `~/.claude`*:
  everything stays shared, but the user must paste a one-year token, claude.ai
  connectors do not work, and the token scope probably does not allow the
  usage endpoint.
- *One unlinked config directory per Account* (monocode, t3code): simple, but
  history, skills, settings, and MCP servers are separate, so a switch cannot
  resume the session.
- *Swap the credentials in the default Keychain entry*: one directory, but
  Termul would have to write Claude Code's credentials and race its token
  refresh.

## Validation note

Spike scripts were run by hand in `~/.termul-spike/` (not committed). Termul
code was not changed for this decision.
