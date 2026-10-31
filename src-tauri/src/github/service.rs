//! [`GithubService`]: the GitHub ops every transport calls. Blocking; the
//! Tauri commands and web routes run them on the blocking pool.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::auth::{self, HostInventory};
use super::cache::{CacheKey, QuotaReserve, ReadCache, READ_TTL};
use super::checks::{self, CHECK_FIELDS, LOG_READ_BYTES};
use super::detail::{self, MergeState};
use super::error::GithubError;
use super::graphql::{self, GraphqlVar};
use super::items;
use super::repo::{self, RemoteRoute};
use super::runner::{GhCall, GhProcess, GhRunner, SystemGh, DEFAULT_HOST};
use super::types::*;
use crate::git_remote::{git_remote_url, parse_remote_url};

/// A later `gh auth login` (or install) is picked up within this.
const INVENTORY_TTL: Duration = Duration::from_secs(60);
const UPSTREAM_TTL: Duration = Duration::from_secs(10 * 60);

static SHARED: OnceLock<Arc<GithubService>> = OnceLock::new();

pub(crate) struct GithubService {
    runner: GhRunner,
    inventory: Mutex<Option<(Instant, Result<HostInventory, GithubError>)>>,
    upstreams: Mutex<HashMap<GithubRepoRef, (Instant, Option<GithubRepoRef>)>>,
    cache: ReadCache,
    reserve: QuotaReserve,
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn remote_route(cwd: &str) -> RemoteRoute {
    repo::route_remote(git_remote_url(cwd).and_then(|url| parse_remote_url(&url)))
}

impl GithubService {
    /// The process's service: one cache, one rate-limit window and one `gh`
    /// concurrency cap for the desktop and every web client.
    pub(crate) fn shared() -> Arc<Self> {
        SHARED
            .get_or_init(|| Arc::new(Self::with_process(Box::new(SystemGh))))
            .clone()
    }

    pub(super) fn with_process(process: Box<dyn GhProcess>) -> Self {
        Self {
            runner: GhRunner::new(process),
            inventory: Mutex::new(None),
            upstreams: Mutex::new(HashMap::new()),
            cache: ReadCache::default(),
            reserve: QuotaReserve::default(),
        }
    }

    fn inventory(&self) -> Result<HostInventory, GithubError> {
        self.inventory_within(INVENTORY_TTL)
    }

    fn inventory_within(&self, max_age: Duration) -> Result<HostInventory, GithubError> {
        let mut slot = self.inventory.lock();
        if let Some((loaded, result)) = slot.as_ref() {
            if loaded.elapsed() < max_age {
                return result.clone();
            }
        }
        let result = auth::load_inventory(&self.runner);
        match &result {
            Ok(inventory) => log::info!(
                "[github] gh auth inventory loaded: hosts={:?}",
                inventory.hosts.keys().collect::<Vec<_>>()
            ),
            Err(error) => log::warn!(
                "[github] gh auth inventory failed code={}: {error}",
                error.code()
            ),
        }
        if matches!(result, Ok(_) | Err(GithubError::CliMissing)) {
            *slot = Some((Instant::now(), result.clone()));
        }
        result
    }

    fn upstream(&self, origin: &GithubRepoRef) -> Result<Option<GithubRepoRef>, GithubError> {
        if let Some((loaded, parent)) = self.upstreams.lock().get(origin) {
            if loaded.elapsed() < UPSTREAM_TTL {
                return Ok(parent.clone());
            }
        }
        let stdout = self.runner.stdout(&GhCall::new(
            Some(&origin.host),
            ["repo", "view", &origin.qualified(), "--json", "parent"],
        ))?;
        let parent = repo::parse_parent(&stdout, origin)
            .ok_or_else(|| GithubError::Failed("unreadable gh repo view output".to_string()))?;
        self.upstreams
            .lock()
            .insert(origin.clone(), (Instant::now(), parent.clone()));
        Ok(parent)
    }

