#!/usr/bin/env bash
# Runs the whole Rust suite and fails on any failing test that the per-OS
# record `known-test-failures/<os>.txt` does not list. A listed test that now
# passes is only reported, since a few of them fail by timing.
#
# Run from src-tauri. Windows test executables get the Common-Controls
# manifest first (see build-windows-tests.ps1).

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) os=windows ;;
esac

if [ "$os" = windows ]; then
  ps="$(command -v pwsh || command -v powershell)"
  "$ps" -NoProfile -File "$(cygpath -w "$here/build-windows-tests.ps1")" --features conformance || exit 1
fi

log="$(mktemp)"
cargo test --no-fail-fast --features conformance 2>&1 | tee "$log"
status="${PIPESTATUS[0]}"

failing="$(mktemp)"
tr -d '\r' <"$log" | sed -n 's/^test \(.*\) \.\.\. FAILED$/\1/p' | sort -u >"$failing"
known="$(mktemp)"
tr -d '\r' <"$here/known-test-failures/$os.txt" | sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' | sort -u >"$known"

echo
echo "== Rust test summary ($os) =="
echo "failing tests: $(wc -l <"$failing" | tr -d ' '), known failures: $(wc -l <"$known" | tr -d ' ')"

fixed="$(comm -13 "$failing" "$known")"
if [ -n "$fixed" ]; then
  echo "listed as failing but passing in this run (remove from known-test-failures/$os.txt if stable):"
  echo "$fixed" | sed 's/^/  /'
fi

# A test outside the record gets one rerun on its own, since a few fail only
# under the load of a full run. Names are read a line at a time because a
# doc-test name holds spaces. A rerun clears the test only when it ran that
# test and it passed: a filter that matches nothing also exits 0.
unknown="$(comm -23 "$failing" "$known")"
still_failing="$(mktemp)"
while IFS= read -r name; do
  [ -n "$name" ] || continue
  rerun="$(cargo test --features conformance -- --exact "$name" 2>&1)"
  rerun_status=$?
  if [ "$rerun_status" -eq 0 ] && grep -q "^test result: ok[.] 1 passed" <<<"$rerun"; then
    echo "flaky: $name failed in the full run and passed on its own"
  else
    echo "$name" >>"$still_failing"
  fi
done <<<"$unknown"
if [ -s "$still_failing" ]; then
  echo "UNEXPECTED failing tests:"
  sed 's/^/  /' "$still_failing"
  exit 1
fi

if grep -q "process didn't exit successfully" "$log"; then
  echo "a test executable crashed"
  exit 1
fi

if [ "$status" -ne 0 ] && [ ! -s "$failing" ]; then
  echo "cargo test exited $status without a failing test (build error?)"
  exit 1
fi
echo "only known failures remain"
