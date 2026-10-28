#!/bin/sh
# Runs zed/0011's SVG budget unit tests (svg_renderer/budget_tests.rs) without
# building gpui: a scratch crate includes budget.rs against the same usvg.
# Needs the patched checkout from `build.sh patch`.
set -eu
here=$(cd "$(dirname "$0")/../../native/gpuix-native" && pwd)
toolchain=$(grep '^RUST_TOOLCHAIN=' "$here/pins.env" | cut -d= -f2)
work=${TERMUL_GPUIX_NATIVE_WORK:-$HOME/gpuix-native-target}
budget=$work/upstream/gpuix/zed/crates/gpui/src/svg_renderer/budget.rs
[ -f "$budget" ] || { echo "budget-test.sh: no $budget; run build.sh patch" >&2; exit 1; }
crate=$(mktemp -d)
trap 'rm -rf "$crate"' EXIT
mkdir "$crate/src"
cat >"$crate/Cargo.toml" <<TOML
[package]
name = "svg-budget-test"
version = "0.0.0"
edition = "2024"
[dependencies]
usvg = "=0.46.0"
log = "0.4"
TOML
printf '#[path = "%s"]\nmod budget;\n' "$budget" >"$crate/src/lib.rs"
cd "$crate"
CARGO_TARGET_DIR=$work/budget-test nice -n 19 cargo "+$toolchain" test --offline --release --lib
