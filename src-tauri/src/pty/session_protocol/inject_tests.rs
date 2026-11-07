use super::inject::{injection_plan, InjectionPlan, ShellKind};

#[cfg(not(target_os = "windows"))]
fn bash_paths() -> Vec<std::path::PathBuf> {
    let mut shells =
        vec![super::inject_test_support::on_path("bash").expect("bash must be on PATH")];
    let system = std::path::PathBuf::from("/bin/bash");
    if system.is_file() && !shells.contains(&system) {
        shells.push(system);
    }
    shells.retain(|shell| super::inject_test_support::bash_supports_integration(shell));
    shells
}

#[cfg(not(target_os = "windows"))]
#[test]
fn bash_reclaims_an_appended_prompt_command() {
    use super::frame::Frame;
    use super::inject_test_support::LiveShell;
    for shell in bash_paths() {
        let updates: &[&[u8]] = &[
            b"PROMPT_COMMAND=\"$PROMPT_COMMAND; PS1='termul-after$ '\"\r",
            b"PROMPT_COMMAND=(\"$PROMPT_COMMAND\" \" ; PS1='termul-after$ '; \" \"termul_array_hook=ran\")\r",
            b"PROMPT_COMMAND=(__termul_prompt 'eval \"$__termul_prompt_tail\"' \" ; PS1='termul-after$ '; \" termul_array_hook=ran)\r",
        ];
        for update in updates {
            let mut live = LiveShell::spawn(&shell);
            live.handshake();
            assert!(live.read_until_idle().is_empty());
            live.write(update);
            let frames = live.frames_until_prompt();
            let prompt = frames
                .iter()
                .position(|frame| matches!(frame, Frame::PromptReady { .. }))
                .unwrap();
            assert!(
                matches!(
                    frames[prompt],
                    Frame::PromptReady {
                        prompt_suppressed: false,
                        ..
                    }
                ),
                "{shell:?}: {frames:?}"
            );
            assert!(
                !frames[prompt + 1..]
                    .iter()
                    .any(|frame| matches!(frame, Frame::CommandStarted { .. })),
                "{shell:?}: spurious start: {frames:?}"
            );
            live.forwarded.clear();
            live.write(b"true\r");
            let frames = live.frames_until_prompt();
            assert!(
                frames.iter().any(|frame| matches!(
                    frame,
                    Frame::PromptReady {
                        prompt_suppressed: true,
                        ..
                    }
                )),
                "{shell:?}: {frames:?}"
            );
            assert!(
                !live
                    .forwarded
                    .windows(b"termul-after$ ".len())
                    .any(|bytes| bytes == b"termul-after$ "),
                "{shell:?}: {:?}",
                String::from_utf8_lossy(&live.forwarded)
            );
            let prompt = frames
                .iter()
                .position(|frame| matches!(frame, Frame::PromptReady { .. }))
                .unwrap();
            assert!(
                !frames[prompt + 1..]
                    .iter()
                    .any(|frame| matches!(frame, Frame::CommandStarted { .. })),
                "{shell:?}: spurious start: {frames:?}"
            );
            // A trusted prompt must rearm lifecycle reporting after recovery.
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
            if update
                .windows(b"termul_array_hook".len())
                .any(|bytes| bytes == b"termul_array_hook")
            {
                live.forwarded.clear();
                live.write(b"echo $termul_array_hook\r");
                live.frames_until_prompt();
                assert!(
                    String::from_utf8_lossy(&live.forwarded)
                        .split(['\r', '\n'])
                        .any(|line| line == "ran"),
                    "{shell:?}: {:?}",
                    String::from_utf8_lossy(&live.forwarded)
                );
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
#[test]
fn bash_keeps_lifecycle_after_a_foreign_debug_trap() {
    use super::frame::Frame;
    use super::inject_test_support::LiveShell;
    for shell in bash_paths() {
        let mut live = LiveShell::spawn(&shell);
        live.handshake();
        assert!(live.read_until_idle().is_empty());
        live.write(b"trap 'termul_foreign=1' DEBUG\r");
        live.frames_until_prompt();
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
        live.forwarded.clear();
        live.write(b"echo $termul_foreign\r");
        live.frames_until_prompt();
        assert!(
            String::from_utf8_lossy(&live.forwarded)
                .split(['\r', '\n'])
                .any(|line| line == "1"),
            "{shell:?}: {:?}",
            String::from_utf8_lossy(&live.forwarded)
        );
    }
}

#[cfg(not(target_os = "windows"))]
#[test]
fn bash_failed_bootstrap_restores_prompt_and_debug_ownership() {
    for shell in bash_paths() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join(".bash_profile"), "bind() { return 1; }\n").unwrap();
        let output = std::process::Command::new(&shell)
            .args([
                "--noprofile",
                "--norc",
                "-i",
                "-c",
                r#"
PROMPT_COMMAND=('printf user' 'true')
trap 'foreign=1' DEBUG
before_prompt=$(declare -p PROMPT_COMMAND)
before_trap=$(trap -p DEBUG)
. "$1"
[ "$(declare -p PROMPT_COMMAND)" = "$before_prompt" ] || exit 2
[ "$(trap -p DEBUG)" = "$before_trap" ] || exit 3
[ -z "$(compgen -A variable __termul_)" ] || exit 4
[ -z "$(compgen -A function __termul_)" ] || exit 5
"#,
                "termul-rollback",
                concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/resources/shell-integration/bash.sh"
                ),
            ])
            .env("HOME", home.path())
            .env("TERMUL_SESSION_ID", "rollback-session")
            .env("TERMUL_SESSION_NONCE", "rollback-nonce")
            .output()
            .unwrap();
        assert!(output.status.success(), "{shell:?}: {output:?}");
    }
}

#[cfg(not(target_os = "windows"))]
#[test]
fn bash_handshake_reports_suppression() {
    use super::frame::Frame;
    use super::inject_test_support::{on_path, LiveShell};
    let bash = on_path("bash").expect("bash must be on PATH");
    let mut shells = vec![bash];
    shells.retain(|shell| super::inject_test_support::bash_supports_integration(shell));
    if let Some(zsh) = on_path("zsh") {
        shells.push(zsh);
    }
    for shell in shells {
        let mut live = LiveShell::spawn(&shell);
        let frames = live.handshake();
        assert_eq!(
            frames[0],
            Frame::InitShell {
                session_id: live.session_id.clone(),
                nonce: live.nonce.clone(),
            },
            "{shell:?}: first frame must authenticate the plan"
        );
        assert!(
            matches!(&frames[1], Frame::PromptReady {
            nonce, line_empty: true, prompt_suppressed: true, ..
        } if nonce == &live.nonce),
            "{shell:?}: {frames:?}"
        );
    }
}

fn scripts() -> [(String, &'static str); 2] {
    [
        (
            std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/resources/shell-integration/bash.sh"
            ))
            .unwrap(),
            "bash",
        ),
        (
            std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/resources/shell-integration/zsh.sh"
            ))
            .unwrap(),
            "zsh",
        ),
    ]
}

