//! Run and step ledger: insert, settle exactly once, reconcile, prune.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{from_i64, from_wire, to_i64, AutomationStore, StoreError, StoreResult};
use crate::automation::model::{
    wire_name, AutomationId, NodeId, Run, RunId, RunStatus, RunTrigger, SettledStatus, Step,
};
use crate::automation::schedule::backoff_ms;

pub const STRANDED_REASON: &str = "stranded";

#[derive(Debug, Clone, PartialEq)]
pub enum SettleOutcome {
    Settled(Box<Run>),
    /// The run was already terminal; nothing changed.
    AlreadySettled,
}

impl AutomationStore {
    pub fn insert_run(&self, run: &Run) -> StoreResult<()> {
        self.conn()?.execute(
            "INSERT INTO automation_run (id, automation_id, revision, graph_json, trigger,
                scheduled_for, status, started_at, finished_at, stop_reason, summary,
                conversation_id, worktree_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                run.id.as_str(),
                run.automation_id.as_str(),
                to_i64(run.revision),
                serde_json::to_string(&run.graph)?,
                wire_name(&run.trigger),
                run.scheduled_for,
                wire_name(&run.status),
                run.started_at,
                run.finished_at,
                run.stop_reason,
                run.summary,
                run.conversation_id,
                run.worktree_id,
            ],
        )?;
        Ok(())
    }

    pub fn get_run(&self, id: &RunId) -> StoreResult<Option<Run>> {
        get_run(&*self.conn()?, id)
    }

    pub fn has_active_run(&self, automation_id: &AutomationId) -> StoreResult<bool> {
        Ok(self.conn()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM automation_run WHERE automation_id = ?1 AND status = 'running')",
            params![automation_id.as_str()],
            |r| r.get(0),
        )?)
    }

    /// Newest first.
    pub fn list_runs(&self, automation_id: &AutomationId, limit: usize) -> StoreResult<Vec<Run>> {
        let db = self.conn()?;
        let mut stmt = db.prepare(
            "SELECT * FROM automation_run WHERE automation_id = ?1
             ORDER BY started_at DESC, rowid DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            params![
                automation_id.as_str(),
                i64::try_from(limit).unwrap_or(i64::MAX)
            ],
            read_run,
        )?;
        rows.map(|r| r?).collect()
    }

    /// Moves a `running` run to its terminal status and folds the outcome
    /// into the automation's counters, in one transaction. A second settle of
    /// the same run is a no-op.
    pub fn settle_run(
        &self,
        id: &RunId,
        status: SettledStatus,
        stop_reason: Option<&str>,
        summary: Option<&str>,
        now_ms: i64,
    ) -> StoreResult<SettleOutcome> {
        let db = self.conn()?;
        settle_locked(&db, id, status, stop_reason, summary, now_ms)
    }

    /// Records a step. A step that already finished is never overwritten, so
    /// a replayed engine write cannot re-run or rewrite it. Returns whether
    /// the row changed.
    pub fn upsert_step(&self, step: &Step) -> StoreResult<bool> {
        let output = step
            .output
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let changed = self.conn()?.execute(
            "INSERT INTO automation_step (run_id, node_id, status, output_json, error, started_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(run_id, node_id) DO UPDATE SET
                status = excluded.status,
                output_json = excluded.output_json,
                error = excluded.error,
                started_at = COALESCE(automation_step.started_at, excluded.started_at),
                finished_at = excluded.finished_at
             WHERE automation_step.status = 'running'",
            params![
                step.run_id.as_str(),
                step.node_id.as_str(),
                wire_name(&step.status),
                output,
                step.error,
                step.started_at,
                step.finished_at,
            ],
        )?;
        Ok(changed == 1)
    }

    pub fn get_steps(&self, run_id: &RunId) -> StoreResult<Vec<Step>> {
        let db = self.conn()?;
        let mut stmt =
            db.prepare("SELECT * FROM automation_step WHERE run_id = ?1 ORDER BY rowid")?;
        let rows = stmt.query_map(params![run_id.as_str()], read_step)?;
        rows.map(|r| r?).collect()
    }

    /// Boot recovery: runs left `running` by a dead process are settled
    /// `failed` (never re-fired) and their running steps fail with them.
    pub fn reconcile_stranded(&self, now_ms: i64) -> StoreResult<usize> {
        let db = self.conn()?;
        let ids: Vec<RunId> = {
            let mut stmt = db.prepare("SELECT id FROM automation_run WHERE status = 'running'")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.map(|r| r.map(RunId::from)).collect::<Result<_, _>>()?
        };
        db.execute(
            "UPDATE automation_step SET status = 'failed', error = ?1, finished_at = ?2
             WHERE status = 'running'",
            params![STRANDED_REASON, now_ms],
        )?;
        for id in &ids {
            settle_locked(
                &db,
                id,
                SettledStatus::Failed,
                Some(STRANDED_REASON),
                None,
                now_ms,
            )?;
        }
        log::info!("[Automation] reconciled {} stranded run(s)", ids.len());
        Ok(ids.len())
    }

    /// Deletes finished runs (and their steps) that ended before `cutoff_ms`.
    pub fn prune_runs(&self, cutoff_ms: i64) -> StoreResult<usize> {
        let db = self.conn()?;
        let tx = db.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM automation_step WHERE run_id IN (
                SELECT id FROM automation_run WHERE status != 'running' AND finished_at < ?1)",
            params![cutoff_ms],
        )?;
        let removed = tx.execute(
            "DELETE FROM automation_run WHERE status != 'running' AND finished_at < ?1",
            params![cutoff_ms],
        )?;
        tx.commit()?;
        if removed > 0 {
            log::info!("[Automation] pruned {removed} run(s)");
        }
        Ok(removed)
    }
}

