//! Real PTY helpers shared by shell integration tests.
#![cfg(not(target_os = "windows"))]

use super::filter::{FilterResult, SessionFilter};
use super::frame::Frame;
use super::inject::{injection_plan, install, InjectionPlan};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

pub fn on_path(name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|dir| dir.join(name))
        .find(|path| {
            path.is_file()
                && path
                    .metadata()
                    .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
        })
}

/// Query this executable rather than assuming the PATH or system bash version.
pub fn bash_supports_integration(shell: &Path) -> bool {
    let output = std::process::Command::new(shell)
        .args(["-c", "echo ${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"])
        .output()
        .expect("query bash version");
    assert!(output.status.success(), "{shell:?}: {output:?}");
    let version: Vec<u32> = String::from_utf8(output.stdout)
        .unwrap()
        .split_whitespace()
        .map(|part| part.parse().expect("numeric bash version"))
        .collect();
    assert_eq!(version.len(), 2, "{shell:?}: {version:?}");
    (version[0], version[1]) >= (4, 3)
}

pub(super) struct ReaderChunk {
    pub(super) bytes: Vec<u8>,
    events: Vec<crate::trackers::terminal_events::TerminalEvent>,
}

pub(super) struct GateReader {
    filter: SessionFilter,
    pending: std::sync::Mutex<Vec<u8>>,
    gate: std::sync::Arc<super::gate::SessionGate>,
    hub: crate::trackers::terminal_events::TerminalEventHub,
    events: tokio::sync::broadcast::Receiver<crate::trackers::terminal_events::TerminalEvent>,
}

impl GateReader {
    pub(super) fn new(
        gate: std::sync::Arc<super::gate::SessionGate>,
        hub: crate::trackers::terminal_events::TerminalEventHub,
    ) -> Self {
        Self {
            filter: SessionFilter::new(),
            pending: std::sync::Mutex::new(Vec::new()),
            gate,
            events: hub.subscribe(),
            hub,
        }
    }

    pub(super) fn process(&mut self, chunk: &[u8]) -> ReaderChunk {
        assert!(super::deliver::process_reader_chunk(
            &mut self.filter,
            chunk,
            &self.pending,
            &self.gate,
            "live",
            &self.hub,
        ));
        let bytes = self.pending.lock().unwrap().drain(..).collect();
        let mut events = Vec::new();
        while let Ok(event) = self.events.try_recv() {
            events.push(event);
        }
        ReaderChunk { bytes, events }
    }
}

fn live_command(
    shell: &Path,
    home: &tempfile::TempDir,
    injected: bool,
) -> (CommandBuilder, String, String) {
    let env = HashMap::from([
        (
            "HOME".to_string(),
            home.path().to_str().unwrap().to_string(),
        ),
        ("PATH".to_string(), std::env::var("PATH").unwrap()),
        ("TERM".to_string(), "xterm-256color".to_string()),
    ]);
    let plan = injection_plan(shell.to_str().unwrap(), None);
    let InjectionPlan::Inject(injection) = &plan else {
        panic!("expected injection for {shell:?}");
    };
    let session_id = injection.session_id.clone();
    let nonce = injection.nonce.clone();
    let mut command = CommandBuilder::new(shell);
    command.env_clear();
    for (key, value) in &env {
        command.env(key, value);
    }
    command.cwd(home.path());
    if injected {
        install(&plan, home.path(), &env, &mut command).expect("install shell integration");
    } else {
        command.args(["-l", "-i"]);
    }
    (command, session_id, nonce)
}

fn spawn_live_reader(
    mut reader: Box<dyn Read + Send>,
    mut gate_reader: Option<GateReader>,
) -> Receiver<std::io::Result<ReaderChunk>> {
    let (sender, chunks) = mpsc::channel();
    std::thread::spawn(move || loop {
        let mut buffer = [0; 4096];
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                let bytes = match gate_reader.as_mut() {
                    Some(processing) => processing.process(&buffer[..n]),
                    None => ReaderChunk {
                        bytes: buffer[..n].to_vec(),
                        events: Vec::new(),
                    },
                };
                if sender.send(Ok(bytes)).is_err() {
                    break;
                }
            }
            Err(error) => {
                let _ = sender.send(Err(error));
                break;
            }
        }
    });
    chunks
}

