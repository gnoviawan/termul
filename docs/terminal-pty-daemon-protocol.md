# Terminal PTY Daemon Protocol Draft

**Status:** Draft  
**Date:** 2026-05-13  
**Related:** `docs/terminal-pty-daemon-proposal.md`, `docs/adr-terminal-pty-daemon.md`

## Purpose

Define initial app ↔ daemon protocol for daemon-owned PTY sessions.

Protocol goals:
- local only
- authenticated
- versioned
- cross-platform
- supports attach/detach + backlog replay + live stream

## Transport

Preferred transport:
- Windows: named pipe
- macOS/Linux: unix domain socket

Protocol framing recommendation:
- newline-delimited JSON for control channel
- binary-safe chunk payloads base64-encoded in JSON for MVP

Later optimization possible:
- split control/data channels
- binary framing

## Versioning

Every client handshake includes:
- `protocolVersion`
- `appVersion`

Daemon replies with:
- negotiated `protocolVersion`
- compatibility result

### Initial version
- `protocolVersion: 1`

## Authentication

All clients must authenticate before normal commands.

### Handshake request
```json
{
  "type": "hello",
  "protocolVersion": 1,
  "appVersion": "0.3.6",
  "authToken": "<token>",
  "clientId": "main-window"
}
```

### Handshake response
```json
{
  "type": "hello-ok",
  "protocolVersion": 1,
  "daemonVersion": "0.1.0",
  "clientId": "main-window"
}
```

### Failure response
```json
{
  "type": "error",
  "requestId": null,
  "code": "AUTH_FAILED",
  "message": "invalid auth token"
}
```

## Message Shape

### Request
```json
{
  "requestId": "req-123",
  "type": "create-session",
  "payload": {}
}
```

### Success response
```json
{
  "requestId": "req-123",
  "type": "response",
  "success": true,
  "payload": {}
}
```

### Error response
```json
{
  "requestId": "req-123",
  "type": "response",
  "success": false,
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "session not found"
  }
}
```

### Event
```json
{
  "type": "event",
  "event": "session-data",
  "payload": {}
}
```

## Common Types

### Session metadata
```json
{
  "sessionId": "sess-abc",
  "projectId": "project-1",
  "terminalId": "term-1",
  "name": "Terminal 1",
  "shell": "pwsh",
  "cwd": "D:/repo",
  "pid": 12345,
  "status": "running",
  "createdAt": "2026-05-13T07:00:00.000Z",
  "lastActivityAt": "2026-05-13T07:05:00.000Z",
  "lastAttachedAt": "2026-05-13T07:05:10.000Z",
  "attachedClientCount": 1,
  "cols": 120,
  "rows": 30,
  "exitCode": null
}
```

### Session status enum
- `running`
- `exited`
- `dead`

## Commands

### `create-session`
Spawn new PTY session in daemon.

#### Request payload
```json
{
  "projectId": "project-1",
  "terminalId": "term-1",
  "name": "Terminal 1",
  "shell": "pwsh",
  "cwd": "D:/repo",
  "env": { "FOO": "bar" },
  "cols": 120,
  "rows": 30
}
```

#### Response payload
```json
{
  "session": {
    "sessionId": "sess-abc",
    "projectId": "project-1",
    "terminalId": "term-1",
    "name": "Terminal 1",
    "shell": "pwsh",
    "cwd": "D:/repo",
    "pid": 12345,
    "status": "running",
    "createdAt": "2026-05-13T07:00:00.000Z",
    "lastActivityAt": "2026-05-13T07:00:00.000Z",
    "lastAttachedAt": null,
    "attachedClientCount": 0,
    "cols": 120,
    "rows": 30,
    "exitCode": null
  }
}
```

### `list-sessions`
List all known daemon sessions.

#### Response payload
```json
{
  "sessions": []
}
```

### `get-session`
Get one session by `sessionId`.

#### Request payload
```json
{
  "sessionId": "sess-abc"
}
```

### `get-sessions-for-project`
Return sessions linked to one project.

#### Request payload
```json
{
  "projectId": "project-1"
}
```

### `get-resume-candidates`
Ask daemon for sessions suitable for restore for one project.

#### Request payload
```json
{
  "projectId": "project-1",
  "activeTerminalId": "term-1"
}
```

#### Response payload
```json
{
  "candidates": [
    {
      "score": 100,
      "reason": "terminal-id-match",
      "session": {
        "sessionId": "sess-abc",
        "projectId": "project-1",
        "terminalId": "term-1",
        "name": "Terminal 1",
        "shell": "pwsh",
        "cwd": "D:/repo",
        "pid": 12345,
        "status": "running",
        "createdAt": "2026-05-13T07:00:00.000Z",
        "lastActivityAt": "2026-05-13T07:05:00.000Z",
        "lastAttachedAt": "2026-05-13T07:05:10.000Z",
        "attachedClientCount": 0,
        "cols": 120,
        "rows": 30,
        "exitCode": null
      }
    }
  ]
}
```

### `attach-session`
Mark client attached and begin event stream for one session.

#### Request payload
```json
{
  "sessionId": "sess-abc",
  "clientId": "main-window",
  "cols": 120,
  "rows": 30,
  "backlogMode": "full"
}
```