    /// The repository a request's slot names. The host reaches `gh` only
    /// after it passes [`repo::host_allowed`].
    fn target(&self, cwd: &str, slot: GithubRepoSlot) -> Result<GithubRepoRef, GithubError> {
        let RemoteRoute::Candidate(origin) = remote_route(cwd) else {
            return Err(GithubError::NotGithubRepo);
        };
        let inventory = self.inventory()?;
        let unauthenticated = || GithubError::Unauthenticated {
            host: origin.host.clone(),
        };
        if !repo::host_allowed(&origin.host, inventory.knows(&origin.host)) {
            return Err(unauthenticated());
        }
        if !matches!(
            inventory.status_for(&origin.host),
            GithubAuthStatus::Connected { .. }
        ) {
            return Err(unauthenticated());
        }
        match slot {
            GithubRepoSlot::Origin => Ok(origin),
            GithubRepoSlot::Upstream => self.upstream(&origin)?.ok_or(GithubError::NoUpstream),
        }
    }

    fn run_op<T>(
        &self,
        op: &'static str,
        cwd: &str,
        slot: GithubRepoSlot,
        body: impl FnOnce(&GithubRepoRef) -> Result<T, GithubError>,
    ) -> Result<T, GithubError> {
        log::debug!("[github] {op} start cwd={cwd} slot={slot:?}");
        let repo = self.target(cwd, slot).inspect_err(|error| {
            log::warn!(
                "[github] {op} failed cwd={cwd} code={}: {error}",
                error.code()
            );
        })?;
        let result = body(&repo);
        match &result {
            Ok(_) => log::info!("[github] {op} ok repo={repo}"),
            Err(error) => log::warn!(
                "[github] {op} failed repo={repo} code={}: {error}",
                error.code()
            ),
        }
        result
    }

    /// A cached read. `refresh` skips the cache, except in quota reserve,
    /// where any cached value is served until the budget resets.
    fn read<T: Clone + Send + Sync + 'static>(
        &self,
        repo: &GithubRepoRef,
        op: String,
        refresh: bool,
        fetch: impl FnOnce() -> Result<T, GithubError>,
    ) -> Result<T, GithubError> {
        let key = CacheKey {
            repo: repo.clone(),
            op,
        };
        let reserve = self.reserve.active(&repo.host);
        if reserve || !refresh {
            let max_age = (!reserve).then_some(READ_TTL);
            if let Some(hit) = self.cache.get::<T>(&key, max_age) {
                log::debug!(
                    "[github] cache hit {} repo={repo} reserve={reserve}",
                    key.op
                );
                return Ok(hit);
            }
        }
        let value = fetch()?;
        self.cache.put(key, value.clone());
        Ok(value)
    }

