//! Run and step ledger: insert, park and resume, settle exactly once,
//! reconcile, prune.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{Map, Value};

use super::{from_i64, from_wire, to_i64, AutomationStore, StoreError, StoreResult};
use crate::automation::model::{
    wire_name, AutomationId, NodeId, Parked, Run, RunId, RunStatus, RunTrigger, SettledStatus,
    Step, StepStatus,
};
use crate::automation::schedule::backoff_ms;

pub const STRANDED_REASON: &str = "stranded";

#[derive(Debug, Clone, PartialEq)]
pub enum SettleOutcome {
    Settled(Box<Run>),
    /// The run was already terminal; nothing changed.
    AlreadySettled,
}

/// A waiting run and where it is parked.
#[derive(Debug, Clone, PartialEq)]
pub struct ParkedRun {
    pub run_id: RunId,
    pub automation_id: AutomationId,
    pub parked: Parked,
}

/// How a park ends, as the store writes it.
#[derive(Debug, Clone, PartialEq)]
pub struct ParkDecision<'a> {
    /// The parked step's terminal status.
    pub status: StepStatus,
    pub error: Option<&'a str>,
    /// Merged into the waiting step's output.
    pub fields: Map<String, Value>,
    /// The claim fails when the park expired at or before this instant.
    pub before_ms: Option<i64>,
}

