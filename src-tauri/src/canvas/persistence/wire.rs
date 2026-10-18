//! The persistence boundary both transports call: parses what the renderer
//! forwards from the editor (version digits, the `host.openDocument` ack
//! text, the `host.snapshot` result text) into typed values and encodes
//! document bytes as base64 for the trip back. Bytes are never logged.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};

use super::{CanvasPersistence, DirtyOutcome, PersistenceView, WriteOutcome};
use crate::canvas::CanvasError;

/// A request body or editor reply that does not parse.
pub const CODE_INVALID_PAYLOAD: &str = "INVALID_PAYLOAD";
/// A write was attempted before the document loaded (AD-31).
pub const CODE_CANVAS_NOT_READY: &str = "CANVAS_NOT_READY";
/// The document exists but could not be read.
pub const CODE_READ_FAILED: &str = "READ_FAILED";

fn invalid(what: &str, detail: impl std::fmt::Display) -> CanvasError {
    CanvasError::new(CODE_INVALID_PAYLOAD, format!("invalid {what}: {detail}"))
}

/// The document's bytes as base64, or `None` when the file does not exist
/// yet (a new document: the editor starts empty and the first save creates
/// the file).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentBytes {
    pub bytes: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionReply {
    content_version: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotReply {
    content_version: u64,
    bytes: String,
}

pub fn parse_version(text: &str) -> Result<u64, CanvasError> {
    text.trim()
        .parse()
        .map_err(|error| invalid("contentVersion", error))
}

pub async fn read_document(
    mounts: &CanvasPersistence,
    project_id: &str,
    mount_seq: u64,
) -> Result<DocumentBytes, CanvasError> {
    let path = mounts.doc_path(project_id, mount_seq)?;
    let read = tokio::task::spawn_blocking(move || std::fs::read(path))
        .await
        .unwrap_or_else(|join| Err(std::io::Error::other(join.to_string())));
    match read {
        Ok(bytes) => Ok(DocumentBytes {
            bytes: Some(BASE64.encode(bytes)),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(DocumentBytes { bytes: None })
        }
        Err(error) => Err(CanvasError::new(
            CODE_READ_FAILED,
            format!("could not read the canvas document: {error}"),
        )),
    }
}

/// `ack` is the `host.openDocument` result text, or `None` for a new
/// document that was not opened from disk.
pub fn document_loaded(
    mounts: &CanvasPersistence,
    project_id: &str,
    mount_seq: u64,
    ack: Option<&str>,
) -> Result<PersistenceView, CanvasError> {
    let content_version = ack
        .map(|text| {
            serde_json::from_str::<VersionReply>(text)
                .map(|reply| reply.content_version)
                .map_err(|error| invalid("host.openDocument ack", error))
        })
        .transpose()?;
    mounts.document_loaded(project_id, mount_seq, content_version)
}

/// `snapshot` is the `host.snapshot` result text `{contentVersion, bytes}`.
pub async fn write_snapshot(
    mounts: &CanvasPersistence,
    project_id: &str,
    mount_seq: u64,
    snapshot: &str,
) -> Result<WriteOutcome, CanvasError> {
    let reply: SnapshotReply =
        serde_json::from_str(snapshot).map_err(|error| invalid("host.snapshot result", error))?;
    let bytes = BASE64
        .decode(reply.bytes.as_bytes())
        .map_err(|error| invalid("host.snapshot bytes", error))?;
    mounts
        .write_snapshot(project_id, mount_seq, reply.content_version, bytes)
        .await
}

/// `content_version` is the engine's u64 as decimal text.
pub async fn dirty_changed(
    mounts: &CanvasPersistence,
    project_id: &str,
    mount_seq: u64,
    dirty: bool,
    content_version: &str,
) -> Result<DirtyOutcome, CanvasError> {
    let content_version = parse_version(content_version)?;
    mounts
        .dirty_changed(project_id, mount_seq, dirty, content_version)
        .await
}
