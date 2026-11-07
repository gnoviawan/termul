#![cfg(not(target_os = "windows"))]

use super::frame::Frame;
use super::inject_test_support::{bash_supports_integration, on_path, LiveShell};
use std::path::PathBuf;

fn shells() -> Vec<PathBuf> {
    let mut paths = vec![on_path("bash").unwrap(), PathBuf::from("/bin/bash")];
    paths.dedup();
    paths.retain(|shell| bash_supports_integration(shell));
    if let Some(zsh) = on_path("zsh") {
        paths.push(zsh);
    }
    paths
}

fn request(live: &mut LiveShell, draft: &str) -> Vec<Frame> {
    let hex: String = draft.bytes().map(|b| format!("{b:02x}")).collect();
    live.write(
        format!(
            "\x1b0Di\x15__termul_complete audit 7 {} {hex}\r",
            draft.len()
        )
        .as_bytes(),
    );
    live.completion_until_idle().0
}

#[test]
fn nested_directory_completion_replaces_the_whole_word() {
    let mut previous = None;
    for shell in shells() {
        let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
        std::fs::create_dir_all(home.path().join("outer/inner-dir")).unwrap();
        let mut live = LiveShell::with_home(&shell, home, true);
        live.handshake();
        live.read_until_idle();
        let frames = request(&mut live, "cd outer/in");
        let [Frame::Completion(result)] = frames.as_slice() else {
            panic!("{shell:?}: {frames:?}");
        };
        let candidates: std::collections::BTreeSet<String> = result
            .output
            .lines()
            .map(|line| {
                String::from_utf8(
                    line.as_bytes()
                        .chunks(2)
                        .map(|pair| {
                            u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap()
                        })
                        .collect(),
                )
                .unwrap()
            })
            .collect();
        println!("{shell:?}: {candidates:?}");
        assert!(
            candidates.iter().all(|word| word.starts_with("outer/")),
            "{shell:?}: candidates must replace the whole word: {candidates:?}"
        );
        assert!(
            candidates.contains("outer/inner-dir") || candidates.contains("outer/inner-dir/"),
            "{shell:?}: missing nested directory: {candidates:?}"
        );
        if let Some((previous_shell, previous_candidates)) = &previous {
            assert_eq!(
                &candidates, previous_candidates,
                "{shell:?} and {previous_shell:?} must return identical candidate sets"
            );
        }
        previous = Some((shell, candidates));
    }
}

#[test]
fn zsh_completion_preserves_insertion_affixes() {
    let Some(shell) = on_path("zsh") else {
        return;
    };
    let mut live = LiveShell::spawn(&shell);
    live.handshake();
    live.read_until_idle();
    live.write(b"_affixes() { IPREFIX=state/; ISUFFIX=.state; compadd -UPadded/ -Punused/ -iignored/ -phidden/ -s.hidden -S.added -I.ignored -- body; }; compdef _affixes affixes\r");
    live.frames_until_prompt();
    let frames = request(&mut live, "affixes ");
    let [Frame::Completion(result)] = frames.as_slice() else {
        panic!("{shell:?}: {frames:?}");
    };
    // -U excludes IPREFIX/ISUFFIX; compadd uses the first repeated option.
    let expected: String = "ignored/added/hidden/body.hidden.added.ignored"
        .bytes()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(result.output.trim_end_matches('\n'), expected);
    live.write(
        b"_affixes() { IPREFIX=state/; ISUFFIX=.state; PREFIX=bo; SUFFIX=; compadd -- body; }\r",
    );
    live.frames_until_prompt();
    let frames = request(&mut live, "affixes state/bo");
    let [Frame::Completion(result)] = frames.as_slice() else {
        panic!("{shell:?}: {frames:?}");
    };
    let expected: String = "state/body.state"
        .bytes()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(result.output.trim_end_matches('\n'), expected);
}

