use std::time::Duration;

use axum::{
    extract::Request,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};

use crate::web::command_ledger::{AdmissionWatch, IN_PROGRESS_RECEIPT};
use crate::web::fs_api::IpcBody;

const TIMED_OUT_CODE: &str = "TIMED_OUT";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RouteClass {
    Read,
    Write,
    Ledgered,
}

const READ_ROUTES: &[&str] = &[
    "/git/status",
    "/git/diff",
    "/git/log",
    "/git/commit-detail",
    "/git/commit-file-diff",
    "/git/commit-context",
    "/git/stash-list",
    "/git/branch-list",
    "/git/diff-stat",
    "/worktree/list",
    "/worktree/branches",
    "/worktree/check-dirty",
    "/worktree/resolve-base-branch",
    "/worktree/parse-gitignore",
];

fn class_of(request: &Request) -> Option<RouteClass> {
    let path = request.uri().path();
    if !(path.starts_with("/git/") || path.starts_with("/worktree/")) {
        return None;
    }
    Some(if READ_ROUTES.contains(&path) {
        RouteClass::Read
    } else {
        RouteClass::Write
    })
}

impl RouteClass {
    fn deadline(self) -> Duration {
        match self {
            Self::Read => Duration::from_secs(60),
            Self::Write | Self::Ledgered => Duration::from_secs(180),
        }
    }

    fn reply(self, path: &str) -> IpcBody<()> {
        let secs = self.deadline().as_secs();
        match self {
            Self::Read => IpcBody::err(format!("{path} did not answer within {secs}s"), TIMED_OUT_CODE),
            Self::Write => IpcBody::err(
                format!(
                    "{path} did not finish within {secs}s. It may still complete on the host; check its state before retrying"
                ),
                TIMED_OUT_CODE,
            ),
            Self::Ledgered => IpcBody {
                success: true,
                data: None,
                error: None,
                code: None,
                receipt: Some(IN_PROGRESS_RECEIPT.to_string()),
            },
        }
    }
}

pub async fn bound(request: Request, next: Next) -> Response {
    let Some(class) = class_of(&request) else {
        return next.run(request).await;
    };
    let path = request.uri().path().to_string();
    let admission = AdmissionWatch::default();
    match tokio::time::timeout(class.deadline(), admission.watch(next.run(request))).await {
        Ok(response) => response,
        Err(_) => {
            let class = if admission.admitted() {
                RouteClass::Ledgered
            } else {
                class
            };
            tracing::warn!(
                target: "termul::web::route_deadline",
                path = %path,
                class = ?class,
                deadline_secs = class.deadline().as_secs(),
                "route outlived its deadline; answered without waiting for its blocking work"
            );
            (StatusCode::OK, Json(class.reply(&path))).into_response()
        }
    }
}

#[cfg(test)]
mod tests;
