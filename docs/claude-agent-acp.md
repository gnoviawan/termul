# Claude Agent ACP

Termul launches the official Claude Agent ACP adapter using a host-managed,
version-pinned npm package. Termul does not install or update Anthropic's
separate Claude Code CLI.

## Prerequisites

- Node.js 22 or newer, with npm available on `PATH`.
- Claude Code CLI installed from Anthropic and available as `claude`.
- Either an existing Claude Code login or an Anthropic API key.

Termul checks Node's major version, npm, and the external CLI before install.
If Node is older than 22, upgrade it and restart Termul. If the CLI is missing,
install it using Anthropic's official instructions.

## Desktop setup

The desktop app uses the default Claude Code login. Sign in once from any
terminal:

```sh
claude auth login
```

Then start a Claude Agent chat and choose **Install** when prompted. Termul
installs the exact catalog version into its managed host cache.

The API-key method is available on headless hosts only (see below).

Claude Code login is the default. API keys are host-wide; the selected auth
mode is per state directory. API keys stay in the OS keychain; Termul never
displays a saved key or sends it to a browser client. The selected auth mode
is not a secret: it is stored as a plain file at `<state
dir>/claude-auth-mode` (beside `acp-registry-binaries` — the app-data dir on
desktop), so `claude-code` mode keeps working on hosts with no OS keychain.
Setting the mode writes this file and removes the legacy
`acp.claude-agent.auth-mode` keychain entry that older versions used.

When host status confirms a Claude Code login, Termul does not also invoke the
ACP adapter's separate sign-in methods before creating a session. This confirms
only that the CLI reports an active login, not that the adapter can use that
session. Anthropic's guidance restricts using Claude.ai subscription
authentication through third-party products unless Anthropic has approved it.
Confirm approval before using this mode; live ACP session creation with a
subscription login has not been verified. Use API-key mode if this integration
is not approved.

## Headless setup

API-key management is headless-only. Run these commands on the server host,
using the same state directory as the server process if it was configured with
`--state-dir`:

```sh
termul-server claude auth status
termul-server claude auth login
termul-server claude install
```

The API-key mode is optional. On bash or zsh, provide the key through a hidden
prompt and pipe it to Termul so it is not echoed or placed in command history:

```sh
read -s -r -p "Anthropic API key: " CLAUDE_API_KEY
printf '%s' "$CLAUDE_API_KEY" | termul-server claude api-key set
unset CLAUDE_API_KEY
termul-server claude auth mode api-key
```

To return to Claude Code login or remove the saved key:

```sh
termul-server claude auth mode claude-code
termul-server claude api-key delete
```

For an explicit state directory, pass `--state-dir PATH` after `claude`.
Auth-mode changes are written to `PATH/claude-auth-mode`; the API key stays
in the OS keychain.

## Claude accounts

In Claude Code login mode, a host can hold several Claude subscription logins
(Accounts). Each Project uses one Account; a Project with no choice uses the
Default Account. The built-in Account uses the host's normal Claude config
folder (`~/.claude`, or `CLAUDE_CONFIG_DIR` when the host sets it). See
[ADR-0004](./adr/0004-claude-accounts-linked-config-dirs.md).

Every other Account has its own folder at `<state dir>/claude-accounts/<id>`.
Termul starts the Claude agent of that Account with `CLAUDE_CONFIG_DIR` set to
it. The login and `.claude.json` stay in that folder; `projects`, `skills`,
`plugins`, `rules`, `plans`, `file-history`, `agents`, `commands`,
`settings.json` and `CLAUDE.md` are links back to the shared folder, so session
history, settings and skills are the same on every Account. Termul never reads
or refreshes the login tokens; Claude Code keeps them in its own credential
store. The Account list (`<state dir>/claude-accounts.json`) holds names and
ids only.

Headless hosts manage Accounts with:

```sh
termul-server claude account list
termul-server claude account add "Work"
termul-server claude account login <id>
termul-server claude account rename <id> "Office"
termul-server claude account default <id>
termul-server claude account project <project-id> <id>
termul-server claude account project <project-id> default
termul-server claude account remove <id>
```

### Account usage

Termul reads the usage windows of each Account (5-hour session, weekly, and
per-model weekly windows, with percent used and reset time) through the Claude
Agent SDK that ships with the managed Claude ACP package. It runs a short
`node` probe with the Account's `CLAUDE_CONFIG_DIR`, so Claude Code uses and
refreshes its own login; Termul never reads a token, and the probe prints only
the limits and the plan type. The probe asks only for plan limits
(`skipBehaviors`), writes no session file, and loads no MCP servers or user
settings. Reads are cached on the host for 5 minutes; a forced refresh reuses a
read younger than 60 seconds. An Account with no login reads as `signed_out`;
API-key mode reads as `unavailable`. The SDK usage call is experimental, so an
unknown reply shape yields no windows instead of an error.

During a turn, the Claude ACP adapter also attaches the live rate-limit state
(`allowed`, `allowed_warning`, or `rejected`, with reset time and percent) to
`usage_update` events. Termul forwards it as `rateLimit` on `acp:usage_update`.

`remove` signs the Claude CLI out of that Account, deletes its folder (never
the shared folder), and moves its Projects back to the Default Account. The
built-in Account cannot be removed. On Windows, a link that cannot be created
(file links can need Developer Mode) is logged and left out; that entry is then
separate for the Account.

## Remote browser clients

Authenticated remote users can launch Claude ACP through the host and use the
host's configured credential. Credential status and management remain local to
the server host's CLI. There are no HTTP or WS routes for reading or changing
Claude credentials. A remote client can list the Accounts (names, ids, and
signed-in state) and their usage, and choose the Default or a Project Account
(`list_claude_accounts`, `list_claude_usage`, `set_default_claude_account`,
`set_project_claude_account`); view-only connections can only list. Adding,
signing in, renaming and removing an Account stay on the host.

## Per-project Claude profiles

The agent process and the `claude auth status` preflight both run with the
project's environment variables (Project Settings → Environment Variables)
underneath the agent config's own env. Set `CLAUDE_CONFIG_DIR` on a project to
pin its agent chats, like its terminal tabs, to one Claude Code login.
Changing a project's env replaces its warm agent on the next chat.

## Startup failures

- **Node.js 22 or newer required:** upgrade Node and restart Termul.
- **Claude Code CLI missing:** install Anthropic's CLI separately, then run
  `claude auth login`.
- **API-key mode selected but no key is saved:** run the headless
  `api-key set` command.
- **OS keychain unavailable:** `claude-code` mode still launches and
  `termul-server claude auth status` still reports (keychain-derived fields
  show as unavailable). API-key flows stay fail-closed: `api-key set`,
  `api-key delete`, and launching in `api-key` mode all require a working
  keychain.

`Incoming transport closed` means the ACP process closed its stdio connection
during initialization. It does not, by itself, prove which prerequisite or
runtime step failed. Check the host's prerequisite/auth status and Termul's ACP
startup error without sharing credentials or environment dumps.
