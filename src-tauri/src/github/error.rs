//! Failure taxonomy for GitHub ops. `code()` values are the TS
//! `GITHUB_ERROR_CODES`; every transport returns the same code and message.

/// Most chars of `gh` stderr carried into an error message.
const MAX_DETAIL_CHARS: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GithubError {
    CliMissing,
    Unauthenticated {
        host: String,
    },
    NotGithubRepo,
    NoUpstream,
    /// `until` is the ISO 8601 time calls resume.
    RateLimited {
        until: String,
    },
    NotFound(String),
    NotMergeable(String),
    Timeout,
    Failed(String),
}

impl GithubError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::CliMissing => "GH_CLI_MISSING",
            Self::Unauthenticated { .. } => "GH_UNAUTHENTICATED",
            Self::NotGithubRepo => "GH_NOT_GITHUB_REPO",
            Self::NoUpstream => "GH_NO_UPSTREAM",
            Self::RateLimited { .. } => "GH_RATE_LIMITED",
            Self::NotFound(_) => "GH_NOT_FOUND",
            Self::NotMergeable(_) => "GH_NOT_MERGEABLE",
            Self::Timeout => "GH_TIMEOUT",
            Self::Failed(_) => "GH_FAILED",
        }
    }
}

impl std::fmt::Display for GithubError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CliMissing => f.write_str("The GitHub CLI (gh) is not installed"),
            Self::Unauthenticated { host } => write!(f, "gh is not signed in to {host}"),
            Self::NotGithubRepo => f.write_str("This project is not a GitHub repository gh knows"),
            Self::NoUpstream => f.write_str("This repository is not a fork, so it has no upstream"),
            Self::RateLimited { until } => {
                write!(f, "GitHub rate limit reached; retry after {until}")
            }
            Self::NotFound(detail) => write!(f, "Not found on GitHub: {detail}"),
            Self::NotMergeable(detail) => write!(f, "The pull request cannot be merged: {detail}"),
            Self::Timeout => f.write_str("gh did not respond in time"),
            Self::Failed(detail) => write!(f, "gh failed: {detail}"),
        }
    }
}

impl std::error::Error for GithubError {}

/// What a failed `gh` run's stderr says went wrong. Rate limits are matched
/// before auth because a rate-limited anonymous call also prints `gh auth login`.
pub(super) enum StderrKind {
    RateLimited,
    Unauthenticated,
    NotFound,
    NotMergeable,
    Other,
}

pub(super) fn stderr_kind(stderr: &str) -> StderrKind {
    let lower = stderr.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));
    if has(&["rate limit", "submitted too quickly"]) {
        StderrKind::RateLimited
    } else if has(&[
        "http 401",
        "bad credentials",
        "gh auth login",
        "not logged in",
        "authentication required",
        "requires authentication",
    ]) {
        StderrKind::Unauthenticated
    } else if has(&["could not resolve", "http 404", "not found"]) {
        StderrKind::NotFound
    } else if has(&[
        "not mergeable",
        "merge conflict",
        "is not in a mergeable state",
    ]) {
        StderrKind::NotMergeable
    } else {
        StderrKind::Other
    }
}

/// The error for a non-zero `gh` exit that is not a rate limit (the runner
/// handles those, since they open the shared backoff window).
pub(super) fn classify_failure(stderr: &str, host: &str) -> GithubError {
    let detail = bounded(stderr);
    match stderr_kind(stderr) {
        StderrKind::Unauthenticated => GithubError::Unauthenticated {
            host: host.to_string(),
        },
        StderrKind::NotFound => GithubError::NotFound(detail),
        StderrKind::NotMergeable => GithubError::NotMergeable(detail),
        StderrKind::RateLimited | StderrKind::Other => GithubError::Failed(detail),
    }
}

pub(super) fn bounded(stderr: &str) -> String {
    let trimmed = stderr.trim();
    let trimmed = trimmed.strip_prefix("gh: ").unwrap_or(trimmed);
    match trimmed.char_indices().nth(MAX_DETAIL_CHARS) {
        Some((idx, _)) => format!("{}…", &trimmed[..idx]),
        None => trimmed.to_string(),
    }
}