pub struct LiveShell {
    child: Box<dyn Child + Send + Sync>,
    _master: Box<dyn MasterPty + Send>,
    _home: std::sync::Arc<tempfile::TempDir>,
    chunks: Receiver<std::io::Result<ReaderChunk>>,
    gated: bool,
    writer: Option<Box<dyn Write + Send>>,
    filter: SessionFilter,
    pub session_id: String,
    pub nonce: String,
    pub forwarded: Vec<u8>,
}

impl LiveShell {
    pub fn spawn(shell: &Path) -> Self {
        Self::with_home(shell, tempfile::tempdir().unwrap().into(), true)
    }

    pub fn with_home(
        shell: &Path,
        home: std::sync::Arc<tempfile::TempDir>,
        injected: bool,
    ) -> Self {
        Self::with_home_reader(shell, home, injected, None)
    }

    fn with_home_reader(
        shell: &Path,
        home: std::sync::Arc<tempfile::TempDir>,
        injected: bool,
        mut gate_reader: Option<GateReader>,
    ) -> Self {
        let (command, session_id, nonce) = live_command(shell, &home, injected);
        if let Some(reader) = gate_reader.as_mut() {
            reader
                .gate
                .expect_session(session_id.clone(), nonce.clone());
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty refused");
        let child = pair
            .slave
            .spawn_command(command)
            .expect("PTY shell spawn refused");
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let gated = gate_reader.is_some();
        let chunks = spawn_live_reader(reader, gate_reader);
        Self {
            child,
            _master: pair.master,
            _home: home,
            chunks,
            gated,
            writer: Some(writer),
            filter: SessionFilter::new(),
            session_id,
            nonce,
            forwarded: Vec::new(),
        }
    }

    pub fn write(&mut self, bytes: &[u8]) {
        let writer = self.writer.as_mut().expect("PTY writer");
        writer.write_all(bytes).expect("PTY write failed");
        writer.flush().expect("PTY flush failed");
    }

    pub fn take_writer(&mut self) -> Box<dyn Write + Send> {
        self.writer.take().expect("PTY writer")
    }

    pub fn read_until_idle(&mut self) -> Vec<Frame> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut frames = Vec::new();
        loop {
            let timeout = deadline.saturating_duration_since(Instant::now());
            assert!(!timeout.is_zero(), "PTY did not become idle");
            match self
                .chunks
                .recv_timeout(timeout.min(Duration::from_millis(200)))
            {
                Ok(chunk) if self.gated => {
                    self.forwarded.extend(chunk.expect("PTY read failed").bytes);
                }
                Ok(chunk) => match self.filter.process(&chunk.expect("PTY read failed").bytes) {
                    FilterResult::Forwarded { bytes, frames: new } => {
                        self.forwarded.extend(bytes);
                        frames.extend(new);
                    }
                    other => panic!("unexpected filter result: {other:?}"),
                },
                Err(mpsc::RecvTimeoutError::Timeout) => return frames,
                Err(error) => panic!("PTY closed before idle: {error}"),
            }
        }
    }

