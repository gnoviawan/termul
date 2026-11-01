# Reconnect lab

The lab measures how fast the web client recovers after a connection fault. It runs a real Chromium page against an isolated `termul-server`, through a TCP proxy that injects faults while a fake agent streams a turn.

For each fault, the lab reports the time until the chat socket is connected again, the time until streamed text grows again, how long "Reconnecting…" was visible, and how many sockets the page opened.

## Prerequisites

- A release server binary: `cargo build --release --bin termul-server --features standalone-server`
- A web build: `bun run build:web`
- Playwright Chromium, as for `tests/e2e`

The lab binds only to `127.0.0.1` on free ports and uses a temporary state directory. It never touches a running server.

## Run

```sh
node tools/reconnect-lab/run.mjs                       # every scenario, once
node tools/reconnect-lab/run.mjs --only s1,s7 --repeat 2
node tools/reconnect-lab/run.mjs --from tools/reconnect-lab/out   # re-print a saved run
```

| Flag | Meaning |
|---|---|
| `--only <ids>` | Run only these scenarios, by id or name. |
| `--repeat <n>` | Run the set `n` times. |
| `--web-dir <dir>` | Serve the page from this `dist-web` instead of the server's built-in assets. |
| `--server-bin <path>` | Use this server binary. |
| `--hide <method>` | How the tab is hidden: `override+pause` (default), `override`, `pause` or `freeze`. |
| `--rtt <ms>` | Add this round-trip delay. The proxy holds each chunk for half of it in each direction. |
| `--out <dir>` | Write results here instead of `out/`. |

Each run writes `out/results.json` and one timeline per scenario, `out/<scenario>.run<N>.log`.

## Scenarios

| Id | Name | Fault |
|---|---|---|
| p0 | lifecycle-probe | Tests which hide method fires the client's return path. |
| s1 | rst-visible | Reset every connection while the tab is visible. |
| s2 | hidden-rst | Hide the tab, reset every connection, then show the tab. |
| s3a | hidden-blackhole | Hide the tab and stop all traffic. Show it, then restore traffic 5 s later. |
| s3b | hidden-blackhole-destroy | As s3a, but reset the held connections when the tab shows. |
| s4 | hidden-long | Hide the tab for 6 min with a healthy link. |
| s5 | link-down-60 | Reset and refuse every connection for 60 s. |
| s6 | stall-downstream | Hold server-to-browser bytes for 30 s. |
| s7 | flap | Reset every connection every 45 s for 5 min. |
| s8 | hidden-mid-handshake | Hide the tab while a reconnect handshake is in flight. |

## Compare two clients

Build each client into its own `dist-web`, then run the same scenarios against each with `--web-dir`. Both runs must use the same server binary. Each timeline records the host load average and the time the page's main thread was busy. Check both before you trust an outlier.
