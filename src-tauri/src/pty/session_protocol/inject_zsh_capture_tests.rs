#![cfg(not(target_os = "windows"))]

use super::frame::Frame;
use super::inject_test_support::{on_path, LiveShell};

fn decode_completion(frames: &[Frame]) -> Vec<String> {
    let [Frame::Completion(result)] = frames else {
        panic!("{frames:?}");
    };
    result
        .output
        .lines()
        .map(|line| {
            String::from_utf8(
                line.as_bytes()
                    .chunks(2)
                    .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                    .collect(),
            )
            .unwrap()
        })
        .collect()
}

fn capture(live: &mut LiveShell, draft: &str) -> Vec<String> {
    let hex: String = draft.bytes().map(|byte| format!("{byte:02x}")).collect();
    live.write(format!("\x15__termul_complete ordering 7 {} {hex}\r", draft.len()).as_bytes());
    let (frames, _) = live.completion_until_idle();
    decode_completion(&frames)
}

fn capture_with_output(live: &mut LiveShell, draft: &str) -> (Vec<String>, String) {
    live.forwarded.clear();
    let matches = capture(live, draft);
    live.write(b"\x15print -r CAPTURE_SYNC\r");
    live.frames_until_prompt();
    (
        matches,
        String::from_utf8_lossy(&live.forwarded).into_owned(),
    )
}

fn setup(body: &str) -> Option<LiveShell> {
    let shell = on_path("zsh")?;
    let mut live = LiveShell::spawn(&shell);
    live.handshake();
    live.read_until_idle();
    live.write(
        format!(
            "bindkey -e; setopt auto_list list_ambiguous; unsetopt menu_complete; _ordering() {{ {body}; }}; compdef _ordering ordercmd\r"
        )
        .as_bytes(),
    );
    live.frames_until_prompt();
    Some(live)
}

/// Read the actual ZLE buffer after expand-or-complete, without executing it.
fn tab_insertion(live: &mut LiveShell, draft: &str) -> String {
    live.write(format!("{draft}\t").as_bytes());
    live.read_until_idle();
    live.write(b"\x18\x02");
    live.read_until_idle();
    live.forwarded.clear();
    live.write(b"print -r -- ORACLE:${inserted}\r");
    live.frames_until_prompt();
    let output = String::from_utf8_lossy(&live.forwarded);
    output
        .split(['\r', '\n'])
        .find_map(|line| line.strip_prefix("ORACLE:ordercmd "))
        .unwrap_or_else(|| panic!("missing Tab insertion: {output:?}"))
        .trim_end()
        .to_owned()
}

/// Invalid -o clears zsh's matching flag, so a typed prefix cannot isolate
/// its multiple data words. Use builtin -O in the same live completion context.
/// These cases have no insertion affixes; -O therefore returns the same words.
fn builtin_matches(live: &mut LiveShell) -> Vec<String> {
    live.write(b"ordercmd \x18\x0f");
    live.read_until_idle();
    live.write(b"\x18\x02");
    live.read_until_idle();
    live.forwarded.clear();
    live.write(b"printf 'BUILTIN:%s\\n' \"${oracle_matches[@]}\"\r");
    live.frames_until_prompt();
    String::from_utf8_lossy(&live.forwarded)
        .split(['\r', '\n'])
        .filter_map(|line| line.strip_prefix("BUILTIN:").map(str::to_owned))
        // Empty words insert no text; the existing wire protocol omits them.
        .filter(|word| !word.is_empty())
        .collect()
}

