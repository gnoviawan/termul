use super::*;
use portable_pty::{Child, ChildKiller};

#[test]
fn output_reader_splits_batches_and_reports_eof() {
    let (tx, rx) = mpsc::channel(4);
    let mut reader = OutputReader {
        rx,
        pending: Vec::new(),
        pos: 0,
    };
    tx.try_send(b"hello".to_vec()).unwrap();
    tx.try_send(b"!".to_vec()).unwrap();
    drop(tx);

    let mut buf = [0u8; 3];
    assert_eq!(reader.read(&mut buf).unwrap(), 3);
    assert_eq!(&buf, b"hel");
    assert_eq!(reader.read(&mut buf).unwrap(), 2);
    assert_eq!(&buf[..2], b"lo");
    assert_eq!(reader.read(&mut buf).unwrap(), 1);
    assert_eq!(buf[0], b'!');
    // Sender gone: EOF, which ends the terminal reader thread.
    assert_eq!(reader.read(&mut buf).unwrap(), 0);
}

#[test]
fn input_writer_fails_once_the_session_is_gone() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut writer = InputWriter { tx };
    assert_eq!(writer.write(b"ls\r").unwrap(), 3);
    match rx.try_recv().unwrap() {
        ShellCmd::Input(bytes) => assert_eq!(bytes, b"ls\r"),
        _ => panic!("expected input"),
    }
    drop(rx);
    let err = writer.write(b"x").expect_err("closed session must error");
    assert_eq!(err.kind(), ErrorKind::BrokenPipe);
}

#[test]
fn child_reports_exit_after_the_shell_ends() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let state = Arc::new(EndState::default());
    let mut child = ShellChild {
        tx,
        state: state.clone(),
    };
    assert!(child.try_wait().unwrap().is_none());

    child.kill().unwrap();
    assert!(matches!(rx.try_recv().unwrap(), ShellCmd::Close));

    state.finish(ShellEnd::Exited(Some(3)));
    let status = child.try_wait().unwrap().expect("ended");
    assert_eq!(status.exit_code(), 3);
    assert_eq!(child.wait().unwrap().exit_code(), 3);

    // The first outcome wins.
    state.finish(ShellEnd::Lost("late".into()));
    assert_eq!(state.get(), Some(ShellEnd::Exited(Some(3))));
}

#[test]
fn exit_codes_follow_the_outcome() {
    assert_eq!(ShellEnd::Exited(Some(0)).exit_code(), 0);
    assert_eq!(ShellEnd::Exited(Some(130)).exit_code(), 130);
    assert_eq!(ShellEnd::Exited(None).exit_code(), 0);
    assert_eq!(ShellEnd::Closed.exit_code(), 0);
    assert_eq!(ShellEnd::Lost("reset".into()).exit_code(), 1);
}

#[test]
fn kill_after_end_does_not_error() {
    let (tx, rx) = mpsc::unbounded_channel();
    drop(rx);
    let mut child = ShellChild {
        tx,
        state: Arc::new(EndState::default()),
    };
    assert!(child.kill().is_ok());
}