    pub fn frames_until_prompt(&mut self) -> Vec<Frame> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut frames = Vec::new();
        while !frames
            .iter()
            .any(|frame| matches!(frame, Frame::PromptReady { .. }))
        {
            let timeout = deadline
                .checked_duration_since(Instant::now())
                .expect("PromptReady exceeded its ten-second deadline");
            let chunk = self
                .chunks
                .recv_timeout(timeout)
                .unwrap_or_else(|error| {
                    panic!(
                        "no PromptReady: {error}; frames={frames:?}; output={:?}",
                        String::from_utf8_lossy(&self.forwarded)
                    )
                })
                .expect("PTY read failed")
                .bytes;
            match self.filter.process(&chunk) {
                FilterResult::Forwarded { bytes, frames: new } => {
                    self.forwarded.extend(bytes);
                    frames.extend(new);
                }
                other => panic!("unexpected filter result: {other:?}"),
            }
        }
        frames.extend(self.read_until_idle());
        frames
    }

    pub fn handshake(&mut self) -> Vec<Frame> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut frames = Vec::new();
        while frames.len() < 2 {
            let timeout = deadline
                .checked_duration_since(Instant::now())
                .expect("InitShell/PromptReady handshake exceeded its ten-second deadline");
            let chunk = self
                .chunks
                .recv_timeout(timeout)
                .unwrap_or_else(|error| {
                    panic!(
                        "no InitShell/PromptReady handshake: {error}; output={:?}",
                        String::from_utf8_lossy(&self.forwarded)
                    )
                })
                .expect("PTY read failed")
                .bytes;
            match self.filter.process(&chunk) {
                FilterResult::Forwarded { bytes, frames: new } => {
                    assert!(!bytes.windows(6).any(|w| w == b"]9477;"));
                    self.forwarded.extend(bytes);
                    frames.extend(new);
                }
                other => panic!("unexpected filter result: {other:?}"),
            }
        }
        assert!(!self.forwarded.windows(6).any(|w| w == b"]9477;"));
        frames
    }
}

impl Drop for LiveShell {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl LiveShell {
    /// Feed single bytes to the real filter to observe precisely what follows Completion.
    pub fn completion_until_idle(&mut self) -> (Vec<Frame>, Vec<u8>) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut frames = Vec::new();
        let mut after = Vec::new();
        let mut completed = false;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "completion deadline: {frames:?}");
            let timeout = if completed {
                remaining.min(Duration::from_millis(200))
            } else {
                remaining
            };
            match self.chunks.recv_timeout(timeout) {
                Ok(chunk) => {
                    for byte in chunk.expect("PTY read failed").bytes {
                        match self.filter.process(&[byte]) {
                            FilterResult::Forwarded { bytes, frames: new } => {
                                if completed {
                                    after.extend_from_slice(&bytes);
                                }
                                self.forwarded.extend(bytes);
                                completed |= new.iter().any(|f| matches!(f, Frame::Completion(_)));
                                frames.extend(new);
                            }
                            other => panic!("unexpected filter result: {other:?}"),
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) if completed => return (frames, after),
                Err(error) => panic!(
                    "completion missing: {error}; frames={frames:?}; output={:?}",
                    String::from_utf8_lossy(&self.forwarded)
                ),
            }
        }
    }
}

fn user_command(live: &mut LiveShell, command: &[u8]) -> u64 {
    live.forwarded.clear();
    live.write(command);
    let frames = live.frames_until_prompt();
    assert_eq!(
        frames
            .iter()
            .filter(|f| matches!(f, Frame::CommandStarted { .. }))
            .count(),
        1,
        "{frames:?}"
    );
    assert_eq!(
        frames
            .iter()
            .filter(|f| matches!(f, Frame::CommandFinished { .. }))
            .count(),
        1,
        "{frames:?}"
    );
    frames
        .iter()
        .find_map(|f| match f {
            Frame::PromptReady {
                prompt_generation, ..
            } => Some(*prompt_generation),
            _ => None,
        })
        .unwrap()
}

