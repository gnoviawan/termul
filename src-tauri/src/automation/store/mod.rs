//! Durable automations, runs and steps in a dedicated `automations.sqlite`.
//!
//! `next_run_at` is owned here: every write that can change whether an
//! automation is armed recomputes it, so it is `Some` exactly when the
//! automation is armed and has a schedule with a future slot.

mod runs;
mod secret_names;
mod suggestions;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::de::DeserializeOwned;

use super::graph;
use super::model::{wire_name, Automation, AutomationId, Issue, LastRun, Schedule};
use super::schedule::{compute_next_run, ScheduleError};

pub use runs::SettleOutcome;

pub const DB_FILE_NAME: &str = "automations.sqlite";

/// Each entry upgrades `user_version` N to N+1. Append only.
const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE automation (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    revision INTEGER NOT NULL,
    approved_revision INTEGER,
    enabled INTEGER NOT NULL,
    trigger_json TEXT NOT NULL,
    graph_json TEXT NOT NULL,
    isolation TEXT NOT NULL,
    next_run_at INTEGER,
    consecutive_errors INTEGER NOT NULL DEFAULT 0,
    schedule_error_count INTEGER NOT NULL DEFAULT 0,
    unseen_failures INTEGER NOT NULL DEFAULT 0,
    last_run_id TEXT,
    last_run_status TEXT,
    last_run_finished_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE INDEX idx_automation_project ON automation(project_id);
CREATE INDEX idx_automation_due ON automation(next_run_at) WHERE next_run_at IS NOT NULL;
CREATE TABLE automation_run (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automation(id),
    revision INTEGER NOT NULL,
    graph_json TEXT NOT NULL,
    trigger TEXT NOT NULL,
    scheduled_for INTEGER NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    stop_reason TEXT,
    summary TEXT,
    conversation_id TEXT,
    worktree_id TEXT
);
CREATE INDEX idx_run_automation ON automation_run(automation_id, started_at);
CREATE INDEX idx_run_status ON automation_run(status);
CREATE TABLE automation_step (
    run_id TEXT NOT NULL REFERENCES automation_run(id),
    node_id TEXT NOT NULL,
    status TEXT NOT NULL,
    output_json TEXT,
    error TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    PRIMARY KEY (run_id, node_id)
);
"#, r#"
CREATE TABLE automation_secret_name (
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (project_id, name)
);
"#, r#"
CREATE TABLE automation_suggestion_dismissed (
    project_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    dismissed_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, fingerprint)
);
CREATE TABLE automation_suggestion_accepted (
    project_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    accepted_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, fingerprint)
);
"#];

#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    Poisoned,
    NotFound(String),
    /// The caller's revision is stale; `current` is what the store holds.
    RevisionConflict {
        current: u64,
    },
    HasIssues(Vec<Issue>),
    Corrupt(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Sqlite(e) => write!(f, "automation store: {e}"),
            StoreError::Json(e) => write!(f, "automation store json: {e}"),
            StoreError::Poisoned => f.write_str("automation store lock poisoned"),
            StoreError::NotFound(id) => write!(f, "{id} not found"),
            StoreError::RevisionConflict { current } => {
                write!(
                    f,
                    "revision conflict: the automation is at revision {current}"
                )
            }
            StoreError::HasIssues(issues) => {
                write!(f, "cannot approve with {} open issue(s)", issues.len())
            }
            StoreError::Corrupt(reason) => write!(f, "automation store row is corrupt: {reason}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        StoreError::Json(e)
    }
}

pub type StoreResult<T> = Result<T, StoreError>;

#[derive(Debug, Clone, PartialEq)]
pub enum ClaimOutcome {
    /// This caller owns the slot; `automation` is the row as claimed.
    Claimed {
        automation: Box<Automation>,
        scheduled_for: i64,
    },
    /// Another claimant moved `next_run_at` first, or the row changed.
    Lost,
    /// The schedule could not be evaluated; the slot was not fired.
    ScheduleBroken { disabled: bool },
}

const SCHEDULE_ERROR_LIMIT: u32 = 3;
const SCHEDULE_ERROR_RETRY_MS: i64 = 60_000;

pub struct AutomationStore {
    db: Mutex<Connection>,
}

