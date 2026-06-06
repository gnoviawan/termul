#!/usr/bin/env bats

load "helpers.bash"

@test "bats shell harness runs" {
  run bash -c 'printf "%s\n" "termul shell harness"'

  [ "$status" -eq 0 ]
  [ "$output" = "termul shell harness" ]
}