    fn graphql(
        &self,
        repo: &GithubRepoRef,
        query: &str,
        vars: &[(&str, GraphqlVar<'_>)],
    ) -> Result<serde_json::Value, GithubError> {
        let data = graphql::run_graphql(&self.runner, &repo.host, query, vars)?;
        if let Some(budget) = graphql::rate_budget(&data) {
            self.reserve.observe(&repo.host, &budget);
        }
        Ok(data)
    }

    fn merge_state(&self, repo: &GithubRepoRef, number: u64) -> Result<MergeState, GithubError> {
        let data = self.graphql(
            repo,
            &detail::merge_state_graphql(),
            &[
                ("owner", GraphqlVar::Str(&repo.owner)),
                ("name", GraphqlVar::Str(&repo.name)),
                ("number", GraphqlVar::Int(number)),
            ],
        )?;
        detail::parse_merge_state(&data)
    }

    pub(crate) fn context(&self, cwd: &str) -> Result<GithubContext, GithubError> {
        log::debug!("[github] context start cwd={cwd}");
        let route = remote_route(cwd);
        let host = match &route {
            RemoteRoute::Candidate(origin) => origin.host.clone(),
            _ => DEFAULT_HOST.to_string(),
        };
        // Re-ask gh unless the cached answer is "connected", so a sign-in or
        // install shows up on the next refresh instead of after the TTL.
        let cached_connected = matches!(
            self.inventory.lock().as_ref(),
            Some((_, Ok(inventory)))
                if matches!(inventory.status_for(&host), GithubAuthStatus::Connected { .. })
        );
        let max_age = if cached_connected {
            INVENTORY_TTL
        } else {
            Duration::ZERO
        };
        let inventory = match self.inventory_within(max_age) {
            Ok(inventory) => inventory,
            Err(GithubError::CliMissing) => {
                let repo = match route {
                    RemoteRoute::Candidate(origin) if origin.host == DEFAULT_HOST => {
                        GithubRepoResolution::Resolved {
                            origin,
                            upstream: None,
                        }
                    }
                    _ => GithubRepoResolution::NotGithub,
                };
                return Ok(GithubContext {
                    auth: GithubAuthStatus::CliMissing,
                    repo,
                });
            }
            Err(error) => return Err(error),
        };
        let origin = match route {
            RemoteRoute::Candidate(origin) => origin,
            RemoteRoute::NoGithubRemote | RemoteRoute::OtherForge => {
                return Ok(GithubContext {
                    auth: inventory.status_for(DEFAULT_HOST),
                    repo: GithubRepoResolution::NotGithub,
                });
            }
        };
        if !repo::host_allowed(&origin.host, inventory.knows(&origin.host)) {
            log::info!(
                "[github] context: {} is not a host gh is signed in to; no gh call made",
                origin.host
            );
            return Ok(GithubContext {
                auth: inventory.status_for(&origin.host),
                repo: GithubRepoResolution::NotGithub,
            });
        }
        let auth = inventory.status_for(&origin.host);
        let upstream = match auth {
            GithubAuthStatus::Connected { .. } => self.upstream(&origin).unwrap_or_else(|error| {
                log::warn!(
                    "[github] fork parent lookup failed repo={origin} code={}: {error}",
                    error.code()
                );
                None
            }),
            _ => None,
        };
        log::info!(
            "[github] context ok repo={origin} fork={}",
            upstream.is_some()
        );
        Ok(GithubContext {
            auth,
            repo: GithubRepoResolution::Resolved { origin, upstream },
        })
    }

    pub(crate) fn list_items(
        &self,
        request: &GithubListRequest,
    ) -> Result<GithubListResult, GithubError> {
        self.run_op("list_items", &request.cwd, request.filter.repo, |repo| {
            let Some(query) = items::search_query(repo, &request.filter) else {
                return Ok(GithubListResult {
                    repo: repo.clone(),
                    items: Vec::new(),
                    fetched_at: now_iso(),
                });
            };
            self.read(repo, format!("items:{query}"), request.refresh, || {
                let data = self.graphql(
                    repo,
                    &items::search_graphql(),
                    &[("q", GraphqlVar::Str(&query))],
                )?;
                Ok(GithubListResult {
                    repo: repo.clone(),
                    items: items::parse_search(&data),
                    fetched_at: now_iso(),
                })
            })
        })
    }

    pub(crate) fn get_item(
        &self,
        request: &GithubItemRequest,
    ) -> Result<GithubItemDetail, GithubError> {
        let number = request.number;
        self.run_op("get_item", &request.cwd, request.repo, |repo| {
            let op = format!("item:{:?}:{number}", request.kind);
            self.read(repo, op, request.refresh, || {
                let data = self.graphql(
                    repo,
                    &detail::detail_graphql(),
                    &[
                        ("owner", GraphqlVar::Str(&repo.owner)),
                        ("name", GraphqlVar::Str(&repo.name)),
                        ("number", GraphqlVar::Int(number)),
                    ],
                )?;
                let node = detail::parse_item_node(&data, request.kind, number)?;
                let item = node
                    .list_item()
                    .ok_or_else(|| GithubError::NotFound(format!("#{number}")))?;
                Ok(GithubItemDetail {
                    repo: repo.clone(),
                    pr: (request.kind == GithubItemKind::Pr).then(|| detail::pull_detail(&node)),
                    body: node.body.clone().unwrap_or_default(),
                    created_at: node.created_at.clone().unwrap_or_default(),
                    comments: node
                        .comments
                        .as_ref()
                        .map(|c| c.nodes.iter().flatten().map(|n| n.to_comment()).collect())
                        .unwrap_or_default(),
                    item,
                    fetched_at: now_iso(),
                })
            })
        })
    }

    pub(crate) fn get_checks(
        &self,
        request: &GithubChecksRequest,
    ) -> Result<GithubChecksResult, GithubError> {
        let number = request.number;
        self.run_op("get_checks", &request.cwd, request.repo, |repo| {
            self.read(repo, format!("checks:{number}"), request.refresh, || {
                let head = self.merge_state(repo, number)?;
                let call = GhCall::new(
                    Some(&repo.host),
                    [
                        "pr",
                        "checks",
                        &number.to_string(),
                        "--repo",
                        &repo.qualified(),
                        "--json",
                        CHECK_FIELDS,
                    ],
                );
                let output = self.runner.output(&call)?;
                let checks = if output.success {
                    checks::parse_checks(&output.stdout).ok_or_else(|| {
                        GithubError::Failed("unreadable gh pr checks output".to_string())
                    })?
                } else if checks::is_no_checks(&output.stderr) {
                    Vec::new()
                } else {
                    return Err(self.runner.failure(&call, &output));
                };
                Ok(GithubChecksResult {
                    head_sha: head.head_sha,
                    rollup: checks::rollup(&checks),
                    checks,
                    fetched_at: now_iso(),
                })
            })
        })
    }

    pub(crate) fn get_check_log(
        &self,
        request: &GithubCheckLogRequest,
    ) -> Result<GithubCheckLog, GithubError> {
        let job_id = request.job_id;
        self.run_op("get_check_log", &request.cwd, request.repo, |repo| {
            self.read(repo, format!("log:{job_id}"), false, || {
                let path = format!(
                    "repos/{}/{}/actions/jobs/{job_id}/logs",
                    repo.owner, repo.name
                );
                // gh ≥ 2.80 refuses to print escape codes without the flag;
                // older gh lacks the flag and prints them anyway.
                let mut call =
                    GhCall::new(Some(&repo.host), ["api", "--allow-escape-sequences", &path])
                        .keep_tail(LOG_READ_BYTES + 1);
                let mut output = self.runner.output(&call)?;
                if !output.success && output.stderr.contains("unknown flag") {
                    call =
                        GhCall::new(Some(&repo.host), ["api", &path]).keep_tail(LOG_READ_BYTES + 1);
                    output = self.runner.output(&call)?;
                }
                if !output.success {
                    return Err(self.runner.failure(&call, &output));
                }
                let cut = output.stdout.len() > LOG_READ_BYTES;
                let raw = if cut {
                    &output.stdout[1..]
                } else {
                    &output.stdout[..]
                };
                let (tail, truncated) = checks::log_tail(raw, cut);
                Ok(GithubCheckLog {
                    job_id,
                    tail,
                    truncated,
                })
            })
        })
    }

    pub(crate) fn merge(
        &self,
        request: &GithubMergeRequest,
    ) -> Result<GithubMergeResult, GithubError> {
        let number = request.number;
        self.run_op("merge", &request.cwd, request.repo, |repo| {
            log::info!(
                "[github] merge {:?} repo={repo} number={number}",
                request.action
            );
            let number_arg = number.to_string();
            let qualified = repo.qualified();
            let mut args: Vec<String> = ["pr", "merge", &number_arg, "--repo", &qualified]
                .map(str::to_string)
                .to_vec();
            match request.action {
                GithubMergeAction::Merge { method } => {
                    let state = self.merge_state(repo, number)?;
                    if !direct_merge_allowed(&state) {
                        return Err(GithubError::NotMergeable(format!(
                            "GitHub reports the pull request as {} ({})",
                            state.state, state.merge_state_status
                        )));
                    }
                    args.extend([
                        method.flag().to_string(),
                        "--match-head-commit".to_string(),
                        state.head_sha,
                    ]);
                }
                GithubMergeAction::EnableAutoMerge { method } => {
                    args.extend(["--auto".to_string(), method.flag().to_string()]);
                }
                GithubMergeAction::DisableAutoMerge => args.push("--disable-auto".to_string()),
            }
            let result = self.runner.stdout(&GhCall::new(Some(&repo.host), args));
            // Even a failed write may have changed state on GitHub.
            self.cache.invalidate_repo(repo);
            result.map(|_| GithubMergeResult { number })
        })
    }
}

/// GitHub allows a direct merge without bypassing protections only in these
/// merge states.
fn direct_merge_allowed(state: &MergeState) -> bool {
    state.state == "OPEN" && matches!(state.merge_state_status.as_str(), "CLEAN" | "HAS_HOOKS")
}