fn complete(live: &mut LiveShell, generation: u64) {
    live.forwarded.clear();
    live.write(b"\x1b0Di\x15__termul_complete r1 7 5 6364207370\r");
    let (frames, after) = live.completion_until_idle();
    assert!(
        !live
            .forwarded
            .windows(b"termul-completion-prompt$ ".len())
            .any(|bytes| bytes == b"termul-completion-prompt$ "),
        "generator redrew the saved prompt: {:?}",
        String::from_utf8_lossy(&live.forwarded)
    );
    assert!(
        !live
            .forwarded
            .windows(b"\x1b]133;A;termul\x07".len())
            .any(|bytes| bytes == b"\x1b]133;A;termul\x07"),
        "generator path emitted private mark to forwarded: {:?}",
        String::from_utf8_lossy(&live.forwarded)
    );
    assert!(
        !live
            .forwarded
            .windows(b"133;A".len())
            .any(|bytes| bytes == b"133;A"),
        "generator path emitted 133;A substring to forwarded: {:?}",
        String::from_utf8_lossy(&live.forwarded)
    );
    assert!(
        !after
            .windows(b"\x1b]133;A;termul\x07".len())
            .any(|bytes| bytes == b"\x1b]133;A;termul\x07"),
        "generator path emitted private mark to after: {:?}",
        String::from_utf8_lossy(&after)
    );
    assert!(
        !after.windows(b"133;A".len()).any(|bytes| bytes == b"133;A"),
        "generator path emitted 133;A substring to after: {:?}",
        String::from_utf8_lossy(&after)
    );
    assert_eq!(frames.len(), 1, "generator lifecycle leak: {frames:?}");
    let Frame::Completion(result) = &frames[0] else {
        panic!("{frames:?}");
    };
    assert_eq!(
        result.prompt_generation, generation,
        "Completion must use PromptReady generation"
    );
    assert_eq!(result.session_id, live.session_id);
    assert_eq!(result.nonce, live.nonce);
    assert_eq!(result.request_id, "r1");
    assert_eq!(result.buffer_revision, 7);
    assert_eq!(result.cursor, 5);
    assert_eq!(
        Path::new(&result.cwd).canonicalize().unwrap(),
        live._home.path().canonicalize().unwrap()
    );
    let candidates: Vec<Vec<u8>> = result
        .output
        .lines()
        .map(|line| {
            assert_eq!(line.len() % 2, 0);
            line.as_bytes()
                .chunks(2)
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect()
        })
        .collect();
    assert!(
        candidates.iter().any(|c| c == b"spike-dir"),
        "{candidates:?}"
    );
    let mut tail = after.as_slice();
    while !tail.is_empty() {
        let modes: &[&[u8]] = &[
            b"\x1b[?2004h",
            b"\x1b[?2004l",
            b"\x1b[?1h",
            b"\x1b[?1l",
            b"\x1b=",
            b"\x1b>",
            b"\x1b[K",
            b"\x1b[0K",
        ];
        let mode = modes
            .iter()
            .find(|mode| tail.starts_with(mode))
            .unwrap_or_else(|| panic!("output after Completion: {after:?}"));
        tail = &tail[mode.len()..];
    }
}

pub fn assert_live_completion(shell: &Path, zsh: bool) {
    if !zsh && !bash_supports_integration(shell) {
        return;
    }
    let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
    std::fs::create_dir(home.path().join("spike-dir")).unwrap();
    // A visible saved prompt makes any redraw detectable. Enable zsh history explicitly.
    std::fs::write(
        home.path().join(".bash_profile"),
        "PS1='termul-completion-prompt$ '\nHISTIGNORE='keep-me'\n",
    )
    .unwrap();
    std::fs::write(
        home.path().join(".zshrc"),
        "PROMPT='termul-completion-prompt$ '\nHISTSIZE=1000\nSAVEHIST=0\n",
    )
    .unwrap();
    let mut live = LiveShell::with_home(shell, home, true);
    live.handshake();
    live.read_until_idle();
    for vi in [false, true] {
        if vi {
            user_command(
                &mut live,
                if zsh { b"bindkey -v\r" } else { b"set -o vi\r" },
            );
        }
        let generation = user_command(&mut live, b"echo one\r");
        if vi {
            live.write(b"\x1b");
        }
        complete(&mut live, generation);
        user_command(&mut live, b"fc -ln -1\r");
        let output = String::from_utf8_lossy(&live.forwarded);
        assert!(
            output
                .split(['\r', '\n'])
                .any(|line| line.trim() == "echo one"),
            "history changed: {output:?}"
        );
        let generation = user_command(&mut live, b"false\r");
        if vi {
            live.write(b"\x1b");
        }
        complete(&mut live, generation);
        user_command(&mut live, b"echo $?\r");
        let output = String::from_utf8_lossy(&live.forwarded);
        assert!(
            output.split(['\r', '\n']).any(|line| line.trim() == "1"),
            "user status changed: {output:?}"
        );
    }
}