#[test]
fn visible_prompt_is_zero_width() {
    for (source, shell) in scripts() {
        let (saved, empty) = if shell == "bash" {
            ("__termul_saved_prompt=$PS1", "PS1=''")
        } else {
            ("__termul_saved_prompt=$PROMPT", "PROMPT=''")
        };
        let hook = source
            .split("__termul_prompt() {")
            .nth(1)
            .unwrap()
            .split("\n}")
            .next()
            .unwrap();
        let save = hook
            .find(saved)
            .unwrap_or_else(|| panic!("{shell}: original prompt is not saved"));
        let replace = hook
            .find(empty)
            .unwrap_or_else(|| panic!("{shell}: visible prompt is not empty"));
        assert!(
            save < replace,
            "{shell}: preserve prompt before suppressing it"
        );
    }
}

#[test]
fn restore_sequence_brings_the_prompt_back() {
    let sequence = super::RESTORE_PROMPT_SEQUENCE.replace('\u{1b}', "\\e");
    for (source, shell) in scripts() {
        let bindings = source
            .split("__termul_bind_restore_prompt() {")
            .nth(1)
            .unwrap_or_else(|| panic!("{shell}: missing restore-sequence bindings"))
            .split("\n}")
            .next()
            .unwrap();
        let maps = if shell == "bash" {
            ["emacs", "vi-insert", "vi-command"]
        } else {
            ["emacs", "viins", "vicmd"]
        };
        for map in maps {
            let expected = if shell == "bash" {
                format!("bind -m {map} -x '\"{sequence}\": __termul_restore_prompt' || return 1")
            } else {
                format!("bindkey -M {map} $'{sequence}' __termul_restore_prompt || return 1")
            };
            assert!(
                bindings.lines().any(|line| line.trim() == expected),
                "{shell}: missing {expected}"
            );
        }
        let body: Vec<_> = source
            .split("__termul_restore_prompt() {")
            .nth(1)
            .unwrap_or_else(|| panic!("{shell}: missing prompt restore function"))
            .split("\n}")
            .next()
            .unwrap()
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        let expected = if shell == "bash" {
            vec!["PS1=$__termul_saved_prompt"]
        } else {
            assert!(bindings.contains("zle -N __termul_restore_prompt || return 1"));
            vec![
                "PROMPT=$__termul_saved_prompt",
                "RPROMPT=$__termul_saved_rprompt",
                "zle reset-prompt",
            ]
        };
        assert_eq!(
            body, expected,
            "{shell}: restore only the saved prompt, never command text"
        );
        assert!(source.contains("__termul_bind_restore_prompt || return 1"));
        let rollback = source
            .split("__termul_restore_bindings() {")
            .nth(1)
            .unwrap()
            .split("\n}")
            .next()
            .unwrap();
        // Bash rollback is exercised across all keymaps by the live audit_9 test.
        if shell == "zsh" {
            for index in 3..6 {
                assert!(source.contains(&format!("__termul_old_{index}=$(bindkey")));
                assert!(rollback.contains(&format!("$__termul_old_{index}")));
            }
            assert!(
                source.contains("__termul_paste_saved=1"),
                "zsh: snapshot sets paste saved marker"
            );
            assert!(
                rollback.contains("__termul_paste_saved"),
                "zsh: paste restore guarded on snapshot marker"
            );
            assert!(
                rollback.contains("zle_bracketed_paste"),
                "zsh: restore snapshot of zle_bracketed_paste"
            );
            assert!(
                rollback.contains("$__termul_old_paste_0"),
                "zsh: restore snapshot of bracketed-paste bindings"
            );
        } else {
            assert!(
                rollback.contains("__termul_bindings_changed"),
                "bash: restore guarded on bindings-changed marker"
            );
            assert!(
                rollback.contains("__termul_old_enable_bracketed_paste"),
                "bash: restore snapshot of enable-bracketed-paste"
            );
        }
    }
}

