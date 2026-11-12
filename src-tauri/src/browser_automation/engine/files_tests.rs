use super::*;

#[test]
fn an_opened_file_reports_where_it_really_is() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("real.txt");
    std::fs::write(&file, b"x").unwrap();
    let opened = File::open(&file).unwrap();
    assert_eq!(
        opened_path(&opened).unwrap(),
        std::fs::canonicalize(&file).unwrap()
    );

    let link = dir.path().join("link.txt");
    if symlink_file(&file, &link) {
        let through = File::open(&link).unwrap();
        assert_eq!(
            opened_path(&through).unwrap(),
            std::fs::canonicalize(&file).unwrap()
        );
    }
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn a_download_mark_is_the_one_the_os_checks() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.bin");
    std::fs::write(&file, b"bytes").unwrap();
    mark_downloaded(&file, "https://files.example").unwrap();
    #[cfg(windows)]
    {
        let mut stream = file.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        assert_eq!(
            std::fs::read_to_string(PathBuf::from(stream)).unwrap(),
            "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://files.example\r\n"
        );
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("xattr")
            .args(["-p", "com.apple.quarantine"])
            .arg(&file)
            .output()
            .unwrap();
        let value = String::from_utf8_lossy(&out.stdout);
        assert!(
            value.starts_with("0081;") && value.trim_end().ends_with(";Troupe;"),
            "{value}"
        );
    }
}

/// A FIFO swapped in for a checked file must not hang the host: the
/// non-blocking open returns at once, and the regular-file check refuses
/// it.
#[cfg(unix)]
#[test]
fn a_fifo_opens_at_once_and_is_refused_as_not_a_file() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::time::{Duration, Instant};

    use crate::browser_automation::core::local_files::{open_regular, OpenRefusal};

    let dir = tempfile::tempdir().unwrap();
    let fifo = dir.path().join("pipe.html");
    let c_path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    // SAFETY: a NUL-terminated path that lives across the call.
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0, "mkfifo");

    let started = Instant::now();
    let opened = open_nonblocking(&fifo).expect("a FIFO with no writer opens for reading");
    assert!(started.elapsed() < Duration::from_secs(2), "the open did not wait for a writer");
    assert!(!opened.metadata().unwrap().is_file());

    let started = Instant::now();
    assert!(matches!(open_regular(&fifo), Err(OpenRefusal::NotAFile)));
    assert!(started.elapsed() < Duration::from_secs(2));
}
