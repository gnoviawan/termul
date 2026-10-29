use super::*;
use std::fs::File;

const MIB: u64 = 1024 * 1024;

fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).expect("write fixture");
    path
}

fn sparse(dir: &Path, name: &str, len: u64) -> std::path::PathBuf {
    let path = dir.join(name);
    File::create(&path)
        .and_then(|f| f.set_len(len))
        .expect("create sparse fixture");
    path
}

fn read_err(path: &Path) -> MediaReadError {
    read_media(path).expect_err("read should fail")
}

#[test]
fn reads_image_video_and_pdf_with_their_mime() {
    let dir = tempfile::tempdir().expect("tempdir");
    for (name, kind, mime) in [
        ("chart.PNG", MediaKind::Image, "image/png"),
        ("photo.jpeg", MediaKind::Image, "image/jpeg"),
        ("icon.svg", MediaKind::Image, "image/svg+xml"),
        ("clip.mov", MediaKind::Video, "video/quicktime"),
        ("clip.m4v", MediaKind::Video, "video/mp4"),
        ("doc.pdf", MediaKind::Pdf, "application/pdf"),
    ] {
        let path = write(dir.path(), name, b"ABC");
        let media = read_media(&path).expect(name);
        assert_eq!(media.bytes, b"ABC", "{name}");
        assert_eq!(media.mime, mime, "{name}");
        assert_eq!(media_type_for_path(&path), Some((kind, mime)), "{name}");
    }
}

#[test]
fn refuses_unsupported_extensions() {
    let dir = tempfile::tempdir().expect("tempdir");
    for name in ["notes.txt", "Makefile", "archive.tar.gz", "audio.mp3"] {
        let path = write(dir.path(), name, b"x");
        let err = read_err(&path);
        assert_eq!(err.code, MediaErrorCode::UnsupportedMedia, "{name}");
    }
}

#[cfg(unix)]
#[test]
fn checks_the_extension_on_the_symlink_target() {
    let dir = tempfile::tempdir().expect("tempdir");
    let secret = write(dir.path(), "secret.txt", b"token");
    let link = dir.path().join("innocent.png");
    std::os::unix::fs::symlink(&secret, &link).expect("symlink");
    assert_eq!(read_err(&link).code, MediaErrorCode::UnsupportedMedia);
}

#[test]
fn missing_file_is_not_found() {
    let dir = tempfile::tempdir().expect("tempdir");
    let err = read_err(&dir.path().join("gone.png"));
    assert_eq!(err.code, MediaErrorCode::NotFound);
    assert_eq!(err.message, "file not found");
}

#[test]
fn directory_with_a_media_extension_is_not_a_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let folder = dir.path().join("frames.png");
    fs::create_dir(&folder).expect("mkdir");
    assert_eq!(read_err(&folder).code, MediaErrorCode::NotAFile);
}

#[test]
fn caps_each_kind_at_its_own_limit() {
    let dir = tempfile::tempdir().expect("tempdir");
    let image = sparse(dir.path(), "big.png", 30 * MIB);
    let err = read_err(&image);
    assert_eq!(err.code, MediaErrorCode::FileTooLarge);
    assert_eq!(err.message, "file too large (31457280 bytes, max 26214400)");
    let video = sparse(dir.path(), "big.webm", 30 * MIB);
    assert_eq!(
        read_media(&video).expect("video").bytes.len() as u64,
        30 * MIB
    );
    let pdf = sparse(dir.path(), "big.pdf", 30 * MIB);
    assert_eq!(read_media(&pdf).expect("pdf").bytes.len() as u64, 30 * MIB);

    let over_pdf = sparse(dir.path(), "huge.pdf", 50 * MIB + 1);
    assert_eq!(read_err(&over_pdf).code, MediaErrorCode::FileTooLarge);
    let over_video = sparse(dir.path(), "huge.mp4", 100 * MIB + 1);
    assert_eq!(read_err(&over_video).code, MediaErrorCode::FileTooLarge);
}

#[test]
fn a_file_exactly_at_the_cap_is_read() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = sparse(dir.path(), "edge.gif", 25 * MIB);
    assert_eq!(
        read_media(&path).expect("at cap").bytes.len() as u64,
        25 * MIB
    );
}

#[test]
fn error_serializes_as_code_and_message() {
    let err = MediaReadError::new(MediaErrorCode::NotAFile, "path is not a regular file");
    assert_eq!(
        serde_json::to_value(&err).expect("serialize"),
        serde_json::json!({ "code": "NOT_A_FILE", "message": "path is not a regular file" })
    );
}
