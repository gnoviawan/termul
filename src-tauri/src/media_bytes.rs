use std::fs;
use std::io::{self, Read};
use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Video,
    Pdf,
}

impl MediaKind {
    pub const fn max_bytes(self) -> u64 {
        const MIB: u64 = 1024 * 1024;
        match self {
            MediaKind::Image => 25 * MIB,
            MediaKind::Video => 100 * MIB,
            MediaKind::Pdf => 50 * MIB,
        }
    }
}

pub const MEDIA_TYPES: &[(&str, MediaKind, &str)] = &[
    ("png", MediaKind::Image, "image/png"),
    ("jpg", MediaKind::Image, "image/jpeg"),
    ("jpeg", MediaKind::Image, "image/jpeg"),
    ("gif", MediaKind::Image, "image/gif"),
    ("webp", MediaKind::Image, "image/webp"),
    ("bmp", MediaKind::Image, "image/bmp"),
    ("avif", MediaKind::Image, "image/avif"),
    ("ico", MediaKind::Image, "image/x-icon"),
    ("svg", MediaKind::Image, "image/svg+xml"),
    ("mp4", MediaKind::Video, "video/mp4"),
    ("m4v", MediaKind::Video, "video/mp4"),
    ("webm", MediaKind::Video, "video/webm"),
    ("mov", MediaKind::Video, "video/quicktime"),
    ("ogv", MediaKind::Video, "video/ogg"),
    ("pdf", MediaKind::Pdf, "application/pdf"),
];

pub fn media_type_for_path(path: &Path) -> Option<(MediaKind, &'static str)> {
    let ext = path.extension()?.to_str()?;
    MEDIA_TYPES
        .iter()
        .find(|(known, _, _)| known.eq_ignore_ascii_case(ext))
        .map(|&(_, kind, mime)| (kind, mime))
}

pub fn log_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaErrorCode {
    UnsupportedMedia,
    FileTooLarge,
    NotFound,
    NotAFile,
    ReadError,
    InvalidPath,
    PathTraversal,
}

impl MediaErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            MediaErrorCode::UnsupportedMedia => "UNSUPPORTED_MEDIA",
            MediaErrorCode::FileTooLarge => "FILE_TOO_LARGE",
            MediaErrorCode::NotFound => "NOT_FOUND",
            MediaErrorCode::NotAFile => "NOT_A_FILE",
            MediaErrorCode::ReadError => "READ_ERROR",
            MediaErrorCode::InvalidPath => "INVALID_PATH",
            MediaErrorCode::PathTraversal => "PATH_TRAVERSAL",
        }
    }
}

impl Serialize for MediaErrorCode {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// Set only on `FILE_TOO_LARGE`, so callers never parse the numbers out of the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MediaSizeLimit {
    pub size: u64,
    pub limit: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MediaReadError {
    pub code: MediaErrorCode,
    pub message: String,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub too_large: Option<MediaSizeLimit>,
}

impl MediaReadError {
    pub fn new(code: MediaErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            too_large: None,
        }
    }

    fn io(err: &io::Error) -> Self {
        if err.kind() == io::ErrorKind::NotFound {
            Self::new(MediaErrorCode::NotFound, "file not found")
        } else {
            Self::new(
                MediaErrorCode::ReadError,
                format!("failed to read file: {err}"),
            )
        }
    }

    fn too_large(kind: MediaKind, size: u64) -> Self {
        let limit = kind.max_bytes();
        Self {
            too_large: Some(MediaSizeLimit { size, limit }),
            ..Self::new(
                MediaErrorCode::FileTooLarge,
                format!("file too large ({size} bytes, max {limit})"),
            )
        }
    }
}

#[derive(Debug)]
pub struct MediaBytes {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

pub fn read_media(path: &Path) -> Result<MediaBytes, MediaReadError> {
    let canonical = path.canonicalize().map_err(|e| MediaReadError::io(&e))?;
    let (kind, mime) = media_type_for_path(&canonical).ok_or_else(|| {
        MediaReadError::new(
            MediaErrorCode::UnsupportedMedia,
            "not a supported image, video, or PDF file",
        )
    })?;
    let metadata = fs::metadata(&canonical).map_err(|e| MediaReadError::io(&e))?;
    if !metadata.is_file() {
        return Err(MediaReadError::new(
            MediaErrorCode::NotAFile,
            "path is not a regular file",
        ));
    }
    let cap = kind.max_bytes();
    if metadata.len() > cap {
        return Err(MediaReadError::too_large(kind, metadata.len()));
    }
    let file = fs::File::open(&canonical).map_err(|e| MediaReadError::io(&e))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| MediaReadError::io(&e))?;
    if bytes.len() as u64 > cap {
        return Err(MediaReadError::too_large(kind, bytes.len() as u64));
    }
    Ok(MediaBytes { bytes, mime })
}

#[cfg(test)]
#[path = "media_bytes_tests.rs"]
mod tests;