#### Response payload
```json
{
  "session": {
    "sessionId": "sess-abc",
    "projectId": "project-1",
    "terminalId": "term-1",
    "name": "Terminal 1",
    "shell": "pwsh",
    "cwd": "D:/repo",
    "pid": 12345,
    "status": "running",
    "createdAt": "2026-05-13T07:00:00.000Z",
    "lastActivityAt": "2026-05-13T07:05:00.000Z",
    "lastAttachedAt": "2026-05-13T07:05:10.000Z",
    "attachedClientCount": 1,
    "cols": 120,
    "rows": 30,
    "exitCode": null
  }
}
```

### `detach-session`
Detach client but keep session alive.

#### Request payload
```json
{
  "sessionId": "sess-abc",
  "clientId": "main-window"
}
```

### `kill-session`
Kill one session.

#### Request payload
```json
{
  "sessionId": "sess-abc"
}
```

### `kill-all-sessions`
Kill all daemon sessions.

#### Request payload
```json
{
  "reason": "user-explicit-quit"
}
```

### `write-session`
Write text to PTY.

#### Request payload
```json
{
  "sessionId": "sess-abc",
  "data": "ls -la\r"
}
```

### `resize-session`
Resize PTY.

#### Request payload
```json
{
  "sessionId": "sess-abc",
  "cols": 120,
  "rows": 30
}
```

### `read-backlog`
Read daemon-held backlog for re-render.

#### Request payload
```json
{
  "sessionId": "sess-abc",
  "mode": "full"
}
```

#### Response payload
```json
{
  "chunks": [
    {
      "encoding": "utf8",
      "data": "cHJvbXB0IG91dHB1dA=="
    }
  ]
}
```

### `set-session-project`
Update project association.

#### Request payload
```json
{
  "sessionId": "sess-abc",
  "projectId": "project-1"
}
```

### `set-session-terminal-mapping`
Update renderer terminal identity mapping.

#### Request payload
```json
{
  "sessionId": "sess-abc",
  "terminalId": "term-1",
  "name": "Terminal 1"
}
```

### `prune-orphans`
Force orphan cleanup pass.

#### Request payload
```json
{
  "maxIdleMs": 3600000,
  "onlyDetached": true
}
```

## Events

### `session-data`
```json
{
  "type": "event",
  "event": "session-data",
  "payload": {
    "sessionId": "sess-abc",
    "encoding": "utf8",
    "data": "c29tZSBvdXRwdXQ="
  }
}
```

### `session-exit`
```json
{
  "type": "event",
  "event": "session-exit",
  "payload": {
    "sessionId": "sess-abc",
    "exitCode": 0,
    "signal": null
  }
}
```

### `session-cwd-changed`
```json
{
  "type": "event",
  "event": "session-cwd-changed",
  "payload": {
    "sessionId": "sess-abc",
    "cwd": "D:/repo/subdir"
  }
}
```

### `session-git-branch-changed`
```json
{
  "type": "event",
  "event": "session-git-branch-changed",
  "payload": {
    "sessionId": "sess-abc",
    "branch": "main"
  }
}
```

### `session-git-status-changed`
```json
{
  "type": "event",
  "event": "session-git-status-changed",
  "payload": {
    "sessionId": "sess-abc",
    "status": {
      "modified": 1,
      "staged": 0,
      "untracked": 2,
      "ahead": 0,
      "behind": 0,
      "hasChanges": true
    }
  }
}
```

### `session-exit-code-changed`
```json
{
  "type": "event",
  "event": "session-exit-code-changed",
  "payload": {
    "sessionId": "sess-abc",
    "exitCode": 1
  }
}
```

### `session-attached-count-changed`
```json
{
  "type": "event",
  "event": "session-attached-count-changed",
  "payload": {
    "sessionId": "sess-abc",
    "attachedClientCount": 0
  }
}
```

## Error Codes

Suggested daemon error codes:
- `AUTH_FAILED`
- `UNSUPPORTED_PROTOCOL`
- `INVALID_REQUEST`
- `SESSION_NOT_FOUND`
- `SESSION_ALREADY_ATTACHED`
- `SESSION_DEAD`
- `SPAWN_FAILED`
- `WRITE_FAILED`
- `RESIZE_FAILED`
- `KILL_FAILED`
- `BACKLOG_READ_FAILED`
- `INTERNAL_ERROR`

## Resume Candidate Scoring

Suggested scoring heuristic:
- `100` terminalId exact match + running
- `90` projectId match + last active in mapping + running
- `80` projectId match + detached + recent activity
- `70` projectId match + running
- below `50` usually not auto-resume candidate

## MVP Limits

Protocol v1 MVP may intentionally omit:
- multiple simultaneous attached clients to same session if too complex
- binary framing optimization
- partial backlog cursoring
- daemon-generated project layout state

## Future Extensions

Potential later fields/commands:
- `subscribe-project-sessions`
- `tail-backlog-from-offset`
- `snapshot-session-screen`
- `suspend-session`
- `resume-session`
- `session-tags`
- `session-commandline`
- `session-resource-usage`

## Notes

- `sessionId` must remain daemon-stable across app restarts until session dies
- `terminalId` may be app-side stable mapping key for workspace restore
- daemon should be source of truth for runtime liveness
- renderer persistence remains source of truth for workspace pane layout