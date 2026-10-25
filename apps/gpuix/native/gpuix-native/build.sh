#!/bin/sh
# Build Termul's @gpuix/native addon from source, with Termul's patch series.
#
#   ./build.sh            fetch + patch + build + package + load check
#   ./build.sh fetch      shallow-fetch gpuix and zed at the pins
#   ./build.sh patch      reset both checkouts to the pins and apply patches/
#   ./build.sh check      drift check: apply the series to a scratch copy of
#                         the pinned (or overridden) upstream; non-zero exit
#                         names the patch that no longer applies
#   ./build.sh build      cargo build + package (assumes patch ran)
#   ./build.sh test       the napi crate's unit tests on the patched source
#                         (shares the release dependency builds; ~15 min cold)
#
# Pins live in pins.env; any pin can be overridden from the environment, e.g.
#   GPUIX_COMMIT=<sha> ZED_COMMIT=<sha> ./build.sh check
#
# Work dir (sources + cargo target): $TERMUL_GPUIX_NATIVE_WORK, default
# ~/gpuix-native-target. The build stops itself when the work dir passes
# $TERMUL_GPUIX_NATIVE_MAX_GB (14) or / drops under $TERMUL_GPUIX_NATIVE_MIN_FREE_GB (8).
#
# Output: build/gpuix-native.linux-x64-gnu.node next to this script. The app
# loads it when TERMUL_GPUIX_NATIVE=local (see apps/gpuix/src/native-addon.ts).
set -eu
here=$(cd "$(dirname "$0")" && pwd)

for line in $(grep -E '^[A-Z_]+=' "$here/pins.env"); do
  key=${line%%=*}
  eval "[ -n \"\${$key:-}\" ] || $line"
done

