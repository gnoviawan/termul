TERMUL_TEST_REPO_ROOT="$(cd "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/../.." && pwd)"

make_tmp() {
  TERMUL_TEST_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/termul-install-test.XXXXXX")"
  TERMUL_TEST_STUB_BIN="$TERMUL_TEST_TMP_DIR/bin"
  mkdir -p "$TERMUL_TEST_STUB_BIN"

  TERMUL_TEST_ORIGINAL_PATH="${TERMUL_TEST_ORIGINAL_PATH:-$PATH}"
  PATH="$TERMUL_TEST_STUB_BIN:$TERMUL_TEST_ORIGINAL_PATH"

  export TERMUL_TEST_TMP_DIR
  export TERMUL_TEST_STUB_BIN
  export TERMUL_TEST_ORIGINAL_PATH
  export PATH
}

cleanup_tmp() {
  if [[ -n "${TERMUL_TEST_TMP_DIR:-}" && -d "$TERMUL_TEST_TMP_DIR" ]]; then
    rm -rf "$TERMUL_TEST_TMP_DIR"
  fi

  if [[ -n "${TERMUL_TEST_ORIGINAL_PATH:-}" ]]; then
    PATH="$TERMUL_TEST_ORIGINAL_PATH"
    export PATH
  fi

  unset TERMUL_TEST_TMP_DIR
  unset TERMUL_TEST_STUB_BIN
  unset TERMUL_TEST_ORIGINAL_PATH
}

stub_cmd() {
  local name="$1"
  shift

  if [[ -z "${TERMUL_TEST_STUB_BIN:-}" ]]; then
    make_tmp
  fi

  local stub_path="$TERMUL_TEST_STUB_BIN/$name"
  {
    printf '#!/usr/bin/env bash\n'
    printf '%s\n' "$*"
  } >"$stub_path"
  chmod +x "$stub_path"
}

load_install() {
  source "$TERMUL_TEST_REPO_ROOT/scripts/install.sh"
}