impl AutomationStore {
    pub fn insert_run(&self, run: &Run) -> StoreResult<()> {
        self.conn()?.execute(
            "INSERT INTO automation_run (id, automation_id, revision, graph_json, trigger,
                scheduled_for, status, started_at, finished_at, stop_reason, summary,
                conversation_id, worktree_id, parked_node, parked_until)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
                run.parked.as_ref().map(|p| p.node_id.as_str()),
                run.parked.as_ref().map(|p| p.until),
            ],
        )?;
        Ok(())
    }

    pub fn get_run(&self, id: &RunId) -> StoreResult<Option<Run>> {
        get_run(&*self.conn()?, id)
    }

    /// A `running` or `waiting` run: either one blocks an overlapping run.
    pub fn has_active_run(&self, automation_id: &AutomationId) -> StoreResult<bool> {
        Ok(self.conn()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM automation_run
             WHERE automation_id = ?1 AND status IN ('running', 'waiting'))",
            params![automation_id.as_str()],
            |r| r.get(0),
        )?)
    }

    /// The project of a run's automation, deleted or not.
    pub fn run_project_id(&self, run_id: &RunId) -> StoreResult<Option<String>> {
        Ok(self
            .conn()?
            .query_row(
                "SELECT a.project_id FROM automation_run r JOIN automation a ON a.id = r.automation_id
                 WHERE r.id = ?1",
                params![run_id.as_str()],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Parks a `running` run at `node_id` until `until`: the node's step
    /// turns `waiting` with `output`, in one transaction. `false` when the
    /// run is not running.
    pub fn park_run(
        &self,
        run_id: &RunId,
        node_id: &NodeId,
        until: i64,
        output: &Value,
        now_ms: i64,
    ) -> StoreResult<bool> {
        let db = self.conn()?;
        let tx = db.unchecked_transaction()?;
        let parked = tx.execute(
            "UPDATE automation_run SET status = 'waiting', parked_node = ?1, parked_until = ?2
             WHERE id = ?3 AND status = 'running'",
            params![node_id.as_str(), until, run_id.as_str()],
        )?;
        if parked == 0 {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO automation_step (run_id, node_id, status, output_json, error, started_at, finished_at)
             VALUES (?1, ?2, 'waiting', ?3, NULL, ?4, NULL)
             ON CONFLICT(run_id, node_id) DO UPDATE SET
                status = 'waiting', output_json = excluded.output_json, error = NULL, finished_at = NULL",
            params![
                run_id.as_str(),
                node_id.as_str(),
                serde_json::to_string(output)?,
                now_ms
            ],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Claims a run parked at `node_id` back to `running` and turns its
    /// waiting step terminal, its output merged with `decision.fields`. The
    /// claim is the one arbiter between every way a park ends: `None` when
    /// the run is no longer waiting there, or when `decision.before_ms` is
    /// set and the park expired by then.
    pub fn resume_parked(
        &self,
        run_id: &RunId,
        node_id: &NodeId,
        decision: ParkDecision<'_>,
        now_ms: i64,
    ) -> StoreResult<Option<Run>> {
        let ParkDecision {
            status: step_status,
            error,
            fields: decision_fields,
            before_ms,
        } = decision;
        let db = self.conn()?;
        let tx = db.unchecked_transaction()?;
        let claimed = tx.execute(
            "UPDATE automation_run SET status = 'running', parked_node = NULL, parked_until = NULL
             WHERE id = ?1 AND status = 'waiting' AND parked_node = ?2
                AND (?3 IS NULL OR parked_until > ?3)",
            params![run_id.as_str(), node_id.as_str(), before_ms],
        )?;
        if claimed == 0 {
            return Ok(None);
        }
        let waiting: Option<String> = tx
            .query_row(
                "SELECT output_json FROM automation_step WHERE run_id = ?1 AND node_id = ?2",
                params![run_id.as_str(), node_id.as_str()],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let mut output = match waiting.as_deref().map(serde_json::from_str).transpose()? {
            Some(Value::Object(fields)) => fields,
            _ => Map::new(),
        };
        output.extend(decision_fields);
        tx.execute(
            "UPDATE automation_step SET status = ?1, error = ?2, output_json = ?3, finished_at = ?4
             WHERE run_id = ?5 AND node_id = ?6 AND status = 'waiting'",
            params![
                wire_name(&step_status),
                error,
                serde_json::to_string(&Value::Object(output))?,
                now_ms,
                run_id.as_str(),
                node_id.as_str()
            ],
        )?;
        let run = get_run(&tx, run_id)?.ok_or_else(|| StoreError::NotFound(run_id.to_string()))?;
        tx.commit()?;
        Ok(Some(run))
    }

    /// Waiting runs whose park expired at or before `now_ms`.
    pub fn list_expired_parks(&self, now_ms: i64) -> StoreResult<Vec<ParkedRun>> {
        self.parked_runs(
            "SELECT id, automation_id, parked_node, parked_until FROM automation_run
             WHERE parked_until IS NOT NULL AND parked_until <= ?1 AND status = 'waiting'
             ORDER BY parked_until, id",
            params![now_ms],
        )
    }

    /// The waiting run of `automation_id`, if any.
    pub fn parked_run_of(&self, automation_id: &AutomationId) -> StoreResult<Option<ParkedRun>> {
        Ok(self
            .parked_runs(
                "SELECT id, automation_id, parked_node, parked_until FROM automation_run
                 WHERE automation_id = ?1 AND status = 'waiting' AND parked_node IS NOT NULL",
                params![automation_id.as_str()],
            )?
            .into_iter()
            .next())
    }

    fn parked_runs(&self, sql: &str, args: impl rusqlite::Params) -> StoreResult<Vec<ParkedRun>> {
        let db = self.conn()?;
        let mut stmt = db.prepare(sql)?;
        let rows = stmt.query_map(args, |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        rows.map(|row| {
            let (run_id, automation_id, node_id, until) = row?;
            Ok(ParkedRun {
                run_id: run_id.into(),
                automation_id: automation_id.into(),
                parked: Parked {
                    node_id: NodeId::parse(node_id)
                        .map_err(|e| StoreError::Corrupt(e.to_string()))?,
                    until,
                },
            })
        })
        .collect()
    }

    /// A waiting run first, so a page of skipped overlap runs cannot hide
    /// it, then newest first.
    pub fn list_runs(&self, automation_id: &AutomationId, limit: usize) -> StoreResult<Vec<Run>> {
        let db = self.conn()?;
        let mut stmt = db.prepare(
            "SELECT * FROM automation_run WHERE automation_id = ?1
             ORDER BY status = 'waiting' DESC, started_at DESC, rowid DESC LIMIT ?2",
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
        settle_locked(
            &db,
            id,
            status,
            stop_reason,
            summary,
            now_ms,
            Cadence::Follow,
        )
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
    /// `failed` (never re-fired) and their running steps fail with them. The
    /// host died, not the automation, so the cadence is left alone and the
    /// boot catch-up still fires.
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
                Cadence::Keep,
            )?;
        }
        log::info!("[Automation] reconciled {} stranded run(s)", ids.len());
        Ok(ids.len())
    }

    /// Deletes finished runs (and their steps) that ended before `cutoff_ms`.
    /// A waiting run has no `finished_at`, so it is never pruned.
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

/// Whether a settle may move `consecutive_errors` and `next_run_at`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Cadence {
    /// Scheduled and catch-up runs do; manual runs never do.
    Follow,
    Keep,
}

/// Runs that leave the cadence alone still show in `last_run` and the
/// failure badge.
fn settle_locked(
    db: &Connection,
    id: &RunId,
    status: SettledStatus,
    stop_reason: Option<&str>,
    summary: Option<&str>,
    now_ms: i64,
    cadence: Cadence,
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
        let cadence = cadence == Cadence::Follow && run.trigger != RunTrigger::Manual;
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
    let parked_node: Option<String> = row.get("parked_node")?;
    let parked_until: Option<i64> = row.get("parked_until")?;
    Ok((|| {
        let parked = match (parked_node, parked_until) {
            (Some(node_id), Some(until)) => Some(Parked {
                node_id: NodeId::parse(node_id).map_err(|e| StoreError::Corrupt(e.to_string()))?,
                until,
            }),
            _ => None,
        };
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
            parked,
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