#[test]
fn ordering_capture_matches_real_tab_insertion() {
    let Some(mut live) = setup("compadd -- body") else {
        return;
    };
    live.write(b"bindkey '^I' expand-or-complete; _save_inserted() { typeset -g inserted=$BUFFER; zle kill-whole-line; }; zle -N _save_inserted; bindkey '^X^B' _save_inserted\r");
    live.frames_until_prompt();
    live.write(b"_builtin_ordering() { typeset -ga oracle_matches=(); compadd() { local -a found; builtin compadd -O found \"$@\"; oracle_matches+=(\"${found[@]}\"); }; _ordering; unfunction compadd; }; zle -C _builtin_widget complete-word _builtin_ordering; bindkey '^X^O' _builtin_widget\r");
    live.frames_until_prompt();

    // Changing first-o state, option termination, or argument consumption must fail
    // this differential test. Expectations come from builtin compadd via real Tab.
    // A prefix isolates each member of multi-match forms without changing compdef.
    // -U bypasses prefix matching, so its terminator cases use one data word each.
    // The @O marker selects the documented builtin oracle for multi-match cases.
    let mut cases: Vec<(String, &str, bool)> = vec![
        ("compadd -UoPadded/ -- body".into(), "", false),
        ("compadd -o nosort -oPadded/ -- body".into(), "", false),
        (
            "local -a arr; compadd -o nosort -oD arr -- body".into(),
            "bo",
            false,
        ),
        ("compadd -o body -P literal".into(), "@O", false),
        ("compadd -o r -P literal".into(), "@O", false),
        ("compadd -o '' -P literal body".into(), "@O", false),
        ("compadd -on -P pre/ -- body".into(), "", false),
        ("compadd -om -- filtered; compadd -- body".into(), "", false),
        ("compadd -U- -Pfoo".into(), "", false),
        ("compadd -U- literal".into(), "", false),
        ("compadd -U- body".into(), "", false),
        ("compadd -U-- -Pfoo".into(), "", false),
        ("compadd -U-Pignored/ -Pfoo".into(), "", false),
        ("compadd -- -Pfoo".into(), "", false),
        ("compadd - -Pfoo".into(), "", false),
        ("compadd -U -- -Pfoo".into(), "", false),
        ("compadd -U - -Pfoo".into(), "", false),
        ("compadd -P pre/ -P ignored/ -- body".into(), "", false),
        ("compadd -P '' -P ignored/ -- body".into(), "", false),
        ("compadd -PSignored -- body".into(), "", false),
        ("compadd -oPfirst/ -o nosort".into(), "", false),
        ("compadd -oPfirst/ -oPsecond/ -- body".into(), "", false),
        (
            "compadd -oPfirst/ -oD arr -- filtered; compadd -- body".into(),
            "",
            true,
        ),
        (
            "compadd -oPfirst/ -oA arr -- filtered; compadd -- body".into(),
            "",
            true,
        ),
        (
            "compadd -oPfirst/ -oO arr -- filtered; compadd -- body".into(),
            "",
            true,
        ),
        ("compadd -o '' -oPignored/ -- body".into(), "@O", false),
        ("compadd -o nosort -o '' -P pre/ -- body".into(), "", false),
    ];
    for ordering in [
        "nosort",
        "no",
        "nos",
        "noso",
        "nosor",
        "mat",
        "matc",
        "match",
        "num",
        "nume",
        "numer",
        "numeri",
        "numeric",
        "rev",
        "reve",
        "rever",
        "revers",
        "reverse",
        "mat,num,rev",
        "match,numeric,reverse",
    ] {
        for separator in [" ", ""] {
            cases.push((
                format!("compadd -o{separator}{ordering} -P pre/ -- body"),
                "",
                false,
            ));
        }
    }
    // Empty fields, including a trailing comma, are invalid orderings. Separate
    // invalid values become match data; attached ones resume the character loop.
    for ordering in ["nosort,", "nosort,,match", ",nosort"] {
        cases.push((
            format!("compadd -o '{ordering}' -P literal body"),
            "@O",
            false,
        ));
        cases.push((
            if ordering.starts_with(',') {
                format!("compadd -o{ordering} -- filtered; compadd -- body")
            } else {
                format!("compadd -o{ordering} -- body")
            },
            "",
            false,
        ));
    }
    for second in ["r", "n", "bogus", "nosort,", ""] {
        cases.push((
            format!("compadd -o nosort -o '{second}' -P pre/ -- body"),
            "",
            false,
        ));
    }
    for flag in ["A", "O", "D"] {
        cases.push((format!("compadd -U-{flag}arr -Pfoo"), "", false));
    }
    for first in ["nosort", "numeric", "Pfirst/", "n", ""] {
        for second in ["nosort", "r", "Psecond/", "D", "A", "O", "-"] {
            // Invalid initial -o stays stored even when parsed as more flags.
            // With a valid first -o, later attached text is consumed as a whole.
            let tail = if ["D", "A", "O"].contains(&second) {
                " arr"
            } else {
                ""
            };
            let filter = ["Pfirst/", "n", ""].contains(&first) && ["D", "A", "O"].contains(&second);
            let following = if filter { "; compadd -- body" } else { "" };
            let prefix =
                if ["nosort", "numeric"].contains(&first) && ["D", "A", "O"].contains(&second) {
                    "bo"
                } else {
                    ""
                };
            let terminator = if second == "-" { "" } else { "-- " };
            let match_word = if filter { "filtered" } else { "body" };
            cases.push((
                format!(
                    "local -a arr; compadd -o{first} -o{second}{tail} {terminator}{match_word}{following}"
                ),
                prefix,
                filter,
            ));
        }
    }
    for flag in ["A", "O", "D"] {
        for group in [
            format!("-U{flag} arr"),
            format!("-U{flag}arr"),
            format!("-o{flag} arr"),
        ] {
            cases.push((
                format!("local -a arr=(filtered); compadd {group} -- filtered; compadd -- body"),
                "",
                true,
            ));
        }
    }

    let mut mismatches = Vec::new();
    for (body, prefix, filter) in &cases {
        live.write(format!("_ordering() {{ {body}; }}\r").as_bytes());
        live.frames_until_prompt();
        let draft = format!("ordercmd {}", if *prefix == "@O" { "" } else { prefix });
        let captured = capture(&mut live, &draft);
        let expected = if *prefix == "@O" {
            builtin_matches(&mut live)
        } else {
            let inserted = tab_insertion(&mut live, &draft);
            assert!(
                !inserted.is_empty() && inserted != *prefix,
                "no insertion: {body}: {inserted:?}"
            );
            vec![inserted]
        };
        if captured != expected {
            mismatches.push(format!(
                "{body} (prefix={prefix:?}): capture={captured:?}, oracle={expected:?}"
            ));
        }
        if *filter {
            if captured != ["body"] {
                mismatches.push(format!(
                    "filter call leaked or swallowed the following call: {body}: {captured:?}"
                ));
            }
            assert_eq!(expected, ["body"], "filter oracle: {body}");
        }
    }
    let builtin_cases = cases
        .iter()
        .filter(|(_, prefix, _)| *prefix == "@O")
        .count();
    eprintln!(
        "Differential matrix: {} real Tab cases, {builtin_cases} builtin -O cases",
        cases.len() - builtin_cases
    );
    assert!(
        mismatches.is_empty(),
        "{} / {} cases differ:\n{}",
        mismatches.len(),
        cases.len(),
        mismatches.join("\n")
    );
}

