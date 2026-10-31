//! GitHub issues & PRs through the host's `gh` CLI (spec-github-integration,
//! CAP-1 to CAP-4 and CAP-9). Termul holds no GitHub token: every read and
//! write runs `gh`, so the UI, the web/phone client and the user's agents
//! share one login.
//!
//! [`GithubService`] owns the ops; `commands::github` (Tauri) and
//! `web::github_api` (`/github/*`) are thin transports over it.

mod auth;
mod cache;
mod checks;
mod detail;
mod error;
mod graphql;
mod items;
mod repo;
mod runner;
mod service;
mod types;

pub(crate) use error::GithubError;
pub(crate) use service::GithubService;
pub(crate) use types::*;

#[cfg(test)]
mod auth_tests;
#[cfg(test)]
mod checks_tests;
#[cfg(test)]
mod fake_gh;
#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod query_tests;
#[cfg(test)]
mod runner_tests;
#[cfg(test)]
mod service_tests;
