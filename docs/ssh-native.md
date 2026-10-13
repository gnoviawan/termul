# Native SSH — design and plan

Status: desktop SSH, delivered as a series of PRs (#1099–#1104). The backend
(#1101) and the session workspace UI (#1103) must land together: the backend
removes the commands the previous SSH panel called. This document is the plan
the refactor followed, kept as the reference for the SSH surface.

## 1. Problems in the previous implementation (evidence)

| # | Problem | Evidence |
|---|---|---|
| P1 | The shell was the system `ssh` CLI typed into a local shell PTY. | `hooks/use-ssh-connection.ts` built `ssh user@host -p … -o StrictHostKeyChecking=accept-new` and `terminalApi.write(ptyId, cmd + '\r')` after a 500 ms timer. |
| P2 | Two independent connections per host (CLI shell + libssh2 SFTP), so the badge reflected the SFTP connection, not the shell the user was typing into. | `handleConnect` spawned the PTY, then called `sshApi.connect` for the "authoritative" status. |
| P3 | Passwords were written to temp files read by an `SSH_ASKPASS` script; on Windows the password could not be fed at all and the user had to type it in the terminal. | `commands/ssh.rs::ssh_create_askpass`, toast "On Windows, type your password in the terminal". |
| P4 | Host keys were accepted silently on first use (`accept-new`), with no fingerprint shown; a changed key was a dead-end string error. | `connection.rs::verify_host_key` `CheckResult::NotFound => append`, `Mismatch => Err("…Remove the stale entry…")`. |
| P5 | One session per host; no tabs, no cancel, no retry/reconnect for the shell, no progress feedback. | `SSHWorkspace` rendered a single `ConnectedTerminal` keyed by profile. |
| P6 | Host management limited to name/host/port/user/auth; no search, groups, favorites, duplicate; validation via toast only; `window.prompt` / `confirm` in SFTP actions. | `SSHProfileForm.tsx`, `use-ssh-workspace.ts`. |
| P7 | Errors were raw libssh2 strings ("Key authentication failed: [-18] …"). | `connection.rs::authenticate_session`. |

## 2. Target user flow (Termius principles applied)

* **Library vs. live sessions.** The SSH workspace has a fixed **Hosts** tab
  plus one tab per session (several sessions per host allowed). Each tab
  shows a status dot *and* a status word.
* **One connection screen.** Opening a session shows a step list
  (Connect → Verify host → Authenticate → Start shell) inside the tab. Host
  key confirmation, password/passphrase prompts and failures render inline
  in that same screen, never as chained modals.
* **Ask for the minimum.** The host editor needs four fields
  (address, port, username, auth); label, group, tags are optional. Termul
  keeps an explicit Save (its dialog convention) — Termius auto-saves.
* **Short keyboard path.** Command palette lists every host; Enter on a host
  row connects; tabs are a real `tablist` (arrow keys).
* **Cheap recovery.** Every failure has a cause, a next step, and actions
  (Retry, Edit host, Close). A dropped session keeps its output visible and
  offers Reconnect.

## 3. Architecture

```
renderer                                   src-tauri
────────                                   ─────────
SSHWorkspace ── tabs ── SSHHostsView        commands/ssh.rs
      │                 SSHSessionView ──►  ssh_session_open/cancel/close/…, sftp_*
      │                     │                    │
ssh-store (profiles,        │ attach(claim)      ▼
 sessions, prompts) ◄─ events ◄──────────  ssh/session.rs  SshSessionManager
ssh-sessions.ts (open/retry/close)               │ connect pipeline (ssh/connect.rs, russh)
                                                 │   tcp+keepalive → handshake → host key
ConnectedTerminal ◄── terminal_attach ────┐      │   (ssh/known_hosts.rs) → auth (password /
                                          │      │   kbd-int / key / agent)
SSHFileExplorer ── sftp_* ──► ssh/connection.rs  │ (shell, SFTP, forwards = channels)
                                          │      ▼
                                          └─ PtyManager::adopt_external  ◄─ ssh/shell.rs
                                             (same TerminalInstance, reader/flusher,     reader + writer tasks
                                              replay log, claims, kill/resize)           on a split channel
```

* **Library:** `russh` (+ `russh-sftp`), replacing `ssh2`/libssh2. Evidence:
  on Windows, `ssh2` builds libssh2 on WinCNG, which cannot use ed25519 or
  encrypted OpenSSH-format keys (the real-server matrix failed those cases);
  the alternative, vendored OpenSSL on Windows, needs a native Perl and was
  rejected by the repo (`Cargo.toml` note on MSYS environments). russh is pure
  Rust on the `aws-lc-rs` backend already in the tree, so every platform gets
  the same algorithms with no new toolchain. One connection per session tab
  carries the shell, the SFTP subsystem and port forwards as channels — no
  second login or host-key check for the file browser.
* **Terminal integration:** the shell channel is adopted by `PtyManager` as
  a regular terminal (Read/Write/Child adapters + a resize hook), so xterm,
  scrollback replay, claims, write/resize/kill and exit events are reused
  instead of duplicated.
* **Host keys:** SHA256 fingerprint; app-managed `~/.ssh/known_hosts_termul`
  checked first, then the user's `~/.ssh/known_hosts` (read-only). Unknown →
  inline confirm (trust is persisted). Changed → destructive warning; the
  user may replace the Termul entry explicitly. Never auto-accept.
* **Secrets:** OS keychain (`keyring`) for saved password/passphrase. A secret
  typed at a prompt is kept in process memory only while a session for that
  host is alive (for SFTP and reconnect), and optionally saved to the keychain.
  No temp files, no secrets in logs or error text.
* **Network loss:** TCP keepalive (socket2) + SSH keepalive (15 s, 3 misses);
  the shell ends with a "connection lost" reason, the tab keeps the output and
  shows Reconnect.

## 4. Data and migration

* `ssh-profiles.json` gains optional `group` and `favorite` (serde defaults);
  old files load unchanged. Keychain entry names are unchanged.
* `known_hosts_termul` format is unchanged (OpenSSH lines); the user's
  `~/.ssh/known_hosts` stays read-only. Hashed names, wildcards, `!` and
  `@revoked` are honoured; unreadable lines are skipped.
* The askpass command (temp files holding passwords) is removed, as are the
  separate file-browser connection commands (`ssh_connect`/`ssh_disconnect`/
  `ssh_get_connections`); nothing persisted depended on them.
* Web/browser client: profile CRUD still uses the server store; connecting
  stays desktop-only and is labelled as such (`WEB_UNSUPPORTED`).

## 5. Scope decisions

| Feature | Decision |
|---|---|
| Password, key + passphrase, agent auth | In scope. Keyboard-interactive is used as a password fallback. OpenSSH, PEM and PuTTY `.ppk` keys. |
| SFTP browser, port forwarding | Kept; both run over the active session's connection. Port forwarding stays API-only (no UI before or after). |
| Jump host | Not built yet. russh can stack a session on a `direct-tcpip` channel (`connect_stream`), so it is a follow-up, not a blocker. `jumpHostId` kept. |
| Snippets, identities, cloud sync, teams | Out of scope; Termul already has command history/palette. |

## 6. Acceptance checks

Real server (`openssh-server` in WSL): password, key, encrypted key, wrong
password, missing/invalid key, bad port, DNS failure, timeout, first-time and
changed host key, network drop, cancel, retry, reconnect, disconnect, several
sessions, resize + interactive TUI, app restart persistence, keyboard flow.
