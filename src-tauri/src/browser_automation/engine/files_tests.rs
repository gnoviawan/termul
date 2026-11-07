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
            value.starts_with("0081;") && value.trim_end().ends_with(";Termul;"),
            "{value}"
        );
    }
}
