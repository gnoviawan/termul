use super::build_windows_command_line;

fn cmdline(program: &str, args: &[&str]) -> String {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    build_windows_command_line(program, &owned)
}

/// #281: a spawned ConPTY child must be owned by a kill-on-close Job Object,
/// and dropping the returned handles must terminate the whole process tree
/// (the same mechanism that reaps children when the app process exits).
#[cfg(target_os = "windows")]
#[test]
fn spawn_conpty_assigns_job_and_kills_tree_on_close() {
    use super::spawn_conpty;
    use std::collections::HashMap;

    let mut env = HashMap::new();
    env.insert(
        "Path".to_string(),
        std::env::var("PATH").unwrap_or_default(),
    );

    let (reader, writer, pid, process_handle, job_handle, conpty_handles) =
        spawn_conpty("cmd.exe", None, 80, 24, &env).expect("spawn_conpty failed");

    assert_ne!(pid, 0, "expected a valid child pid");
    assert!(
        !job_handle.is_null(),
        "child must be assigned to a Job Object"
    );
    assert!(
        is_process_alive(pid),
        "child should be running immediately after spawn"
    );

    // Drop all owned handles. Closing the last job handle triggers
    // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, terminating the child tree.
    drop(reader);
    drop(writer);
    unsafe {
        winapi::um::handleapi::CloseHandle(process_handle);
    }
    drop(conpty_handles);
    unsafe {
        winapi::um::handleapi::CloseHandle(job_handle);
    }

    // Give the OS a brief moment to reap the tree.
    let mut alive = true;
    for _ in 0..50 {
        if !is_process_alive(pid) {
            alive = false;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(!alive, "child pid {} leaked after job handle close", pid);
}

#[cfg(target_os = "windows")]
fn is_process_alive(pid: u32) -> bool {
    unsafe {
        let handle = winapi::um::processthreadsapi::OpenProcess(
            winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        );
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = winapi::um::processthreadsapi::GetExitCodeProcess(handle, &mut code);
        winapi::um::handleapi::CloseHandle(handle);
        ok != 0 && code == winapi::um::minwinbase::STILL_ACTIVE
    }
}

#[test]
fn no_args_returns_program_only() {
    assert_eq!(cmdline("claude", &[]), "claude");
}

#[test]
fn simple_arg_not_quoted() {
    assert_eq!(cmdline("claude", &["hello"]), "claude hello");
}

#[test]
fn arg_with_space_is_quoted() {
    assert_eq!(
        cmdline("claude", &["explain this project"]),
        "claude \"explain this project\""
    );
}

#[test]
fn empty_arg_is_quoted() {
    assert_eq!(cmdline("claude", &[""]), "claude \"\"");
}

#[test]
fn embedded_double_quote_is_escaped() {
    // Prompt: say "hi"  ->  "say \"hi\""
    assert_eq!(
        cmdline("claude", &["say \"hi\""]),
        "claude \"say \\\"hi\\\"\""
    );
}

#[test]
fn trailing_backslash_in_quoted_arg_is_doubled() {
    // Prompt: C:\path with space\  ->  the trailing backslash before the
    // closing quote must be doubled so it is not read as escaping the quote.
    assert_eq!(
        cmdline("claude", &["C:\\path with space\\"]),
        "claude \"C:\\path with space\\\\\""
    );
}

#[test]
fn backslashes_before_quote_are_doubled_plus_escaped_quote() {
    // Input: a\\"b  (two backslashes then a quote)
    // Expected inside quotes: a\\\\\"b -> four backslashes + escaped quote
    assert_eq!(cmdline("p", &["a\\\\\"b"]), "p \"a\\\\\\\\\\\"b\"");
}

#[test]
fn interior_backslashes_stay_literal_when_quoted() {
    // Backslashes not adjacent to a quote are literal even inside quotes.
    assert_eq!(cmdline("p", &["a\\b c"]), "p \"a\\b c\"");
}

#[test]
fn shell_metacharacters_are_not_interpreted_just_passed_through() {
    // No cmd.exe wrapper, so these stay literal. They contain no spaces/quotes,
    // so they are not even quoted — CreateProcessW never interprets them.
    assert_eq!(cmdline("claude", &["a&&b|c^d%e"]), "claude a&&b|c^d%e");
}

#[test]
fn dangerous_prompt_with_space_and_metachars_is_single_quoted_arg() {
    // The classic injection attempt becomes ONE quoted argument.
    let out = cmdline("claude", &["; rm -rf ~ #"]);
    assert_eq!(out, "claude \"; rm -rf ~ #\"");
}

#[test]
fn newline_in_arg_forces_quoting() {
    assert_eq!(cmdline("p", &["line1\nline2"]), "p \"line1\nline2\"");
}

#[test]
fn tab_in_arg_forces_quoting() {
    assert_eq!(cmdline("p", &["a\tb"]), "p \"a\tb\"");
}

#[test]
fn program_with_space_is_quoted() {
    assert_eq!(
        cmdline("C:\\Program Files\\agent.exe", &["go"]),
        "\"C:\\Program Files\\agent.exe\" go"
    );
}

#[test]
fn multiple_args_joined_with_single_spaces() {
    assert_eq!(
        cmdline("gemini", &["-i", "query text"]),
        "gemini -i \"query text\""
    );
}

#[test]
fn non_ascii_arg_passes_through() {
    assert_eq!(
        cmdline("p", &["caf\u{e9} \u{2014} test"]),
        "p \"caf\u{e9} \u{2014} test\""
    );
}
