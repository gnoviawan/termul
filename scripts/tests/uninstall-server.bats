#!/usr/bin/env bats

load "helpers.bash"

setup() {
  make_tmp
  export HOME="$TERMUL_TEST_TMP_DIR/home"
  export TERMUL_TEST_LOG="$TERMUL_TEST_TMP_DIR/commands.log"
  export TERMUL_INSTALL_BIN_DIR="$TERMUL_TEST_TMP_DIR/bin"
  export TERMUL_INSTALL_STATE_DIR="$TERMUL_TEST_TMP_DIR/state"
  export TERMUL_INSTALL_SYSTEM_UNIT="$TERMUL_TEST_TMP_DIR/no-system.service"
  export TERMUL_INSTALL_USER_UNIT="$TERMUL_TEST_TMP_DIR/no-user.service"
  mkdir -p "$HOME" "$TERMUL_INSTALL_BIN_DIR" "$TERMUL_INSTALL_STATE_DIR"
  : >"$TERMUL_TEST_LOG"
  unset TERMUL_PURGE
  unset TERMUL_INSTALL_TTY
}

teardown() {
  if [[ -n "${TERMUL_INSTALL_STATE_DIR:-}" && -f "${TERMUL_INSTALL_STATE_DIR}/termul-server.pid" ]]; then
    local pid
    pid="$(tr -cd '0-9' <"${TERMUL_INSTALL_STATE_DIR}/termul-server.pid" || true)"
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  if [[ -n "${TERMUL_INSTALL_BIN_DIR:-}" ]]; then
    pkill -f "${TERMUL_INSTALL_BIN_DIR}/termul-server serve" 2>/dev/null || true
  fi
  unset TERMUL_PURGE
  unset TERMUL_INSTALL_TTY
  unset TERMUL_INSTALL_BIN_DIR
  unset TERMUL_INSTALL_STATE_DIR
  unset TERMUL_INSTALL_SYSTEM_UNIT
  unset TERMUL_INSTALL_USER_UNIT
  cleanup_tmp
}

@test "require_linux rejects other operating systems" {
  stub_cmd uname 'printf "%s\n" Darwin'
  load_uninstall_server

  run require_linux

  [ "$status" -ne 0 ]
  [[ "$output" == *"only removes the Linux termul-server"* ]]
  [[ "$output" == *"Darwin"* ]]
}

@test "prompt_purge keeps by default, deletes on yes, and honors TERMUL_PURGE" {
  load_uninstall_server
  local answer="$TERMUL_TEST_TMP_DIR/answer"
  export TERMUL_INSTALL_TTY="$answer"

  printf 'n\n' >"$answer"
  run prompt_purge "$TERMUL_INSTALL_STATE_DIR"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Keeping"* ]]
  [ -d "$TERMUL_INSTALL_STATE_DIR" ]

  printf '\n' >"$answer"
  run prompt_purge "$TERMUL_INSTALL_STATE_DIR"
  [ "$status" -eq 1 ]

  printf 'y\n' >"$answer"
  run prompt_purge "$TERMUL_INSTALL_STATE_DIR"
  [ "$status" -eq 0 ]

  export TERMUL_PURGE=0
  run prompt_purge "$TERMUL_INSTALL_STATE_DIR"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Keeping"* ]]

  export TERMUL_PURGE=1
  run prompt_purge "$TERMUL_INSTALL_STATE_DIR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"TERMUL_PURGE=1"* ]]
}

@test "state_dir_is_safe_to_delete refuses home, root, and symlinks" {
  load_uninstall_server

  run state_dir_is_safe_to_delete "$HOME"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Refusing to delete"* ]]

  run state_dir_is_safe_to_delete "/"
  [ "$status" -ne 0 ]

  run state_dir_is_safe_to_delete "/tmp/example/termul"
  [ "$status" -eq 0 ]

  rmdir "$TERMUL_INSTALL_STATE_DIR"
  ln -s /tmp "$TERMUL_INSTALL_STATE_DIR"
  run state_dir_is_safe_to_delete "$TERMUL_INSTALL_STATE_DIR"
  [ "$status" -ne 0 ]
  [[ "$output" == *"symlink"* ]]
}

@test "main removes the binary and a systemd unit but keeps state unless purged" {
  if [[ -e /usr/local/bin/termul-server ]]; then
    skip "a real termul-server is installed at /usr/local/bin"
  fi

  load_uninstall_server
  stub_cmd systemctl 'printf "systemctl %s\n" "$*" >>"$TERMUL_TEST_LOG"; exit 0'
  local unit="$TERMUL_TEST_TMP_DIR/termul-server.service"
  local user_unit="$TERMUL_TEST_TMP_DIR/user-termul-server.service"
  printf '%s\n' '[Service]' 'ExecStart=/bin/true' >"$unit"
  printf '%s\n' '[Service]' 'ExecStart=/bin/true' >"$user_unit"
  export TERMUL_INSTALL_SYSTEM_UNIT="$unit"
  export TERMUL_INSTALL_USER_UNIT="$user_unit"
  printf '#!/bin/sh\nexit 0\n' >"$TERMUL_INSTALL_BIN_DIR/termul-server"
  printf '#!/bin/sh\nexit 0\n' >"$TERMUL_INSTALL_BIN_DIR/termul-manager"
  chmod +x "$TERMUL_INSTALL_BIN_DIR/termul-server" "$TERMUL_INSTALL_BIN_DIR/termul-manager"
  printf 'session\n' >"$TERMUL_INSTALL_STATE_DIR/session"
  export TERMUL_PURGE=0

  run main

  [ "$status" -eq 0 ]
  [ ! -e "$unit" ]
  [ ! -e "$user_unit" ]
  [ ! -e "$TERMUL_INSTALL_BIN_DIR/termul-server" ]
  [ -x "$TERMUL_INSTALL_BIN_DIR/termul-manager" ]
  [ -f "$TERMUL_INSTALL_STATE_DIR/session" ]
  grep -q "disable --now $unit" "$TERMUL_TEST_LOG"
  grep -q "daemon-reload" "$TERMUL_TEST_LOG"
  grep -q -- "--user disable --now $user_unit" "$TERMUL_TEST_LOG"
  [[ "$output" == *"Keeping"* ]]
  [[ "$output" == *"uninstalled"* ]]

  export TERMUL_PURGE=1
  run main
  [ "$status" -eq 0 ]
  [ ! -d "$TERMUL_INSTALL_STATE_DIR" ]
  [[ "$output" == *"Deleted"* ]]
}

@test "main kills a setsid termul-server recorded in the pid file" {
  if [[ -e /usr/local/bin/termul-server ]]; then
    skip "a real termul-server is installed at /usr/local/bin"
  fi

  load_uninstall_server
  cat >"$TERMUL_INSTALL_BIN_DIR/termul-server" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "serve" ]]; then
  while true; do
    sleep 30
  done
fi
exit 1
EOF
  chmod +x "$TERMUL_INSTALL_BIN_DIR/termul-server"
  setsid "$TERMUL_INSTALL_BIN_DIR/termul-server" serve >/dev/null 2>&1 </dev/null &
  local pid=$!
  printf '%s\n' "$pid" >"$TERMUL_INSTALL_STATE_DIR/termul-server.pid"
  export TERMUL_PURGE=0

  run main

  [ "$status" -eq 0 ]
  [[ "$output" == *"Stopping termul-server process ${pid}"* ]]
  run kill -0 "$pid"
  [ "$status" -ne 0 ]
  [ ! -e "$TERMUL_INSTALL_BIN_DIR/termul-server" ]
  [ -d "$TERMUL_INSTALL_STATE_DIR" ]
}