/// Exercise rollback after the second clear-line or restore-prompt mutation.
pub fn assert_bash_binding_rollback() {
    let mut shells = vec![on_path("bash").unwrap(), PathBuf::from("/bin/bash")];
    shells.dedup();
    for shell in shells {
        if !bash_supports_integration(&shell) {
            continue;
        }
        for failure in [2, 5] {
            for originals in [false, true] {
                let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
                let profile = format!(
                    r#"
PS1='rollback> '
snapshot() {{
    builtin bind -m "$1" "$2" | while IFS= read -r binding; do
        case "$binding" in
            *'\e[98;'*|*'\e[99;'*) printf '%s\n' "$binding" ;;
        esac
    done
}}
for map in emacs vi-insert vi-command; do
    builtin bind -m "$map" '"\e[98;1~": backward-char'
    if [ {originals} = true ]; then
        builtin bind -m "$map" '"\e[99;1~": forward-char'
        builtin bind -m "$map" '"\e[99;2~": "ORIGINAL_MACRO"'
        builtin bind -m "$map" -x '"\e[98;2~": echo UNRELATED_ORIGINAL'
        if [ "$map" = vi-command ]; then
            builtin bind -m "$map" -x '"\e[99;2~": echo ORIGINAL_SHELL'
        fi
    fi
    snapshot "$map" -p > "$HOME/$map.p"
    snapshot "$map" -s > "$HOME/$map.s"
    snapshot "$map" -X > "$HOME/$map.x"
done
mutation_count=0
bind() {{
    case "$*" in
        *kill-whole-line*|*__termul_restore_prompt*)
            mutation_count=$((mutation_count + 1))
            [ "$mutation_count" != {failure} ] || return 1 ;;
    esac
    builtin bind "$@"
}}
"#
                );
                std::fs::write(home.path().join(".bash_profile"), profile).unwrap();
                let mut live = LiveShell::with_home(&shell, home.clone(), true);
                let frames = live.read_until_idle();
                assert!(frames.is_empty(), "{shell:?}/{failure}: {frames:?}");
                // A leaked bind -x invokes a removed helper, producing command-not-found.
                live.forwarded.clear();
                live.write(b"\x1b[99;2~\x15");
                live.read_until_idle();
                let output = String::from_utf8_lossy(&live.forwarded);
                assert!(
                    !output.contains("command not found")
                        && !output.contains("bash_execute_unix_command"),
                    "leaked restore binding: {output:?}"
                );
                let verify = r#"
result=OK
for map in emacs vi-insert vi-command; do
    snapshot "$map" -p > "$HOME/after.p"
    snapshot "$map" -s > "$HOME/after.s"
    cmp -s "$HOME/$map.p" "$HOME/after.p" || result=BAD_FUNCTION
    cmp -s "$HOME/$map.s" "$HOME/after.s" || result=BAD_MACRO
    snapshot "$map" -X > "$HOME/after.x"
    cmp -s "$HOME/$map.x" "$HOME/after.x" || result=BAD_SHELL_COMMAND
done
printf 'ROLLBACK:%s:%s\n' "$result" "$mutation_count"
"#;
                std::fs::write(home.path().join("verify"), verify).unwrap();
                live.write(b". \"$HOME/verify\"\r");
                let frames = live.read_until_idle();
                assert!(frames.is_empty());
                let output = String::from_utf8_lossy(&live.forwarded);
                assert!(
                    output.contains(&format!("ROLLBACK:OK:{failure}\r\n")),
                    "{shell:?}/{failure}/{originals}: {output:?}"
                );
            }
        }
    }
}