work=${TERMUL_GPUIX_NATIVE_WORK:-$HOME/gpuix-native-target}
max_gb=${TERMUL_GPUIX_NATIVE_MAX_GB:-14}
min_free_gb=${TERMUL_GPUIX_NATIVE_MIN_FREE_GB:-8}
src=$work/upstream/gpuix
zed=$src/zed
target=$work/cargo
out=$here/build/gpuix-native.linux-x64-gnu.node
series=$(cat "$here"/patches/gpuix/*.patch "$here"/patches/zed/*.patch 2>/dev/null | sha256sum | cut -c1-16)

say() { printf '== %s\n' "$*"; }
die() { printf 'build.sh: %s\n' "$*" >&2; exit 1; }

free_gb() { df --output=avail -BG / | tail -1 | tr -dc 0-9; }
work_gb() { du -s -BG "$work" 2>/dev/null | cut -f1 | tr -dc 0-9; }

# shallow_checkout <dir> <repo> <commit>
shallow_checkout() {
  if [ ! -d "$1/.git" ]; then
    mkdir -p "$1"
    git -C "$1" init -q
    git -C "$1" remote add origin "$2"
  fi
  if ! git -C "$1" cat-file -e "$3^{commit}" 2>/dev/null; then
    git -C "$1" fetch -q --depth 1 origin "$3"
  fi
}

fetch() {
  say "fetch gpuix $GPUIX_COMMIT"
  shallow_checkout "$src" "$GPUIX_REPO" "$GPUIX_COMMIT"
  pinned_zed=$(git -C "$src" ls-tree "$GPUIX_COMMIT" zed | awk '{print $3}')
  [ "$pinned_zed" = "$ZED_COMMIT" ] || die "gpuix $GPUIX_COMMIT pins zed $pinned_zed, pins.env says $ZED_COMMIT"
  say "fetch zed $ZED_COMMIT"
  shallow_checkout "$zed" "$ZED_REPO" "$ZED_COMMIT"
}

# apply_series <checkout> <pin> <patch dir> <pathspec excluded from the stamp commit>
# The applied state is a local commit "termul-patches <series hash>" on top of
# the pin. A rerun with the same series and a clean tree is a no-op, so cargo
# keeps its incremental state; anything else resets to the pin and reapplies.
apply_series() {
  dir=$1 pin=$2 patches=$3 exclude=$4
  if [ "$(git -C "$dir" rev-parse -q --verify HEAD^ 2>/dev/null || true)" = "$pin" ] &&
    [ "$(git -C "$dir" log -1 --format=%s)" = "termul-patches $series" ] &&
    [ -z "$(git -C "$dir" status --porcelain --ignore-submodules=all)" ]; then
    say "$(basename "$dir"): series $series already applied"
    return
  fi
  if [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)" != "$pin" ]; then
    git -C "$dir" checkout -q --force --detach "$pin"
  fi
  git -C "$dir" reset -q --hard "$pin"
  git -C "$dir" clean -fdq -e "$exclude"
  for p in "$patches"/*.patch; do
    [ -e "$p" ] || continue
    if ! git -C "$dir" apply --check "$p" 2>"$work/apply.err"; then
      cat "$work/apply.err" >&2
      die "$(basename "$p") no longer applies to $(basename "$dir") $pin (upstream drift); rebase the patch"
    fi
    git -C "$dir" apply "$p"
    say "applied $(basename "$dir")/$(basename "$p")"
  done
  git -C "$dir" add -A -- . ":(exclude)$exclude"
  git -C "$dir" -c user.name=termul -c user.email=termul@localhost commit -q --allow-empty -m "termul-patches $series"
}

patch() {
  [ -d "$zed/.git" ] || fetch
  apply_series "$zed" "$ZED_COMMIT" "$here/patches/zed" "target"
  apply_series "$src" "$GPUIX_COMMIT" "$here/patches/gpuix" "zed"
}

check() {
  fetch
  scratch=$(mktemp -d "$work/check.XXXXXX")
  trap 'rm -rf "$scratch"; git -C "$src" worktree prune; git -C "$zed" worktree prune' EXIT
  for repo in gpuix zed; do
    if [ "$repo" = gpuix ]; then dir=$src pin=$GPUIX_COMMIT; else dir=$zed pin=$ZED_COMMIT; fi
    git -C "$dir" worktree prune
    git -C "$dir" worktree add -q --detach "$scratch/$repo" "$pin"
    for p in "$here/patches/$repo"/*.patch; do
      [ -e "$p" ] || continue
      git -C "$scratch/$repo" apply "$p" || die "DRIFT: $repo/$(basename "$p") does not apply to $pin"
      echo "ok $repo/$(basename "$p")"
    done
    git -C "$dir" worktree remove --force "$scratch/$repo"
  done
  say "series $series applies cleanly to gpuix $GPUIX_COMMIT + zed $ZED_COMMIT"
}

# Kills the cargo process group when the disk budget is exceeded.
guard() {
  while kill -0 "$1" 2>/dev/null; do
    f=$(free_gb) u=$(work_gb)
    if [ "$f" -lt "$min_free_gb" ] || [ "$u" -gt "$max_gb" ]; then
      echo "build.sh: disk budget hit (free ${f}G < ${min_free_gb}G or work ${u}G > ${max_gb}G); stopping cargo" >&2
      echo "free=${f}G work=${u}G" >"$work/budget-stop"
      pkill -TERM -P "$1" 2>/dev/null || true
      kill -TERM "$1" 2>/dev/null || true
      return
    fi
    sleep 20
  done
}

# GPUI links -lxkbcommon-x11 and -lX11-xcb. Their unversioned .so symlinks
# come with the -dev packages (libxkbcommon-x11-dev, libx11-xcb-dev); a box
# with only the runtime libraries gets the symlinks here, on LIBRARY_PATH (the
# cc linker driver reads it, and cargo does not fingerprint it).
link_shims() {
  shims=$work/syslib
  mkdir -p "$shims"
  for lib in xkbcommon-x11 X11-xcb; do
    if ! ldconfig -p | grep -q "lib$lib\.so "; then
      runtime=$(ldconfig -p | awk -v l="lib$lib.so." 'index($1, l) == 1 {print $NF; exit}')
      [ -n "$runtime" ] || die "lib$lib is missing; install its -dev package"
      ln -sf "$runtime" "$shims/lib$lib.so"
      say "link shim lib$lib.so -> $runtime"
    fi
  done
  export LIBRARY_PATH="$shims${LIBRARY_PATH:+:$LIBRARY_PATH}"
}

build() {
  [ "$(free_gb)" -ge "$min_free_gb" ] || die "only $(free_gb)G free on /, need ${min_free_gb}G"
  link_shims
  rm -f "$work/budget-stop"
  say "cargo build (release, no default features, as the published linux-x64-gnu addon)"
  start=$(date +%s)
  (
    cd "$src/packages/native"
    CARGO_INCREMENTAL=0 CARGO_TARGET_DIR="$target" \
      exec nice -n 19 cargo "+$RUST_TOOLCHAIN" build --release --lib --locked --no-default-features
  ) &
  cargo_pid=$!
  guard "$cargo_pid" &
  guard_pid=$!
  status=0
  wait "$cargo_pid" || status=$?
  kill "$guard_pid" 2>/dev/null || true
  [ ! -e "$work/budget-stop" ] || die "stopped on disk budget: $(cat "$work/budget-stop")"
  [ "$status" = 0 ] || die "cargo build failed ($status)"
  say "built in $(($(date +%s) - start))s; work dir $(work_gb)G, $(free_gb)G free on /"
  mkdir -p "$here/build"
  rm -f "$out"
  cp "$target/release/libgpuix_native.so" "$out"
  node -e "const m = require(process.argv[1]); if (typeof m.GpuixRenderer !== 'function') throw new Error('no GpuixRenderer export')" "$out"
  say "loads: $out ($(du -h "$out" | cut -f1))"
}

unit_tests() {
  link_shims
  (
    cd "$src/packages/native"
    CARGO_INCREMENTAL=0 CARGO_TARGET_DIR="$target" \
      exec nice -n 19 cargo "+$RUST_TOOLCHAIN" test --release --lib --locked --no-default-features
  )
}

mkdir -p "$work"
case "${1:-all}" in
  fetch) fetch ;;
  patch) patch ;;
  check) check ;;
  build) build ;;
  test) patch; unit_tests ;;
  all) fetch; patch; build ;;
  *) die "unknown command: $1" ;;
esac