#[test]
fn audit_1_completion_frame_byte_budget() {
    for shell in shells() {
        let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
        let names: Vec<String> = (0..200)
            .map(|n| format!("sp{n:03}{}", "x".repeat(195)))
            .collect();
        for name in &names {
            std::fs::create_dir(home.path().join(name)).unwrap();
        }
        let expected = if shell.ends_with("bash") {
            let output = std::process::Command::new(&shell)
                .args(["--noprofile", "--norc", "-c", "compgen -d -- sp"])
                .current_dir(home.path())
                .output()
                .unwrap();
            String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .map(str::to_string)
                .collect::<Vec<_>>()
        } else {
            names
        };
        let mut live = LiveShell::with_home(&shell, home, true);
        live.handshake();
        live.read_until_idle();
        let frames = request(&mut live, "cd sp");
        assert_eq!(frames.len(), 1, "{frames:?}");
        let Frame::Completion(result) = &frames[0] else {
            panic!("{frames:?}");
        };
        let decoded: Vec<String> = result
            .output
            .lines()
            .map(|line| {
                String::from_utf8(
                    line.as_bytes()
                        .chunks(2)
                        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
                        .collect(),
                )
                .unwrap()
            })
            .collect();
        assert!(!decoded.is_empty());
        assert!(decoded.len() < 200);
        assert_eq!(decoded, expected[..decoded.len()]);
    }
}

#[test]
fn audit_2_zsh_restores_completion_state() {
    let Some(shell) = on_path("zsh") else {
        return;
    };
    let mut live = LiveShell::spawn(&shell);
    live.handshake();
    live.read_until_idle();
    live.write(b"unsetopt extendedglob; export TERMUL_CHANGED=before TERMUL_REMOVED=before; original=$PWD; _audit() { cd /; export TERMUL_LEAK=1 TERMUL_CHANGED=after; unset TERMUL_REMOVED; setopt extendedglob; compadd spike; }; compdef _audit auditcmd\r");
    live.frames_until_prompt();
    let frames = request(&mut live, "auditcmd sp");
    assert_eq!(frames.len(), 1);
    live.forwarded.clear();
    live.write(b"print -r -- CHECK $([[ $PWD = $original ]] && print yes) $+TERMUL_LEAK $options[extendedglob] $TERMUL_CHANGED $TERMUL_REMOVED\r");
    live.frames_until_prompt();
    assert!(
        String::from_utf8_lossy(&live.forwarded).contains("CHECK yes 0 off before before"),
        "state leaked: {:?}",
        String::from_utf8_lossy(&live.forwarded)
    );
}

#[test]
fn audit_3_history_policy_survives_user_assignment() {
    for shell in shells().into_iter().filter(|s| s.ends_with("bash")) {
        let mut live = LiveShell::spawn(&shell);
        live.handshake();
        live.read_until_idle();
        live.write(b"HISTIGNORE='ls'\r");
        live.frames_until_prompt();
        live.write(b"echo one\r");
        live.frames_until_prompt();
        request(&mut live, "cd sp");
        live.forwarded.clear();
        live.write(b"fc -ln -1\r");
        live.frames_until_prompt();
        let output = String::from_utf8_lossy(&live.forwarded);
        assert!(
            output
                .split(['\r', '\n'])
                .any(|line| line.trim() == "echo one"),
            "history leak: {output:?}"
        );
        live.write(b"printf 'POLICY:%s\\n' \"$HISTIGNORE\"\r");
        live.frames_until_prompt();
        assert!(String::from_utf8_lossy(&live.forwarded).contains("POLICY:ls:__termul_complete*"));
    }
}

#[test]
fn round3_1_bash_history_exclusion_survives_prompt_hook() {
    for shell in shells().into_iter().filter(|s| s.ends_with("bash")) {
        let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
        std::fs::write(home.path().join(".bash_profile"), "PROMPT_COMMAND=(true)\n").unwrap();
        let mut live = LiveShell::with_home(&shell, home, true);
        live.handshake();
        live.read_until_idle();
        live.write(b"PROMPT_COMMAND+=( \"HISTIGNORE=ls\" )\r");
        live.frames_until_prompt();
        live.write(b"echo one\r");
        live.frames_until_prompt();
        live.write(b"\x15__termul_complete r1 1 2 6563\r");
        let (frames, _) = live.completion_until_idle();
        assert!(matches!(frames.as_slice(), [Frame::Completion(_)]));
        live.forwarded.clear();
        live.write(b"fc -ln -1\r");
        live.frames_until_prompt();
        let output = String::from_utf8_lossy(&live.forwarded);
        assert!(
            output
                .split(['\r', '\n'])
                .any(|line| line.trim() == "echo one"),
            "{shell:?}: history leak: {output:?}"
        );
        live.forwarded.clear();
        live.write(b"printf 'POLICY:%s\\n' \"$HISTIGNORE\"\r");
        live.frames_until_prompt();
        assert!(String::from_utf8_lossy(&live.forwarded).contains("POLICY:ls:__termul_complete*"));
    }
}