#[test]
fn capture_does_not_render_completion_message() {
    let Some(mut live) = setup("compadd -- alpha beta; _message -r 'leakmark message'") else {
        return;
    };
    let (matches, output) = capture_with_output(&mut live, "ordercmd ");
    assert_eq!(matches, ["alpha", "beta"]);
    assert!(
        !output.contains("leakmark"),
        "completion message leaked into output: {output:?}"
    );
}

#[test]
fn capture_does_not_render_option_descriptions() {
    let Some(mut live) = setup(
        "_arguments -s -S : '-l[long leakmark]' '-a[shared leakmark]' '-b[shared leakmark]' '-c[c leakmark]' '-d[d leakmark]' '-e[e leakmark]'",
    ) else {
        return;
    };
    let (matches, output) = capture_with_output(&mut live, "ordercmd -l");
    assert!(!matches.is_empty(), "expected non-empty matches");
    assert!(
        matches.iter().all(|m| m.starts_with("-l")),
        "expected all matches to start with '-l', got: {matches:?}"
    );
    assert!(
        !output.contains("leakmark"),
        "option descriptions leaked into output: {output:?}"
    );
}

#[test]
fn capture_survives_menu_select() {
    let Some(mut live) = setup(
        "zstyle ':completion:*' menu select; _arguments -s -S : '-l[long leakmark]' '-a[shared leakmark]' '-b[shared leakmark]' '-c[c leakmark]' '-d[d leakmark]' '-e[e leakmark]'",
    ) else {
        return;
    };
    let (matches, output) = capture_with_output(&mut live, "ordercmd -l");
    assert!(!matches.is_empty(), "expected non-empty matches");
    assert!(
        !output.contains("leakmark"),
        "menu select completion leaked into output: {output:?}"
    );
}