#[test]
fn generator_is_not_a_user_command() {
    for (source, shell) in scripts() {
        let branch = source
            .split("# Generator preexec path.")
            .nth(1)
            .unwrap_or_else(|| panic!("{shell}: missing generator preexec path"))
            .split("# User preexec path.")
            .next()
            .unwrap();
        assert!(
            branch.contains("__termul_complete\\ *"),
            "{shell}: generator prefix"
        );
        assert!(
            branch.contains("__termul_generator=1"),
            "{shell}: generator flag"
        );
        assert!(
            branch.contains("return 0"),
            "{shell}: generator returns before user path"
        );
        assert!(
            !branch.contains("CommandStarted"),
            "{shell}: generator emits no user start"
        );
        assert!(source.contains(r#"{"type":"PromptReady","nonce":"%s","prompt_generation":%s,"line_empty":true,"prompt_suppressed":%s,"cwd":"%s"}"#), "{shell}: complete PromptReady fields");
        assert!(source.contains("__termul_json_escape \"$__termul_nonce\""));
        assert!(source.contains("__termul_json_escape \"$PWD\""));
        assert!(source.contains("__termul_prompt_generation=$((__termul_prompt_generation + 1))"));
        assert!(source.contains("printf '\\033]9477;%s\\007' \"$1\""));
    }
}

#[test]
fn bootstrap_failure_keeps_the_shell() {
    for (source, shell) in scripts() {
        let failure = source
            .split("# Bootstrap failure: keep the current shell.")
            .nth(1)
            .unwrap_or_else(|| panic!("{shell}: missing bootstrap-failure path"));
        assert!(failure.contains("__termul_bootstrap || {"));
        assert!(failure.contains("unset __termul_session_id __termul_nonce"));
        assert!(failure.contains("return 0"));
        assert!(!failure.contains("__termul_frame"));
        assert!(source
            .contains("[ -n \"$__termul_session_id\" ] && [ -n \"$__termul_nonce\" ] || return 1"));
        for line in source.lines() {
            let command = line.trim_start();
            assert!(
                !command.starts_with("exec ")
                    && command != "exec"
                    && !command.starts_with("exit ")
                    && command != "exit",
                "{shell}: replaces or terminates shell"
            );
        }
        let capture = source
            .find("unset TERMUL_SESSION_ID TERMUL_SESSION_NONCE")
            .unwrap();
        if shell == "bash" {
            let system_profile = source
                .find("[ ! -r /etc/profile ] || . /etc/profile")
                .expect("bash login system profile");
            let user_profile = source.find("for __termul_startup_file in \"$HOME/.bash_profile\" \"$HOME/.bash_login\" \"$HOME/.profile\"").expect("bash login user profiles");
            assert!(capture < system_profile && system_profile < user_profile);
            assert!(source.contains(". \"$__termul_startup_file\"\n        break"));
            assert!(user_profile < source.find("__termul_bootstrap()").unwrap());
        }
    }
}

#[test]
fn clear_line_sequence_is_bound() {
    let sequence = super::CLEAR_LINE_SEQUENCE.replace('\u{1b}', "\\e");
    for (source, shell) in scripts() {
        let (command, maps) = if shell == "bash" {
            ("bind -m", ["emacs", "vi-insert", "vi-command"])
        } else {
            ("bindkey -M", ["emacs", "viins", "vicmd"])
        };
        let binding = source
            .split("__termul_bind_clear_line() {")
            .nth(1)
            .unwrap_or_else(|| panic!("{shell}: missing clear-line bindings"))
            .split("\n}")
            .next()
            .unwrap();
        let lines: Vec<_> = binding
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with(command))
            .collect();
        assert_eq!(
            lines.len(),
            maps.len(),
            "{shell}: bind every declared keymap"
        );
        for map in maps {
            let expected = if shell == "bash" && map == "vi-command" {
                format!("bind -m {map} '\"{sequence}\": \"0Di\"' || return 1")
            } else if shell == "bash" {
                format!("bind -m {map} '\"{sequence}\": kill-whole-line' || return 1")
            } else {
                format!("bindkey -M {map} $'{sequence}' __termul_clear_line || return 1")
            };
            assert!(
                lines.contains(&expected.as_str()),
                "{shell}: missing exact binding: {expected}"
            );
        }
        assert!(
            !binding.contains("-x"),
            "{shell}: clear-line must not execute command text"
        );
        assert!(source.contains("__termul_bind_clear_line || return 1"));
    }
}

#[test]
fn other_programs_stay_raw() {
    for path in [
        "/bin/fish",
        "/bin/dash",
        "/bin/sh",
        "/usr/bin/ssh",
        "pwsh",
        "PowerShell",
        "cmd",
        "/usr/bin/python3",
        "BASH",
        "",
        "/bin/bash-helper",
    ] {
        assert!(
            matches!(injection_plan(path, None), InjectionPlan::Raw),
            "{path} must stay raw"
        );
    }
    for shell in ["/bin/bash", "/bin/zsh"] {
        for program in ["ssh", "fish", "bash", "zsh", "python3", ""] {
            assert!(
                matches!(injection_plan(shell, Some(program)), InjectionPlan::Raw),
                "custom program {program:?} must stay raw"
            );
        }
    }
}

#[test]
fn bash_and_zsh_are_injected() {
    for (path, kind, source) in [
        ("/bin/bash", ShellKind::Bash, "bash.sh"),
        ("/bin/zsh", ShellKind::Zsh, "zsh.sh"),
    ] {
        let InjectionPlan::Inject(first) = injection_plan(path, None) else {
            panic!("{path} must be injected");
        };
        let InjectionPlan::Inject(second) = injection_plan(path, None) else {
            panic!("{path} must be injected again");
        };
        assert_eq!(first.shell, kind);
        let disk = std::fs::read_to_string(format!(
            "{}/resources/shell-integration/{source}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        assert_eq!(first.script(), disk);
        assert!(!disk.is_empty());
        for injection in [&first, &second] {
            assert_eq!(
                uuid::Uuid::parse_str(&injection.session_id)
                    .unwrap()
                    .get_version_num(),
                4
            );
            assert_eq!(injection.nonce.len(), 32);
            assert!(injection
                .nonce
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        }
        assert_ne!(first.session_id, second.session_id);
        assert_ne!(first.nonce, second.nonce);
    }
}

#[cfg(not(target_os = "windows"))]
#[test]
fn injected_bash_hides_the_control_prompt() {
    use super::inject_test_support::{on_path, LiveShell};
    let bash = on_path("bash").expect("bash must be on PATH");
    if !super::inject_test_support::bash_supports_integration(&bash) {
        return;
    }
    let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
    std::fs::write(
        home.path().join(".bash_profile"),
        "PS1='termul-control-prompt$ '\nPROMPT_COMMAND='termul_user_hook=ran'\n",
    )
    .unwrap();
    let mut control = LiveShell::with_home(&bash, home.clone(), false);
    control.read_until_idle();
    let prompt = b"termul-control-prompt$ ";
    assert!(
        control.forwarded.windows(prompt.len()).any(|w| w == prompt),
        "control prompt missing: {:?}",
        String::from_utf8_lossy(&control.forwarded)
    );
    let mut injected = LiveShell::with_home(&bash, home, true);
    injected.handshake();
    injected.read_until_idle();
    assert!(
        !injected
            .forwarded
            .windows(prompt.len())
            .any(|w| w == prompt),
        "injected stream still contains the control prompt line"
    );
}

fn script_function<'a>(source: &'a str, name: &str) -> &'a str {
    source
        .split(&format!("{name}() {{"))
        .nth(1)
        .unwrap_or_else(|| panic!("missing {name}"))
        .split("\n}")
        .next()
        .unwrap()
}

#[test]
fn user_command_emits_lifecycle_frames() {
    for (source, shell) in scripts() {
        let preexec = script_function(&source, "__termul_preexec");
        let user = preexec.split("# User preexec path.").nth(1).unwrap();
        assert!(
            user.contains(r#"{"type":"CommandStarted","nonce":"%s"}"#),
            "{shell}: user path does not emit CommandStarted"
        );
        assert!(user.contains("__termul_user_command=1"));
        assert!(user.contains("__termul_frame \"$json\""));
        let generator = preexec.split("# User preexec path.").next().unwrap();
        assert!(generator.contains("__termul_generator=1"));
        assert!(generator.contains("return 0"));
        assert!(!generator.contains("CommandStarted") && !generator.contains("CommandFinished"));
        let prompt = script_function(&source, "__termul_prompt");
        assert!(prompt.trim_start().starts_with("local __termul_status=$?"));
        let finish = prompt
            .find(r#"{"type":"CommandFinished","nonce":"%s","exit_code":%s}"#)
            .unwrap_or_else(|| panic!("{shell}: user path does not emit CommandFinished"));
        assert!(prompt[..finish].contains("if [ \"$__termul_user_command\" = 1 ]; then"));
        assert!(prompt[..finish].contains("__termul_user_command=0"));
        assert!(prompt[finish..].contains("\"$__termul_status\""));
        assert!(finish < prompt.find("PromptReady").unwrap());
        assert!(prompt.find("return 0").unwrap() < finish);
        let prompt_ready = prompt.find("PromptReady").unwrap();
        let prompt_ready_call =
            prompt[prompt_ready..].find("__termul_frame").unwrap() + prompt_ready;
        let before_prompt_ready_frame = &prompt[..prompt_ready_call];
        let osc_133 = if shell == "bash" {
            "builtin printf '\\033]133;A;termul\\007'"
        } else {
            "printf '\\033]133;A;termul\\007'"
        };
        assert!(
            before_prompt_ready_frame.trim_end().ends_with(osc_133),
            "{shell}: 133;A must appear immediately before the PromptReady __termul_frame"
        );
        let early_return = prompt.find("return 0").unwrap();
        assert!(
            !prompt[..early_return].contains("133;A"),
            "{shell}: generator early-return path must emit NO 133;A"
        );
        if shell == "bash" {
            assert!(source.contains("trap -p DEBUG"));
            assert!(source.contains("$BASH_COMMAND"));
            assert!(source.contains("__termul_debug_armed=0"));
            assert!(source.contains("__termul_debug_armed=1"));
            assert!(source.contains("eval \"$__termul_old_debug_trap\""));
        } else {
            assert!(source.contains("add-zsh-hook preexec __termul_preexec"));
        }
    }
}

#[test]
fn completer_output_stays_off_the_terminal() {
    for (source, shell) in scripts() {
        let runner = script_function(&source, "__termul_run_completer");
        assert!(
            !runner.lines().any(|line| line.trim() == "\"$@\""),
            "{shell}: scripts print completer output to the terminal"
        );
        assert!(runner.contains("__termul_completion_candidates=$("));
        assert!(runner.contains("\"$@\" 2>/dev/null | __termul_completion_output"));
        assert!(!runner.contains("2>&1"));
        let encoder = script_function(&source, "__termul_completion_output");
        for required in [
            "IFS= read -r candidate",
            "candidate=${candidate% }",
            "[ -n \"$candidate\" ] || continue",
            "case \"$seen\" in",
            "continue ;;",
            "count=$((count + 1))",
            "[ \"$count\" -ge 200 ] && break",
            "od -An -v -tx1",
            "tr -d ' \\n'",
            "printf '%s\\n' \"$hex\"",
        ] {
            assert!(
                encoder.contains(required),
                "{shell}: encoder missing {required}"
            );
        }
        assert!(encoder.contains("$newline$candidate$newline"));
        let emit = script_function(&source, "__termul_emit_completion");
        assert_eq!(emit.matches("__termul_frame \"$json\"").count(), 1);
        assert!(emit.contains(r#"{"type":"Completion","session_id":"%s","nonce":"%s","request_id":"%s","buffer_revision":%s,"cursor":%s,"prompt_generation":%s,"cwd":"%s","output":"%s"}"#));
        for value in [
            "$__termul_session_id",
            "$__termul_nonce",
            "$1",
            "$PWD",
            "$__termul_completion_candidates",
        ] {
            assert!(
                emit.contains(&format!("__termul_json_escape \"{value}\"")),
                "{shell}: JSON escape {value}"
            );
        }
        assert!(emit.contains("\"$2\" \"$3\""));
        assert!(!emit.contains("CommandStarted") && !emit.contains("CommandFinished"));
    }
}

#[test]
fn generator_entry_point_stays_out_of_history() {
    for (source, shell) in scripts() {
        let entry = script_function(&source, "__termul_complete");
        for field in [
            "request_id=$1",
            "buffer_revision=$2",
            "cursor=$3",
            "draft_hex=$4",
        ] {
            assert!(entry.contains(field), "{shell}: missing {field}");
        }
        if shell == "bash" {
            assert!(entry.contains(
                "__termul_emit_completion \"$request_id\" \"$buffer_revision\" \"$cursor\""
            ));
        } else {
            assert!(script_function(&source, "__termul_line_init").contains("__termul_emit_completion \"$__termul_request_id\" \"$__termul_buffer_revision\" \"$__termul_cursor\""));
        }
        assert!(entry.contains("return \"$saved_status\""));
        assert!(!entry.contains("CommandStarted"));
        let prompt = script_function(&source, "__termul_prompt");
        let early = prompt
            .split("if [ \"$__termul_user_command\"")
            .next()
            .unwrap();
        assert!(early.contains("if [ \"$__termul_generator\" = 1 ]; then"));
        assert!(early.contains("return 0"));
        assert!(!early.contains("PromptReady"));
        if shell == "bash" {
            assert!(source.contains("HISTIGNORE=${HISTIGNORE:+$HISTIGNORE:}'__termul_complete*'"));
            assert!(!entry.contains("BASH_VERSINFO"));
            assert!(entry.contains("__termul_completion_candidates="));
            let candidates = script_function(&source, "__termul_candidates");
            for required in [
                "COMP_WORDS",
                "COMP_CWORD",
                "COMP_LINE",
                "COMP_POINT",
                "COMP_TYPE",
                "complete -p",
                "-F",
                "compgen -f",
                "compgen -c",
                "bash_completion",
            ] {
                assert!(candidates.contains(required), "bash: missing {required}");
            }
        } else {
            assert!(source.contains("add-zsh-hook zshaddhistory __termul_history"));
            assert!(source.contains("add-zsh-hook -d zshaddhistory __termul_history"));
            assert!(script_function(&source, "__termul_history").contains("return 1"));
            for required in [
                "zle -C",
                "complete-word",
                "_main_complete",
                "builtin compadd -A",
                "zle-line-init",
            ] {
                assert!(source.contains(required), "zsh: missing {required}");
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
#[test]
fn live_bash_completes_in_band() {
    use super::inject_test_support::{assert_live_completion, on_path};
    for bash in bash_paths() {
        assert_live_completion(&bash, false);
    }
    if let Some(zsh) = on_path("zsh") {
        assert_live_completion(&zsh, true);
    }
}

#[cfg(not(target_os = "windows"))]
#[tokio::test]
async fn live_shell_gate_submit_executes_single_multiline_and_vi_command() {
    use super::inject_test_support::{assert_live_gate_submit, on_path};
    for bash in bash_paths() {
        assert_live_gate_submit(&bash, false).await;
    }
    if let Some(zsh) = on_path("zsh") {
        assert_live_gate_submit(&zsh, true).await;
    } else {
        eprintln!("skipped zsh real-shell submit test: zsh not on PATH");
    }
}

#[test]
fn injection_plan_declares_its_completion_providers() {
    use super::gate::CompletionProvider;
    let mut ids = std::collections::HashSet::new();
    for name in ["bash", "zsh"] {
        let InjectionPlan::Inject(injection) = injection_plan(name, None) else {
            panic!("{name}: expected injection");
        };
        let providers: &Vec<CompletionProvider> = &injection.providers;
        assert!(!providers.is_empty());
        for provider in providers {
            assert!(ids.insert(provider.id.clone()), "duplicate provider id");
            assert_eq!(provider.id, name);
            assert_eq!(provider.command, b"\x1b0Di\x15__termul_complete ");
            // The live completion test proves history, status, and prompt restoration.
            // The existing restore scan also proves the explicit restore binding.
            assert!(
                provider.restorable,
                "{name}: proven wrapper must be restorable"
            );
        }
    }
    for name in [
        "fish",
        "dash",
        "sh",
        "ssh",
        "pwsh",
        "PowerShell",
        "cmd",
        "python",
    ] {
        assert!(matches!(injection_plan(name, None), InjectionPlan::Raw));
    }
    assert!(matches!(
        injection_plan("bash", Some("echo hello")),
        InjectionPlan::Raw
    ));
    assert!(matches!(
        injection_plan("zsh", Some("echo hello")),
        InjectionPlan::Raw
    ));
}
