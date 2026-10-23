#!/usr/bin/env bash
# Fails when the standalone `termul-server` dynamically links a GUI toolkit.
#
# The headless server opens no window, so it must run on hosts without
# GTK/WebKit installed (#1349). The usual regression is a shared type gaining an
# `AppHandle<Wry>` field: its drop glue alone keeps the Wry runtime live.
# Hold a type-erased sink instead and build it from the handle in `lib.rs`.
#
# Usage: scripts/check-server-no-gui-libs.sh [path/to/termul-server]
set -euo pipefail

bin="${1:-src-tauri/target/debug/termul-server}"
[ -f "$bin" ] || { echo "error: $bin not found; build termul-server first" >&2; exit 2; }

gui='libwebkit2gtk|libjavascriptcoregtk|libgtk-|libgdk-|libsoup-|libgdk_pixbuf|libpango|libcairo|libatk|libharfbuzz'
leaked="$(readelf -d "$bin" | awk '/\(NEEDED\)/ {print $5}' | tr -d '[]' | grep -E "$gui" || true)"

if [ -n "$leaked" ]; then
  echo "error: $bin links GUI libraries:" >&2
  echo "$leaked" | sed 's/^/  /' >&2
  echo "Find the culprit: rebuild with" >&2
  echo "  cargo rustc --bin termul-server --features standalone-server -- \\" >&2
  echo "    -C link-arg=-fuse-ld=lld -C link-arg=-Wl,--why-live='<mangled tao Window::new>'" >&2
  echo "Note: GNU ld picks archive members before gc, so this check is only" >&2
  echo "meaningful with rust-lld (default on x86_64-unknown-linux-gnu, Rust >= 1.90)." >&2
  exit 1
fi
echo "ok: $bin links no GUI libraries"