impl AutomationStore {
    pub fn open(path: &Path) -> StoreResult<Self> {
        let db = Connection::open(path)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&db)?;
        log::info!("[Automation] store opened");
        Ok(Self { db: Mutex::new(db) })
    }

    pub fn open_in_memory() -> StoreResult<Self> {
        let db = Connection::open_in_memory()?;
        migrate(&db)?;
        Ok(Self { db: Mutex::new(db) })
    }

    fn conn(&self) -> StoreResult<MutexGuard<'_, Connection>> {
        self.db.lock().map_err(|_| StoreError::Poisoned)
    }

    pub fn create(&self, automation: &Automation, now_ms: i64) -> StoreResult<Automation> {
        let mut row = automation.clone();
        row.next_run_at = armed_next_run(&row, now_ms);
        let db = self.conn()?;
        db.execute(
            "INSERT INTO automation (id, project_id, name, revision, approved_revision, enabled,
                trigger_json, graph_json, isolation, next_run_at, consecutive_errors,
                schedule_error_count, unseen_failures, last_run_id, last_run_status,
                last_run_finished_at, created_at, updated_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
            params![
                row.id.as_str(),
                row.project_id,
                row.name,
                to_i64(row.revision),
                row.approved_revision.map(to_i64),
                row.enabled,
                serde_json::to_string(&row.trigger)?,
                serde_json::to_string(&row.graph)?,
                wire_name(&row.isolation),
                row.next_run_at,
                row.consecutive_errors,
                row.schedule_error_count,
                row.unseen_failures,
                row.last_run.as_ref().map(|l| l.run_id.to_string()),
                row.last_run.as_ref().map(|l| wire_name(&l.status)),
                row.last_run.as_ref().map(|l| l.finished_at),
                row.created_at,
                row.updated_at,
                row.deleted_at,
            ],
        )?;
        Ok(row)
    }

    /// The live (not deleted) automation with this id.
    pub fn get(&self, id: &AutomationId) -> StoreResult<Option<Automation>> {
        get_live(&*self.conn()?, id)
    }

    pub fn list(&self, project_id: Option<&str>) -> StoreResult<Vec<Automation>> {
        let db = self.conn()?;
        let mut stmt = db.prepare(
            "SELECT * FROM automation WHERE deleted_at IS NULL AND (?1 IS NULL OR project_id = ?1)
             ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map(params![project_id], read_automation)?;
        rows.map(|r| r?).collect()
    }

    /// Persists the authored fields of `automation` if the stored revision is
    /// still `base_revision`. Counters and run bookkeeping are left alone so a
    /// concurrent settle is never overwritten.
    pub fn save(
        &self,
        automation: &Automation,
        base_revision: u64,
        now_ms: i64,
    ) -> StoreResult<Automation> {
        let db = self.conn()?;
        let current = get_live(&db, &automation.id)?
            .ok_or_else(|| StoreError::NotFound(automation.id.to_string()))?;
        let mut next = current.clone();
        next.name = automation.name.clone();
        next.revision = automation.revision;
        next.trigger = automation.trigger.clone();
        next.graph = automation.graph.clone();
        next.isolation = automation.isolation;
        next.updated_at = now_ms;
        next.next_run_at = armed_next_run(&next, now_ms);
        let changed = db.execute(
            "UPDATE automation SET name = ?1, revision = ?2, trigger_json = ?3, graph_json = ?4,
                isolation = ?5, next_run_at = ?6, updated_at = ?7
             WHERE id = ?8 AND revision = ?9 AND deleted_at IS NULL",
            params![
                next.name,
                to_i64(next.revision),
                serde_json::to_string(&next.trigger)?,
                serde_json::to_string(&next.graph)?,
                wire_name(&next.isolation),
                next.next_run_at,
                now_ms,
                next.id.as_str(),
                to_i64(base_revision),
            ],
        )?;
        if changed == 0 {
            return Err(StoreError::RevisionConflict {
                current: current.revision,
            });
        }
        Ok(next)
    }

    pub fn soft_delete(&self, id: &AutomationId, now_ms: i64) -> StoreResult<bool> {
        let changed = self.conn()?.execute(
            "UPDATE automation SET deleted_at = ?1, enabled = 0, next_run_at = NULL, updated_at = ?1
             WHERE id = ?2 AND deleted_at IS NULL",
            params![now_ms, id.as_str()],
        )?;
        Ok(changed == 1)
    }

    /// Enabling clears the schedule error count, so an automation the engine
    /// auto-disabled gets a fresh budget.
    pub fn set_enabled(
        &self,
        id: &AutomationId,
        enabled: bool,
        now_ms: i64,
    ) -> StoreResult<Automation> {
        let db = self.conn()?;
        let mut a = get_live(&db, id)?.ok_or_else(|| StoreError::NotFound(id.to_string()))?;
        a.enabled = enabled;
        if enabled {
            a.schedule_error_count = 0;
        }
        a.updated_at = now_ms;
        a.next_run_at = armed_next_run(&a, now_ms);
        db.execute(
            "UPDATE automation SET enabled = ?1, schedule_error_count = ?2, next_run_at = ?3,
                updated_at = ?4 WHERE id = ?5",
            params![
                enabled,
                a.schedule_error_count,
                a.next_run_at,
                now_ms,
                id.as_str()
            ],
        )?;
        Ok(a)
    }

    /// User approval of exactly `revision`. Refused on a stale revision or
    /// while the pure validator reports issues; the agent-registry check is
    /// the caller's.
    pub fn approve(
        &self,
        id: &AutomationId,
        revision: u64,
        now_ms: i64,
    ) -> StoreResult<Automation> {
        let db = self.conn()?;
        let mut a = get_live(&db, id)?.ok_or_else(|| StoreError::NotFound(id.to_string()))?;
        if a.revision != revision {
            return Err(StoreError::RevisionConflict {
                current: a.revision,
            });
        }
        let issues = graph::validate(&a);
        if !issues.is_empty() {
            return Err(StoreError::HasIssues(issues));
        }
        a.approved_revision = Some(revision);
        a.updated_at = now_ms;
        a.next_run_at = armed_next_run(&a, now_ms);
        db.execute(
            "UPDATE automation SET approved_revision = ?1, next_run_at = ?2, updated_at = ?3
             WHERE id = ?4 AND revision = ?1",
            params![to_i64(revision), a.next_run_at, now_ms, id.as_str()],
        )?;
        log::info!("[Automation] approved {id} at revision {revision}");
        Ok(a)
    }

    pub fn list_due(&self, now_ms: i64) -> StoreResult<Vec<Automation>> {
        let db = self.conn()?;
        let mut stmt = db.prepare(
            "SELECT * FROM automation
             WHERE next_run_at IS NOT NULL AND next_run_at <= ?1 AND enabled = 1
               AND deleted_at IS NULL AND approved_revision = revision
             ORDER BY next_run_at, id",
        )?;
        let rows = stmt.query_map(params![now_ms], read_automation)?;
        rows.map(|r| r?).collect()
    }

    /// Compare-and-swap on `next_run_at`: only the caller whose `expected`
    /// value is still stored wins the slot. The new value is the first slot
    /// after `now`, which is what collapses a backlog into one fire. An `at`
    /// schedule has a single slot, so claiming it also disables it.
    pub fn claim_due(
        &self,
        id: &AutomationId,
        expected_next_run_at: i64,
        now_ms: i64,
    ) -> StoreResult<ClaimOutcome> {
        let db = self.conn()?;
        let Some(a) = get_live(&db, id)? else {
            return Ok(ClaimOutcome::Lost);
        };
        let Some(schedule) = a.schedule().filter(|_| a.armed()) else {
            return Ok(ClaimOutcome::Lost);
        };
        match compute_next_run(schedule, now_ms) {
            Ok(next) => {
                let one_shot = matches!(schedule, Schedule::At { .. });
                let changed = db.execute(
                    "UPDATE automation SET next_run_at = ?1, schedule_error_count = 0,
                        enabled = CASE WHEN ?2 THEN 0 ELSE enabled END
                     WHERE id = ?3 AND next_run_at = ?4",
                    params![next, one_shot, id.as_str(), expected_next_run_at],
                )?;
                if changed == 0 {
                    log::info!("[Automation] claim lost {id}");
                    return Ok(ClaimOutcome::Lost);
                }
                log::info!("[Automation] claimed {id} slot {expected_next_run_at}");
                let mut claimed = a.clone();
                claimed.next_run_at = next;
                claimed.schedule_error_count = 0;
                claimed.enabled = claimed.enabled && !one_shot;
                Ok(ClaimOutcome::Claimed {
                    automation: Box::new(claimed),
                    scheduled_for: expected_next_run_at,
                })
            }
            Err(e) => schedule_broken(&db, &a, expected_next_run_at, now_ms, &e),
        }
    }

    pub fn mark_seen(&self, id: &AutomationId) -> StoreResult<()> {
        self.conn()?.execute(
            "UPDATE automation SET unseen_failures = 0 WHERE id = ?1",
            params![id.as_str()],
        )?;
        Ok(())
    }
}