#[test]
fn round3_2_bash_adopts_command_time_ps1() {
    assert_bash_adopts_ps1("new> ", false);
}

#[test]
fn round3_2_bash_keeps_ps1_through_suppressed_prompts() {
    assert_bash_adopts_ps1("v> ", true);
}

fn assert_bash_adopts_ps1(prompt: &str, extra_suppressed_cycle: bool) {
    for shell in shells().into_iter().filter(|s| s.ends_with("bash")) {
        let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
        std::fs::write(home.path().join(".bash_profile"), "PS1='USERPS1$ '\n").unwrap();
        let mut live = LiveShell::with_home(&shell, home, true);
        live.handshake();
        live.read_until_idle();
        live.write(format!("PS1=\"{prompt}\"\r").as_bytes());
        let frames = live.frames_until_prompt();
        assert!(frames.iter().any(|f| matches!(
            f,
            Frame::PromptReady {
                prompt_suppressed: true,
                ..
            }
        )));
        if extra_suppressed_cycle {
            live.write(b"true\r");
            live.frames_until_prompt();
        }
        // Repeat recovery to catch adoption of our own armed or empty PS1 values.
        for _ in 0..2 {
            live.forwarded.clear();
            live.write(b"PROMPT_COMMAND+=( true )\r");
            let frames = live.frames_until_prompt();
            assert!(frames.iter().any(|f| matches!(
                f,
                Frame::PromptReady {
                    prompt_suppressed: false,
                    ..
                }
            )));
            let output = String::from_utf8_lossy(&live.forwarded);
            assert!(
                output.contains(prompt) && !output.contains("USERPS1$ "),
                "{shell:?}: expected visible {prompt:?}, got {output:?}"
            );
            live.forwarded.clear();
            live.write(b"true\r");
            let frames = live.frames_until_prompt();
            assert!(frames.iter().any(|f| matches!(
                f,
                Frame::PromptReady {
                    prompt_suppressed: true,
                    ..
                }
            )));
            assert!(!String::from_utf8_lossy(&live.forwarded).contains(prompt));
        }
    }
}

#[test]
fn round3_3_bash_failed_bootstrap_removes_startup_directory() {
    for shell in shells().into_iter().filter(|s| s.ends_with("bash")) {
        let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
        std::fs::write(
            home.path().join(".bash_profile"),
            "PS1='ro> '; readonly PS1\n",
        )
        .unwrap();
        let mut live = LiveShell::with_home(&shell, home.clone(), true);
        let directory = home
            .path()
            .join(format!("termul-shell-{}", live.session_id));
        let mut frames = live.read_until_idle();
        live.forwarded.clear();
        live.write(b"printf 'SHELL_USABLE:%s\\n' \"${__termul_startup_directory-unset}\"\r");
        frames.extend(live.read_until_idle());
        assert!(
            frames.is_empty(),
            "failed bootstrap claimed integration: {frames:?}"
        );
        let output = String::from_utf8_lossy(&live.forwarded);
        assert!(
            output.contains("SHELL_USABLE:unset\r\n") && output.contains("ro> "),
            "shell unusable: {shell:?}: {output:?}"
        );
        assert!(
            !directory.exists(),
            "failed bootstrap leaked startup directory: {shell:?}: {directory:?}"
        );
    }
}