fn get_run(db: &Connection, id: &RunId) -> StoreResult<Option<Run>> {
    db.query_row(
        "SELECT * FROM automation_run WHERE id = ?1",
        params![id.as_str()],
        read_run,
    )
    .optional()?
    .transpose()
}

struct Counters {
    consecutive_errors: u32,
    unseen_failures: u32,
    next_run_at: Option<i64>,
}

/// Manual runs never move the cadence: they leave `consecutive_errors` and
/// `next_run_at` alone but still show in `last_run` and the failure badge.
fn settle_locked(
    db: &Connection,
    id: &RunId,
    status: SettledStatus,
    stop_reason: Option<&str>,
    summary: Option<&str>,
    now_ms: i64,
) -> StoreResult<SettleOutcome> {
    let tx = db.unchecked_transaction()?;
    let changed = tx.execute(
        "UPDATE automation_run SET status = ?1, finished_at = ?2, stop_reason = ?3, summary = ?4
         WHERE id = ?5 AND status = 'running'",
        params![
            wire_name(&RunStatus::from(status)),
            now_ms,
            stop_reason,
            summary,
            id.as_str()
        ],
    )?;
    if changed == 0 {
        return match get_run(&tx, id)? {
            Some(_) => Ok(SettleOutcome::AlreadySettled),
            None => Err(StoreError::NotFound(id.to_string())),
        };
    }
    let run = get_run(&tx, id)?.ok_or_else(|| StoreError::NotFound(id.to_string()))?;
    if status != SettledStatus::Skipped {
        let mut c = tx.query_row(
            "SELECT consecutive_errors, unseen_failures, next_run_at FROM automation WHERE id = ?1",
            params![run.automation_id.as_str()],
            |r| {
                Ok(Counters {
                    consecutive_errors: r.get(0)?,
                    unseen_failures: r.get(1)?,
                    next_run_at: r.get(2)?,
                })
            },
        )?;
        let cadence = run.trigger != RunTrigger::Manual;
        match status {
            SettledStatus::Succeeded if cadence => c.consecutive_errors = 0,
            SettledStatus::Failed => {
                c.unseen_failures += 1;
                if cadence {
                    c.consecutive_errors += 1;
                    let delay = backoff_ms(c.consecutive_errors).unwrap_or(0);
                    c.next_run_at = c.next_run_at.map(|n| n.max(now_ms + delay));
                }
            }
            _ => {}
        }
        tx.execute(
            "UPDATE automation SET consecutive_errors = ?1, unseen_failures = ?2, next_run_at = ?3,
                last_run_id = ?4, last_run_status = ?5, last_run_finished_at = ?6
             WHERE id = ?7",
            params![
                c.consecutive_errors,
                c.unseen_failures,
                c.next_run_at,
                id.as_str(),
                wire_name(&run.status),
                now_ms,
                run.automation_id.as_str(),
            ],
        )?;
    }
    tx.commit()?;
    log::info!(
        "[Automation] settled run {id} of {} as {}",
        run.automation_id,
        wire_name(&run.status)
    );
    Ok(SettleOutcome::Settled(Box::new(run)))
}

fn read_run(row: &Row<'_>) -> rusqlite::Result<StoreResult<Run>> {
    let id: String = row.get("id")?;
    let automation_id: String = row.get("automation_id")?;
    let revision: i64 = row.get("revision")?;
    let graph: String = row.get("graph_json")?;
    let trigger: String = row.get("trigger")?;
    let status: String = row.get("status")?;
    let scheduled_for: i64 = row.get("scheduled_for")?;
    let started_at: i64 = row.get("started_at")?;
    let finished_at: Option<i64> = row.get("finished_at")?;
    let stop_reason: Option<String> = row.get("stop_reason")?;
    let summary: Option<String> = row.get("summary")?;
    let conversation_id: Option<String> = row.get("conversation_id")?;
    let worktree_id: Option<String> = row.get("worktree_id")?;
    Ok((|| {
        Ok(Run {
            id: id.into(),
            automation_id: automation_id.into(),
            revision: from_i64(revision),
            graph: serde_json::from_str(&graph)?,
            trigger: from_wire(trigger)?,
            scheduled_for,
            status: from_wire(status)?,
            started_at,
            finished_at,
            stop_reason,
            summary,
            conversation_id,
            worktree_id,
        })
    })())
}

fn read_step(row: &Row<'_>) -> rusqlite::Result<StoreResult<Step>> {
    let run_id: String = row.get("run_id")?;
    let node_id: String = row.get("node_id")?;
    let status: String = row.get("status")?;
    let output: Option<String> = row.get("output_json")?;
    let error: Option<String> = row.get("error")?;
    let started_at: Option<i64> = row.get("started_at")?;
    let finished_at: Option<i64> = row.get("finished_at")?;
    Ok((|| {
        Ok(Step {
            run_id: run_id.into(),
            node_id: NodeId::parse(node_id).map_err(|e| StoreError::Corrupt(e.to_string()))?,
            status: from_wire(status)?,
            output: output.as_deref().map(serde_json::from_str).transpose()?,
            error,
            started_at,
            finished_at,
        })
    })())
}