fn schedule_broken(
    db: &Connection,
    a: &Automation,
    expected_next_run_at: i64,
    now_ms: i64,
    error: &ScheduleError,
) -> StoreResult<ClaimOutcome> {
    let count = a.schedule_error_count + 1;
    let disabled = count >= SCHEDULE_ERROR_LIMIT;
    let retry_at = (!disabled).then_some(now_ms + SCHEDULE_ERROR_RETRY_MS);
    let changed = db.execute(
        "UPDATE automation SET schedule_error_count = ?1, next_run_at = ?2,
            enabled = CASE WHEN ?3 THEN 0 ELSE enabled END
         WHERE id = ?4 AND next_run_at = ?5",
        params![
            count,
            retry_at,
            disabled,
            a.id.as_str(),
            expected_next_run_at
        ],
    )?;
    if changed == 0 {
        return Ok(ClaimOutcome::Lost);
    }
    log::warn!(
        "[Automation] schedule error {count}/{SCHEDULE_ERROR_LIMIT} for {}: {error}{}",
        a.id,
        if disabled { "; disabled" } else { "" }
    );
    Ok(ClaimOutcome::ScheduleBroken { disabled })
}

/// The `next_run_at` an automation should hold: the first slot after `now`
/// when armed with a schedule, otherwise none. A schedule that cannot be
/// evaluated also yields none; validation keeps those from being approved.
fn armed_next_run(a: &Automation, now_ms: i64) -> Option<i64> {
    let schedule = a.schedule().filter(|_| a.armed())?;
    compute_next_run(schedule, now_ms).ok().flatten()
}

