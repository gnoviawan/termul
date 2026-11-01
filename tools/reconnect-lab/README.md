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
node tools/reconnect-lab/run.mjs --from tools/reconnect-lab/out   # re-analyse a saved run
```

| Flag | Meaning |
|---|---|
| `--only <ids>` | Run only these scenarios, by id or name. |
| `--repeat <n>` | Run the set `n` times. |
| `--web-dir <dir>` | Serve the page from this `dist-web`. Without it, the server serves the `dist-web` of the checkout it was built from, if that directory exists, so a fresh `bun run build:web` there changes what you measure. |
| `--server-bin <path>` | Use this server binary. |
| `--hide <method>` | How the tab is hidden: `override+pause` (default), `override` or `pause`. `override` flips `document.visibilityState`, and `pause` stops the page's JavaScript like a frozen tab. |
| `--rtt <ms>` | Add this round-trip delay. The proxy holds each chunk for half of it in each direction. |
| `--out <dir>` | Write results here instead of `out/`. |
| `--from <dir>` | Recompute the tables and timelines of a saved run. It rewrites the saved `.log` files. |
| `--headed` | Show the browser window. |

Each scenario writes its timeline to `out/<scenario>.run<N>.log` as it finishes. `out/results.json` and `out/server.log` are written after all runs finish.

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

Build each client into its own `dist-web`, then run the same scenarios against each with `--web-dir`. Both runs must use the same server binary. Each timeline records the host load average and the page's main-thread busy time, counted from long tasks of 200 ms or more. Check both before you trust an outlier.