#[test]
fn audit_4_unsuppressed_prompt_and_lifecycle() {
    for shell in shells() {
        let zsh = shell.ends_with("zsh");
        let updates: &[&[u8]] = if zsh {
            &[b"audit_hook() { true; }; precmd_functions+=(audit_hook)\r"]
        } else {
            &[
                b"PROMPT_COMMAND+=( true )\r",
                b"PROMPT_COMMAND=\"$PROMPT_COMMAND; true\"\r",
            ]
        };
        for update in updates {
            let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
            std::fs::write(
                home.path()
                    .join(if zsh { ".zshrc" } else { ".bash_profile" }),
                if zsh {
                    "PROMPT='audit-visible> '\n"
                } else {
                    "PS1='audit-visible> '\n"
                },
            )
            .unwrap();
            let mut live = LiveShell::with_home(&shell, home, true);
            live.handshake();
            live.read_until_idle();
            live.forwarded.clear();
            live.write(update);
            let frames = live.frames_until_prompt();
            assert!(
                frames.iter().any(|f| matches!(
                    f,
                    Frame::PromptReady {
                        prompt_suppressed: false,
                        ..
                    }
                )),
                "{shell:?}: {frames:?}"
            );
            assert_eq!(
                frames
                    .iter()
                    .filter(|f| matches!(f, Frame::CommandStarted { .. }))
                    .count(),
                1,
                "spurious start: {frames:?}"
            );
            assert!(
                String::from_utf8_lossy(&live.forwarded).contains("audit-visible> "),
                "prompt hidden: {shell:?}"
            );
            live.write(b"false\r");
            let frames = live.frames_until_prompt();
            assert!(
                matches!(frames.first(), Some(Frame::CommandStarted { .. })),
                "{shell:?}: {frames:?}"
            );
            assert!(
                matches!(
                    frames.get(1),
                    Some(Frame::CommandFinished {
                        exit_code: Some(1),
                        ..
                    })
                ),
                "{shell:?}: {frames:?}"
            );
        }
    }
}

#[test]
fn audit_5_readonly_prompt_stays_raw() {
    for shell in shells() {
        let zsh = shell.ends_with("zsh");
        let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
        std::fs::write(
            home.path()
                .join(if zsh { ".zshrc" } else { ".bash_profile" }),
            if zsh {
                "typeset -r PROMPT='ro> '\n"
            } else {
                "PS1='ro> '; readonly PS1\n"
            },
        )
        .unwrap();
        let mut live = LiveShell::with_home(&shell, home, true);
        let mut frames = live.read_until_idle();
        live.write(b"printf 'SHELL_USABLE\\n'\r");
        frames.extend(live.read_until_idle());
        assert!(
            !frames.iter().any(|f| matches!(
                f,
                Frame::InitShell { .. }
                    | Frame::PromptReady {
                        prompt_suppressed: true,
                        ..
                    }
            )),
            "readonly prompt claimed: {shell:?}: {frames:?}"
        );
        let output = String::from_utf8_lossy(&live.forwarded);
        assert!(
            output.contains("ro> ") && output.contains("SHELL_USABLE\r\n"),
            "{shell:?}: {output:?}"
        );
    }
}

#[test]
fn audit_6_irreversible_bindings_are_last() {
    let source = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/shell-integration/bash.sh"
    ))
    .unwrap();
    let bootstrap = source
        .split("__termul_bootstrap() {")
        .nth(1)
        .unwrap()
        .split("\n}")
        .next()
        .unwrap();
    let install = bootstrap
        .find("__termul_bind_restore_prompt || return 1")
        .unwrap();
    assert!(
        !bootstrap[install + "__termul_bind_restore_prompt || return 1".len()..]
            .contains("return 1"),
        "fallible check after irreversible bind -x"
    );
}

#[test]
fn audit_7_bash_completion_tokenization() {
    let source = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/shell-integration/bash.sh"
    ))
    .unwrap();
    let functions = source
        .split("# Original Termul session protocol helpers.")
        .nth(1)
        .unwrap()
        .split("# Install at script scope:")
        .next()
        .unwrap();
    for shell in shells().into_iter().filter(|s| s.ends_with("bash")) {
        let dir = tempfile::tempdir().unwrap();
        let probe = dir.path().join("probe");
        let script = format!(
            r#"{functions}
_probe() {{ printf '%s\n' "$COMP_CWORD" "$COMP_POINT" "${{COMP_WORDS[@]}}" > "$PROBE"; }}
complete -F _probe git cat
__termul_candidates "$DRAFT"
"#
        );
        for (draft, expected) in [
            (
                "git -C \"/tmp/a b\" sta",
                "3\n21\ngit\n-C\n\"/tmp/a b\"\nsta\n",
            ),
            ("cat a\\ b c", "2\n10\ncat\na\\ b\nc\n"),
            ("cat 'a b' ", "2\n10\ncat\n'a b'\n\n"),
            ("cat a\\ ", "1\n7\ncat\na\\ \n"),
        ] {
            let output = std::process::Command::new(&shell)
                .args(["--noprofile", "--norc", "-c", &script])
                .env("DRAFT", draft)
                .env("PROBE", &probe)
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
            assert_eq!(
                std::fs::read_to_string(&probe).unwrap(),
                expected,
                "{shell:?}: {draft}"
            );
        }
    }
}