fn migrate(db: &Connection) -> StoreResult<()> {
    let version: usize = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version) {
        let target = i + 1;
        let tx = db.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", target)?;
        tx.commit()?;
        log::info!("[Automation] store migrated to schema {target}");
    }
    Ok(())
}

fn get_live(db: &Connection, id: &AutomationId) -> StoreResult<Option<Automation>> {
    db.query_row(
        "SELECT * FROM automation WHERE id = ?1 AND deleted_at IS NULL",
        params![id.as_str()],
        read_automation,
    )
    .optional()?
    .transpose()
}

fn to_i64(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

fn from_i64(v: i64) -> u64 {
    u64::try_from(v).unwrap_or(0)
}

/// Parses a unit enum from its serde name, the inverse of [`wire_name`].
fn from_wire<T: DeserializeOwned>(name: String) -> StoreResult<T> {
    Ok(serde_json::from_value(serde_json::Value::String(name))?)
}

/// Rows map in two steps: rusqlite reads the columns, then JSON and enum
/// columns parse, so a corrupt row surfaces as a typed store error.
fn read_automation(row: &Row<'_>) -> rusqlite::Result<StoreResult<Automation>> {
    let trigger: String = row.get("trigger_json")?;
    let graph: String = row.get("graph_json")?;
    let isolation: String = row.get("isolation")?;
    let last_run_id: Option<String> = row.get("last_run_id")?;
    let last_run_status: Option<String> = row.get("last_run_status")?;
    let last_run_finished_at: Option<i64> = row.get("last_run_finished_at")?;
    let id: String = row.get("id")?;
    let project_id: String = row.get("project_id")?;
    let name: String = row.get("name")?;
    let revision: i64 = row.get("revision")?;
    let approved_revision: Option<i64> = row.get("approved_revision")?;
    let enabled: bool = row.get("enabled")?;
    let next_run_at: Option<i64> = row.get("next_run_at")?;
    let consecutive_errors: u32 = row.get("consecutive_errors")?;
    let schedule_error_count: u32 = row.get("schedule_error_count")?;
    let unseen_failures: u32 = row.get("unseen_failures")?;
    let created_at: i64 = row.get("created_at")?;
    let updated_at: i64 = row.get("updated_at")?;
    let deleted_at: Option<i64> = row.get("deleted_at")?;
    Ok((|| {
        let last_run = match (last_run_id, last_run_status, last_run_finished_at) {
            (Some(run_id), Some(status), Some(finished_at)) => Some(LastRun {
                run_id: run_id.into(),
                status: from_wire(status)?,
                finished_at,
            }),
            _ => None,
        };
        Ok(Automation {
            id: id.into(),
            project_id,
            name,
            revision: from_i64(revision),
            approved_revision: approved_revision.map(from_i64),
            enabled,
            trigger: serde_json::from_str(&trigger)?,
            graph: serde_json::from_str(&graph)?,
            isolation: from_wire(isolation)?,
            next_run_at,
            consecutive_errors,
            schedule_error_count,
            unseen_failures,
            last_run,
            created_at,
            updated_at,
            deleted_at,
        })
    })())
}
