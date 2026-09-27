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

Claude Code login is the default. API keys and the selected auth mode are
host-wide. API keys stay in the OS keychain; Termul never displays a saved key
or sends it to a browser client.

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

## Remote browser clients

Authenticated remote users can launch Claude ACP through the host and use the
host's configured credential. Credential status and management remain local to
the server host's CLI. There are no HTTP or WS routes for reading or changing
Claude credentials.

## Startup failures

- **Node.js 22 or newer required:** upgrade Node and restart Termul.
- **Claude Code CLI missing:** install Anthropic's CLI separately, then run
  `claude auth login`.
- **API-key mode selected but no key is saved:** run the headless
  `api-key set` command.
- **OS keychain unavailable:** Termul fails closed. Restore keychain access
  before selecting API-key mode or launching in that mode.

`Incoming transport closed` means the ACP process closed its stdio connection
during initialization. It does not, by itself, prove which prerequisite or
runtime step failed. Check the host's prerequisite/auth status and Termul's ACP
startup error without sharing credentials or environment dumps.
