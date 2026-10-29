use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use axum::{
    body::{Body, Bytes},
    extract::{rejection::QueryRejection, Query},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::{resolve_request_path, PathQuery};
use crate::media_bytes::{
    check_requested_kind, log_name, read_media, MediaBytes, MediaErrorCode, MediaReadError,
    MediaSizeLimit,
};

/// Each response holds a whole file (up to 100 MiB) in memory, so at most this
/// many are read or sent at once; further requests wait for a slot.
const MAX_CONCURRENT_RAW: usize = 4;
const CHUNK_BYTES: usize = 256 * 1024;

fn raw_permits() -> Arc<Semaphore> {
    static PERMITS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    PERMITS
        .get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_RAW)))
        .clone()
}

/// The sandbox CSP keeps an SVG opened as a top-level document from running
/// script against the server origin.
const RAW_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

pub async fn raw(query: Result<Query<PathQuery>, QueryRejection>) -> Response {
    let Ok(Query(q)) = query else {
        return refuse(
            "",
            MediaReadError::new(
                MediaErrorCode::InvalidPath,
                "missing or invalid `path` query parameter",
            ),
        );
    };
    let name = log_name(Path::new(&q.path));
    let Ok(permit) = raw_permits().acquire_owned().await else {
        return refuse(
            &name,
            MediaReadError::new(MediaErrorCode::ReadError, "media reads are shut down"),
        );
    };
    let result = match resolve_request_path(Path::new(&q.path)) {
        Ok(path) => match check_requested_kind(Path::new(&q.path), &path) {
            Ok(()) => read_blocking(path).await,
            Err(err) => Err(err),
        },
        Err((message, code)) => Err(MediaReadError::new(
            if code == "PATH_TRAVERSAL" {
                MediaErrorCode::PathTraversal
            } else {
                MediaErrorCode::ReadError
            },
            message,
        )),
    };
    match result {
        Ok(media) => {
            tracing::debug!(
                target: "termul::web::fs_api",
                file = %name,
                size = media.bytes.len(),
                "fs/raw served"
            );
            (
                [
                    (header::CONTENT_TYPE, HeaderValue::from_static(media.mime)),
                    (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
                    (
                        header::X_CONTENT_TYPE_OPTIONS,
                        HeaderValue::from_static("nosniff"),
                    ),
                    (
                        header::CONTENT_SECURITY_POLICY,
                        HeaderValue::from_static(RAW_CSP),
                    ),
                    (header::CONTENT_LENGTH, HeaderValue::from(media.bytes.len())),
                ],
                body_holding(permit, media.bytes),
            )
                .into_response()
        }
        Err(err) => refuse(&name, err),
    }
}

fn refuse(name: &str, err: MediaReadError) -> Response {
    tracing::warn!(
        target: "termul::web::fs_api",
        file = %name,
        code = err.code.as_str(),
        "fs/raw refused"
    );
    (status_for(err.code), Json(RawFailure::from(err))).into_response()
}

/// Streams `bytes` in chunks and releases `permit` only after the last chunk.
fn body_holding(permit: OwnedSemaphorePermit, bytes: Vec<u8>) -> Body {
    let bytes = Bytes::from(bytes);
    let stream = futures::stream::unfold((bytes, permit), |(rest, permit)| async move {
        if rest.is_empty() {
            return None;
        }
        let mut rest = rest;
        let chunk = rest.split_to(rest.len().min(CHUNK_BYTES));
        Some((Ok::<_, std::convert::Infallible>(chunk), (rest, permit)))
    });
    Body::from_stream(stream)
}

/// The `IpcBody` failure shape plus the `FILE_TOO_LARGE` size and limit.
#[derive(Serialize)]
struct RawFailure {
    success: bool,
    error: String,
    code: MediaErrorCode,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    too_large: Option<MediaSizeLimit>,
}

impl From<MediaReadError> for RawFailure {
    fn from(err: MediaReadError) -> Self {
        Self {
            success: false,
            error: err.message,
            code: err.code,
            too_large: err.too_large,
        }
    }
}

async fn read_blocking(path: PathBuf) -> Result<MediaBytes, MediaReadError> {
    tokio::task::spawn_blocking(move || read_media(&path))
        .await
        .unwrap_or_else(|e| {
            Err(MediaReadError::new(
                MediaErrorCode::ReadError,
                format!("read task failed: {e}"),
            ))
        })
}

fn status_for(code: MediaErrorCode) -> StatusCode {
    match code {
        MediaErrorCode::PathTraversal | MediaErrorCode::InvalidPath => StatusCode::BAD_REQUEST,
        MediaErrorCode::NotFound => StatusCode::NOT_FOUND,
        MediaErrorCode::NotAFile => StatusCode::UNPROCESSABLE_ENTITY,
        MediaErrorCode::FileTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        MediaErrorCode::UnsupportedMedia => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        MediaErrorCode::ReadError => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

#[cfg(test)]
#[path = "media_raw_tests.rs"]
mod tests;
