//! Summary table on stdout and the machine-readable JSON summary.

use serde_json::{json, Value};

use crate::cases::Outcome;
use crate::expected::Verdict;

pub struct Row {
    pub outcome: Outcome,
    pub verdict: Verdict,
}

fn status(row: &Row) -> &'static str {
    if row.outcome.failure.is_some() {
        "FAIL"
    } else {
        "pass"
    }
}

fn note(row: &Row) -> String {
    match (&row.verdict, &row.outcome.failure) {
        (Verdict::Unexpected(why), _) => format!("UNEXPECTED: {why}"),
        (Verdict::KnownFailure, Some(f)) => format!("known: {} ({})", f.code, f.message),
        _ => String::new(),
    }
}

pub fn print_table(os: &str, rows: &[Row]) {
    println!("\nbrowser conformance on {os}");
    println!("{:<14} {:<6} {:>8}  note", "capability", "status", "ms");
    for row in rows {
        println!(
            "{:<14} {:<6} {:>8}  {}",
            row.outcome.capability,
            status(row),
            row.outcome.duration.as_millis(),
            note(row)
        );
    }
    let failed = rows.iter().filter(|r| r.outcome.failure.is_some()).count();
    let unexpected = rows
        .iter()
        .filter(|r| matches!(r.verdict, Verdict::Unexpected(_)))
        .count();
    println!(
        "{} capabilities, {} passing, {} failing, {} unexpected\n",
        rows.len(),
        rows.len() - failed,
        failed,
        unexpected
    );
}

pub fn summary_json(os: &str, fixture_port: u16, dev_port: Option<u16>, rows: &[Row]) -> Value {
    let results: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "capability": row.outcome.capability,
                "status": status(row),
                "code": row.outcome.failure.as_ref().map(|f| f.code.as_str()),
                "observed": row.outcome.failure.as_ref().map(|f| f.message.as_str()),
                "durationMs": row.outcome.duration.as_millis() as u64,
                "unexpected": matches!(row.verdict, Verdict::Unexpected(_)),
            })
        })
        .collect();
    json!({
        "os": os,
        "fixturePort": fixture_port,
        "devUrlPort": dev_port,
        "results": results,
    })
}