/// Legacy bash must stay raw without even querying or mutating Readline bindings.
pub fn assert_legacy_bash_stays_raw() {
    let shell = PathBuf::from("/bin/bash");
    if bash_supports_integration(&shell) {
        eprintln!("skipped legacy raw test: /bin/bash >= 4.3");
        return;
    }
    for (debug, collision) in [(false, false), (true, false), (false, true), (true, true)] {
        let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
        std::fs::write(
            home.path().join(".bash_profile"),
            format!(
                r#"
PS1='LEGACY_USER> '
HISTIGNORE='keep-me'
PROMPT_COMMAND='legacy_prompt=ran'
if [ {debug} = true ]; then trap 'legacy_debug=ran' DEBUG; fi
trap -p DEBUG > "$HOME/before.debug"
declare -p PROMPT_COMMAND > "$HOME/before.prompt"
for map in emacs vi-insert vi-command; do
    if [ {collision} = true ]; then
        builtin bind -m "$map" '"\e[99;1~": backward-char'
    fi
    builtin bind -m "$map" '"\e[98;1~": "USER_MACRO"'
    builtin bind -m "$map" -x '"\e[99;2~": echo USER_SHELL'
    builtin bind -m "$map" -p > "$HOME/$map.before.p"
    builtin bind -m "$map" -s > "$HOME/$map.before.s"
done
bind() {{
    printf '%s\n' "$*" >> "$HOME/bind.log"
    builtin bind "$@"
}}
"#
            ),
        )
        .unwrap();
        std::fs::write(
            home.path().join("verify"),
            r#"
declare -p PROMPT_COMMAND > "$HOME/after.prompt"
printf 'STATE:%s:%s:%s\n' "$PS1" "$HISTIGNORE" "$legacy_prompt"
for map in emacs vi-insert vi-command; do
    builtin bind -m "$map" -p > "$HOME/$map.after.p"
    builtin bind -m "$map" -s > "$HOME/$map.after.s"
done
printf 'TYPED_COMMAND_RAN\n'
"#,
        )
        .unwrap();
        let mut live = LiveShell::with_home(&shell, home.clone(), true);
        let frames = live.read_until_idle();
        assert!(
            frames.is_empty(),
            "legacy startup emitted frames: {frames:?}"
        );
        assert!(String::from_utf8_lossy(&live.forwarded).contains("LEGACY_USER> "));
        assert!(
            !home.path().join("bind.log").exists(),
            "bootstrap called bind"
        );
        live.forwarded.clear();
        // Sourcing a file temporarily hides DEBUG on legacy bash; inspect at script scope.
        live.write(b"trap -p DEBUG > \"$HOME/after.debug\"; . \"$HOME/verify\"\r");
        assert!(live.read_until_idle().is_empty());
        let output = String::from_utf8_lossy(&live.forwarded);
        assert!(output.contains("TYPED_COMMAND_RAN\r\n"), "{output:?}");
        assert!(
            output.contains("STATE:LEGACY_USER> :keep-me:ran\r\n"),
            "{output:?}"
        );
        assert!(
            !home.path().join("bind.log").exists(),
            "typed command called bind"
        );
        for kind in ["debug", "prompt"] {
            assert_eq!(
                std::fs::read(home.path().join(format!("before.{kind}"))).unwrap(),
                std::fs::read(home.path().join(format!("after.{kind}"))).unwrap(),
                "{kind}"
            );
        }
        for map in ["emacs", "vi-insert", "vi-command"] {
            for kind in ["p", "s"] {
                assert_eq!(
                    std::fs::read(home.path().join(format!("{map}.before.{kind}"))).unwrap(),
                    std::fs::read(home.path().join(format!("{map}.after.{kind}"))).unwrap(),
                    "{map}/{kind}"
                );
            }
        }
    }
}

