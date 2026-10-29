//! `GET /fs/raw?path=...`: the bytes of an image, video, or PDF (the web twin
//! of the desktop `read_media_bytes` command), read through the shared
//! [`crate::media_bytes`] service.
//!
//! The path guards are exactly those of `GET /fs/read`: `resolve_request_path`
//! (`..` rejection + canonicalization) and no project-root jail (ADR-007). The
//! extension allowlist and per-kind size caps come from the service. Unlike
//! the JSON routes, failures use real HTTP statuses because a success body is
//! raw bytes; the failure body is still the usual `{ success: false, error,
//! code }`.

use std::path::{Path, PathBuf};

use axum::{
    extract::Query,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};

use super::{resolve_request_path, IpcBody, PathQuery};
use crate::media_bytes::{log_name, read_media, MediaBytes, MediaErrorCode, MediaReadError};

/// Served with every success body. The sandbox CSP keeps an SVG opened as a
/// top-level document from running script against the server origin.
const RAW_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

pub async fn raw(Query(q): Query<PathQuery>) -> Response {
    let name = log_name(Path::new(&q.path));
    let result = match resolve_request_path(Path::new(&q.path)) {
        Ok(path) => read_blocking(path).await,
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
                ],
                media.bytes,
            )
                .into_response()
        }
        Err(err) => {
            tracing::warn!(
                target: "termul::web::fs_api",
                file = %name,
                code = err.code.as_str(),
                "fs/raw refused"
            );
            (
                status_for(err.code),
                Json(IpcBody::<()>::err(err.message, err.code.as_str())),
            )
                .into_response()
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
