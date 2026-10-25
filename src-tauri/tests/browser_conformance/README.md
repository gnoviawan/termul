# Browser conformance runner

Drives the desktop browser automation host on a real webview and reports one
pass or fail per capability.

## How it runs

`main.rs` is a test target without the libtest harness, because the event loop
must own the main thread on macOS. It:

1. serves the pages in `../browser_fixtures/pages` from an OS-chosen loopback
   port that is never the dev server port;
2. starts a Tauri app with one main window;
3. installs the real `DesktopBrowserHost` and stands in for the renderer
   (`adapter.rs`): it opens the webview when the host asks for an agent tab.
   Loopback fixtures never raise an origin consent ticket. Sensitive actions
   on them (password submits, uploads, downloads, tainted navigation) do:
   the adapter records each ticket and answers it as unattended unless a case
   scripts an answer. Each case's session is its own project, and upload
   cases read from a temp project folder of fake files;
4. runs each case in `cases.rs` through `dispatch`, the same entry point the
   host MCP parent uses.

The runner reaches the host only through `termul_manager_lib::conformance_support`
and `adapter.rs`.

The main webview loads `chat.html`, a stand-in for the chat pane with a focused
text box. Input cases (`input_cases.rs`) drive the engine adapter directly
against `input.html` with trusted input, for every tier the adapter declares,
and read what the page saw from the reports it posts to the fixture server.
They need no eval channel, so they run on every engine. Each one also checks
that the chat stand-in kept focus and received nothing. A capability the
adapter declares synthetic must refuse trusted input.

It skips unless `TERMUL_BROWSER_CONFORMANCE` is set. The target needs the
`conformance` feature, which exposes the library seam it drives, so plain
`cargo test` does not build it. `TERMUL_BROWSER_CONFORMANCE_OUT` sets where the JSON summary
goes.

## Expected results

`expected/<os>.json` lists the capabilities that fail on that OS today with
their wire error code. The run fails when a result differs:

- a failure that is not listed;
- a listed capability that now passes (delete its entry);
- a listed capability that fails with another code (update the entry).

`known-test-failures/<os>.txt` plays the same role for failing Rust tests, but
only unlisted failures fail the run.

## Running locally

```sh
cd src-tauri
TERMUL_BROWSER_CONFORMANCE=1 cargo test --features conformance --test browser_conformance -- --nocapture
```

On Linux wrap the command in `xvfb-run -a` when no display is available.

## Agent profile fixture

With `TERMUL_PROFILE_FIXTURE=1` the same binary runs `profile.rs` instead of
the suite. It builds tabs on the app profile, the global agent profile and
per-session ephemeral profiles, restarts itself as a second process, and
checks that cookies stay where they belong:

```sh
cd src-tauri
TERMUL_PROFILE_FIXTURE=1 cargo test --features conformance --test browser_conformance -- --nocapture
``` On
Windows build the test executable with
`tests/browser_conformance/build-windows-tests.ps1 --features conformance` first, which installs the Common-Controls manifest the executable needs.