/// A real second-bind failure must remove the first mutation and leave commands usable.
pub fn assert_second_private_bind_failure() {
    let mut shells = vec![on_path("bash").unwrap(), PathBuf::from("/bin/bash")];
    shells.dedup();
    for shell in shells {
        if !bash_supports_integration(&shell) {
            continue;
        }
        let home = std::sync::Arc::new(tempfile::tempdir().unwrap());
        std::fs::write(
            home.path().join(".bash_profile"),
            r#"
PS1='rollback> '
private_binds=0
bind() {
    case "$*" in
        *kill-whole-line*|*__termul_restore_prompt*)
            private_binds=$((private_binds + 1))
            if [ "$private_binds" = 2 ]; then
                builtin bind -m emacs -p > "$HOME/first-bind"
                printf 'SECOND_BIND_FAILED\n' >> "$HOME/failure"
                return 1
            fi ;;
    esac
    builtin bind "$@"
}
"#,
        )
        .unwrap();
        let mut live = LiveShell::with_home(&shell, home.clone(), true);
        let mut frames = live.read_until_idle();
        assert!(
            String::from_utf8_lossy(&std::fs::read(home.path().join("first-bind")).unwrap())
                .contains(r#"99;1~": kill-whole-line"#),
            "first bind must succeed: {shell:?}: {:?}",
            String::from_utf8_lossy(&std::fs::read(home.path().join("first-bind")).unwrap())
        );
        assert_eq!(
            std::fs::read_to_string(home.path().join("failure")).unwrap(),
            "SECOND_BIND_FAILED\n"
        );
        std::fs::write(
            home.path().join("verify"),
            r#"
for map in emacs vi-insert vi-command; do
    builtin bind -m "$map" -p > "$HOME/$map.after.p"
    builtin bind -m "$map" -s > "$HOME/$map.after.s"
done
printf 'TYPED_COMMAND_RAN\n'
"#,
        )
        .unwrap();
        live.forwarded.clear();
        live.write(b". \"$HOME/verify\"\r");
        frames.extend(live.read_until_idle());
        assert!(
            frames.is_empty(),
            "{shell:?}: rollback must stay raw: {frames:?}"
        );
        assert!(String::from_utf8_lossy(&live.forwarded).contains("TYPED_COMMAND_RAN\r\n"));
        for map in ["emacs", "vi-insert", "vi-command"] {
            for kind in ["p", "s"] {
                let bytes = std::fs::read(home.path().join(format!("{map}.after.{kind}"))).unwrap();
                let dump = String::from_utf8_lossy(&bytes);
                for sequence in [r"\e[99;1~", r"\e[99;2~", r"\M-[99;1~", r"\M-[99;2~"] {
                    assert!(
                        !dump.contains(sequence),
                        "{shell:?}/{map}/{kind}: leaked {sequence}: {dump}"
                    );
                }
            }
        }
    }
}

struct SubmittedLifecycle {
    kinds: Vec<String>,
    exit_code: Option<i32>,
}

impl LiveShell {
    pub fn pump_gate_until_prompt(&mut self) -> Vec<String> {
        self.pump_gate_until_prompt_with_exit().kinds
    }

    fn pump_gate_until_prompt_with_exit(&mut self) -> SubmittedLifecycle {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut kinds = Vec::new();
        let mut exit_code = None;
        while !kinds.iter().any(|kind| kind == "PromptReady") {
            let timeout = deadline
                .checked_duration_since(Instant::now())
                .unwrap_or_else(|| {
                    panic!(
                        "no authenticated PromptReady: kinds={kinds:?}; output={:?}",
                        String::from_utf8_lossy(&self.forwarded)
                    )
                });
            let chunk = self
                .chunks
                .recv_timeout(timeout.min(Duration::from_millis(200)));
            let Ok(chunk) = chunk else { continue };
            let chunk = chunk.expect("PTY read failed");
            self.forwarded.extend(chunk.bytes);
            for event in chunk.events {
                if let crate::trackers::terminal_events::TerminalEvent::SessionLifecycle {
                    kind,
                    exit_code: code,
                    ..
                } = event
                {
                    if kind == "CommandFinished" {
                        exit_code = code;
                    }
                    kinds.push(kind);
                }
            }
        }
        SubmittedLifecycle { kinds, exit_code }
    }
}