#[test]
fn audit_8_install_is_focused_and_atomic() {
    use super::inject::{injection_plan, install, InjectionPlan};
    let source = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/pty/session_protocol/inject.rs"
    ))
    .unwrap();
    let body = source
        .split("pub fn install(")
        .nth(1)
        .unwrap()
        .split("\n}\n")
        .next()
        .unwrap();
    assert!(
        body.lines().count() <= 50,
        "install exceeds 50 lines: {}",
        body.lines().count()
    );
    let root = tempfile::tempdir().unwrap();
    let base = root.path().join("startup");
    std::fs::create_dir(&base).unwrap();
    let plan = injection_plan("zsh", None);
    let InjectionPlan::Inject(injection) = &plan else {
        panic!();
    };
    let mut command = portable_pty::CommandBuilder::new("zsh");
    command.arg("sentinel");
    command.env("SENTINEL", "keep");
    let before = format!("{command:?}");
    let env = std::collections::HashMap::new();
    assert!(install(&plan, &base, &env, &mut command).is_err());
    assert_eq!(format!("{command:?}"), before);
    assert!(!base
        .join(format!("termul-shell-{}", injection.session_id))
        .exists());
}

#[test]
fn audit_9_binding_rollback_preserves_all_keymaps() {
    super::inject_test_support::assert_bash_binding_rollback();
}

#[test]
fn audit_10_successful_bootstrap_removes_startup_directory() {
    for shell in shells() {
        let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
        let mut live = LiveShell::with_home(&shell, home.clone(), true);
        let directory = home
            .path()
            .join(format!("termul-shell-{}", live.session_id));
        live.handshake();
        live.read_until_idle();
        assert!(
            !directory.exists(),
            "startup directory leaked: {shell:?}: {directory:?}"
        );
    }
}

#[test]
fn audit_11_zdotdir_scratch_is_unset() {
    let Some(shell) = on_path("zsh") else {
        return;
    };
    for failure in [false, true] {
        let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
        if failure {
            std::fs::write(home.path().join(".zshrc"), "bindkey() { return 1; }\n").unwrap();
        }
        let mut live = LiveShell::with_home(&shell, home, true);
        if failure {
            live.read_until_idle();
        } else {
            live.handshake();
            live.read_until_idle();
        }
        live.forwarded.clear();
        live.write(b"print -r -- SCRATCH:$+__termul_user_zdotdir\r");
        live.read_until_idle();
        assert!(
            String::from_utf8_lossy(&live.forwarded).contains("SCRATCH:0\r\n"),
            "scratch leaked: {:?}",
            String::from_utf8_lossy(&live.forwarded)
        );
    }
}

#[test]
fn audit_8_forced_write_failure_keeps_command_untouched() {
    const CHILD: &str = "TERMUL_AUDIT_WRITE_FAILURE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "pty::session_protocol::inject_completion_tests::audit_8_forced_write_failure_keeps_command_untouched", "--nocapture"])
            .env(CHILD, "1").output().unwrap();
        assert!(output.status.success(), "{output:?}");
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let plan = super::inject::injection_plan("bash", None);
    let super::inject::InjectionPlan::Inject(injection) = &plan else {
        panic!();
    };
    let mut command = portable_pty::CommandBuilder::new("bash");
    command.arg("sentinel");
    command.env("SENTINEL", "keep");
    let before = format!("{command:?}");
    // Limit only this child process: writing the startup script must fail with EFBIG.
    unsafe {
        let mut limit = std::mem::zeroed::<libc::rlimit>();
        assert_eq!(libc::getrlimit(libc::RLIMIT_FSIZE, &mut limit), 0);
        limit.rlim_cur = 1;
        assert_eq!(libc::setrlimit(libc::RLIMIT_FSIZE, &limit), 0);
        libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
    }
    let error = super::inject::install(
        &plan,
        directory.path(),
        &std::collections::HashMap::new(),
        &mut command,
    )
    .unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EFBIG));
    assert_eq!(format!("{command:?}"), before);
    assert!(!directory
        .path()
        .join(format!("termul-shell-{}", injection.session_id))
        .exists());
}

#[test]
fn round4_1_reclaim_ps1_suffix_preserves_first_command_lifecycle() {
    for shell in shells().into_iter().filter(|s| s.ends_with("bash")) {
        let mut live = LiveShell::spawn(&shell);
        live.handshake();
        live.read_until_idle();
        live.forwarded.clear();
        live.write(b"PROMPT_COMMAND+=( 'PS1=\"s> \"' )\r");
        let frames = live.frames_until_prompt();
        assert!(
            matches!(
                frames.as_slice(),
                [
                    Frame::CommandStarted { .. },
                    Frame::CommandFinished {
                        exit_code: Some(0),
                        ..
                    },
                    Frame::PromptReady {
                        prompt_suppressed: false,
                        ..
                    }
                ]
            ),
            "{shell:?}: {frames:?}"
        );
        assert!(String::from_utf8_lossy(&live.forwarded).contains("s> "));
        for _ in 0..2 {
            live.write(b"false\r");
            let frames = live.frames_until_prompt();
            assert!(
                matches!(
                    frames.as_slice(),
                    [
                        Frame::CommandStarted { .. },
                        Frame::CommandFinished {
                            exit_code: Some(1),
                            ..
                        },
                        Frame::PromptReady {
                            prompt_suppressed: true,
                            ..
                        }
                    ]
                ),
                "{shell:?}: {frames:?}"
            );
        }
    }
}

#[test]
fn round4_4_zsh_failed_bootstrap_removes_startup_directory() {
    let Some(shell) = on_path("zsh") else {
        return;
    };
    let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
    std::fs::write(home.path().join(".zshrc"), "typeset -r PROMPT='ro> '\n").unwrap();
    let mut live = LiveShell::with_home(&shell, home.clone(), true);
    let directory = home
        .path()
        .join(format!("termul-shell-{}", live.session_id));
    let mut frames = live.read_until_idle();
    live.forwarded.clear();
    live.write(b"print -r -- SHELL_USABLE:$+__termul_startup_session_id:$+__termul_session_id\r");
    frames.extend(live.read_until_idle());
    assert!(
        frames.is_empty(),
        "failed bootstrap claimed integration: {frames:?}"
    );
    let output = String::from_utf8_lossy(&live.forwarded);
    assert!(
        output.contains("SHELL_USABLE:0:0\r\n") && output.contains("ro> "),
        "{output:?}"
    );
    assert!(
        !directory.exists(),
        "failed bootstrap leaked startup directory: {directory:?}"
    );
}

#[test]
fn legacy_bash_stays_raw_without_binding_mutation() {
    super::inject_test_support::assert_legacy_bash_stays_raw();
}

#[test]
fn round5_second_private_bind_failure_stays_raw() {
    super::inject_test_support::assert_second_private_bind_failure();
}

#[test]
fn round4_2_prompt_preflight_precedes_binding_mutations() {
    for shell in shells().into_iter().filter(|s| s.ends_with("bash")) {
        let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
        std::fs::write(
            home.path().join(".bash_profile"),
            r#"
readonly PROMPT_COMMAND=true
bind() {
    case "$*" in
        *kill-whole-line*|*__termul_restore_prompt*) printf 'MUTATED\n' >> "$HOME/mutations" ;;
    esac
    builtin bind "$@"
}
"#,
        )
        .unwrap();
        let mut live = LiveShell::with_home(&shell, home.clone(), true);
        assert!(live.read_until_idle().is_empty());
        live.forwarded.clear();
        live.write(b"printf 'PREFLIGHT_RAW\n'\r");
        assert!(live.read_until_idle().is_empty());
        assert!(String::from_utf8_lossy(&live.forwarded).contains("PREFLIGHT_RAW\r\n"));
        assert!(
            !home.path().join("mutations").exists(),
            "{shell:?}: binding mutated before prompt preflight"
        );
    }
}