async fn assert_submitted_command(
    shell: &Path,
    live: &mut LiveShell,
    gate: &std::sync::Arc<super::gate::SessionGate>,
    draft: &str,
    expected_outputs: &[&str],
) {
    live.forwarded.clear();
    assert_eq!(
        gate.submit(draft, true).await,
        super::frame::SessionRpcResult::Accepted
    );
    let submitted = live.pump_gate_until_prompt_with_exit();
    assert_eq!(
        submitted.kinds,
        ["CommandStarted", "CommandFinished", "PromptReady"],
        "{shell:?}: draft={draft:?}"
    );
    assert_eq!(
        submitted.exit_code,
        Some(0),
        "{shell:?}: draft={draft:?} must finish with exit 0"
    );
    let output = String::from_utf8_lossy(&live.forwarded);
    for expected in expected_outputs {
        assert!(
            output.contains(expected),
            "{shell:?}: missing {expected:?} in {output:?}"
        );
    }
}

pub async fn assert_live_gate_submit(shell: &Path, zsh: bool) {
    use super::frame::SessionRpcResult;
    use super::gate::SessionGate;
    use crate::trackers::terminal_events::TerminalEventHub;
    if !zsh && !bash_supports_integration(shell) {
        return;
    }
    let writer = std::sync::Arc::new(tokio::sync::Mutex::new(None));
    let gate = std::sync::Arc::new(SessionGate::new(writer.clone()));
    let hub = TerminalEventHub::standalone();
    let mut live = LiveShell::with_home_reader(
        shell,
        tempfile::tempdir().unwrap().into(),
        true,
        Some(GateReader::new(gate.clone(), hub)),
    );
    *writer.lock().await = Some(live.take_writer());
    let handshake = live.pump_gate_until_prompt();
    assert_eq!(handshake, ["InitShell", "PromptReady"], "{shell:?}");
    assert!(gate.trusted_at_prompt(), "{shell:?}");

    assert_submitted_command(
        shell,
        &mut live,
        &gate,
        "echo termul-$((40+2))",
        &["termul-42"],
    )
    .await;
    assert_submitted_command(
        shell,
        &mut live,
        &gate,
        "echo termul-$((3+4))\necho termul-$((8+1))",
        &["termul-7", "termul-9"],
    )
    .await;

    let vi_cmd = if zsh { "bindkey -v" } else { "set -o vi" };
    assert_eq!(gate.submit(vi_cmd, true).await, SessionRpcResult::Accepted);
    live.pump_gate_until_prompt();
    {
        let mut raw = writer.lock().await;
        let w = raw.as_mut().expect("PTY writer");
        w.write_all(b"partial\x1b").expect("vi escape");
        w.flush().expect("vi flush");
    }
    live.read_until_idle();
    live.forwarded.clear();
    assert_submitted_command(
        shell,
        &mut live,
        &gate,
        "echo termul-$((40+2))",
        &["termul-42"],
    )
    .await;
    let vi_output = String::from_utf8_lossy(&live.forwarded);
    assert!(
        !vi_output.contains("partialecho") && !vi_output.contains("command not found"),
        "{shell:?}: vi-command left residual line text: {vi_output:?}"
    );

    let disable_paste = if zsh {
        "unset zle_bracketed_paste"
    } else {
        "bind 'set enable-bracketed-paste off'"
    };
    assert_eq!(
        gate.submit(disable_paste, true).await,
        SessionRpcResult::Accepted
    );
    live.pump_gate_until_prompt();
    assert_submitted_command(
        shell,
        &mut live,
        &gate,
        "echo termul-$((5*8))",
        &["termul-40"],
    )
    .await;
    for case in [
        "single line",
        "multiline (exactly one CommandStarted)",
        "vi-command",
        "paste disabled",
    ] {
        eprintln!("{shell:?}: {case} PASS");
    }
}
