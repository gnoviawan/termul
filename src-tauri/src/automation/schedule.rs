//! The one schedule computation shared by validation, the engine's claim, the
//! store and the run-policy preview.

use std::collections::BTreeSet;
use std::fmt;
use std::str::FromStr;

use chrono::{TimeZone, Utc};
use chrono_tz::Tz;

use super::model::Schedule;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduleError {
    InvalidCron(String),
    InvalidTimezone(String),
    ZeroInterval,
    OutOfRange,
}

impl fmt::Display for ScheduleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ScheduleError::InvalidCron(reason) => write!(f, "invalid cron expression: {reason}"),
            ScheduleError::InvalidTimezone(tz) => write!(f, "unknown IANA timezone {tz:?}"),
            ScheduleError::ZeroInterval => f.write_str("every_ms must be greater than 0"),
            ScheduleError::OutOfRange => f.write_str("next run is outside the representable range"),
        }
    }
}

impl std::error::Error for ScheduleError {}

/// The first slot strictly after `from_ms`, or `None` when the schedule has
/// no future slot. "Strictly after" is what makes a claim move forward and
/// collapses any backlog into the single slot being claimed.
pub fn compute_next_run(schedule: &Schedule, from_ms: i64) -> Result<Option<i64>, ScheduleError> {
    match schedule {
        Schedule::At { at } => Ok((*at > from_ms).then_some(*at)),
        Schedule::Every {
            every_ms,
            anchor_ms,
        } => next_every(*every_ms, *anchor_ms, from_ms).map(Some),
        Schedule::Cron { expr, timezone } => {
            CronSchedule::parse(expr, timezone)?.next_after(from_ms)
        }
    }
}

fn next_every(every_ms: u64, anchor_ms: i64, from_ms: i64) -> Result<i64, ScheduleError> {
    if every_ms == 0 {
        return Err(ScheduleError::ZeroInterval);
    }
    if from_ms < anchor_ms {
        return Ok(anchor_ms);
    }
    let every = i128::from(every_ms);
    let elapsed = i128::from(from_ms) - i128::from(anchor_ms);
    let next = i128::from(anchor_ms) + (elapsed / every + 1) * every;
    i64::try_from(next).map_err(|_| ScheduleError::OutOfRange)
}

/// Up to `n` consecutive slots after `from_ms`, for the approval preview.
pub fn next_runs(schedule: &Schedule, from_ms: i64, n: usize) -> Result<Vec<i64>, ScheduleError> {
    let mut out = Vec::with_capacity(n);
    let mut cursor = from_ms;
    while out.len() < n {
        match compute_next_run(schedule, cursor)? {
            Some(next) => {
                out.push(next);
                cursor = next;
            }
            None => break,
        }
    }
    Ok(out)
}

pub const BACKOFF_LADDER_MS: [i64; 5] = [30_000, 60_000, 300_000, 900_000, 3_600_000];

/// Scheduling delay after `consecutive_errors` failures in a row, clamped at
/// the last rung. No failures, no delay.
pub fn backoff_ms(consecutive_errors: u32) -> Option<i64> {
    let rung = usize::try_from(consecutive_errors.checked_sub(1)?).ok()?;
    Some(BACKOFF_LADDER_MS[rung.min(BACKOFF_LADDER_MS.len() - 1)])
}

/// Checks a schedule without evaluating it against a clock.
pub fn check(schedule: &Schedule) -> Result<(), ScheduleError> {
    match schedule {
        Schedule::At { .. } => Ok(()),
        Schedule::Every { every_ms: 0, .. } => Err(ScheduleError::ZeroInterval),
        Schedule::Every { .. } => Ok(()),
        Schedule::Cron { expr, timezone } => CronSchedule::parse(expr, timezone).map(|_| ()),
    }
}

/// A 5-field cron expression with standard (vixie) semantics on top of the
/// `cron` crate, which wants a seconds field, numbers Sunday as 1, and always
/// ANDs day-of-month with day-of-week.
struct CronSchedule {
    primary: cron::Schedule,
    /// Set when both day fields are restricted: vixie cron fires when either
    /// matches, so the day-of-week half is evaluated separately.
    by_weekday: Option<cron::Schedule>,
    tz: Tz,
}

impl CronSchedule {
    fn parse(expr: &str, timezone: &str) -> Result<Self, ScheduleError> {
        let tz = Tz::from_str(timezone)
            .map_err(|_| ScheduleError::InvalidTimezone(timezone.to_string()))?;
        let fields: Vec<&str> = expr.split_whitespace().collect();
        let [minute, hour, dom, month, dow] = fields.as_slice() else {
            return Err(ScheduleError::InvalidCron(format!(
                "expected 5 fields (minute hour day-of-month month day-of-week), got {}",
                fields.len()
            )));
        };
        let weekdays = translate_weekdays(dow)?;
        let build = |dom: &str, dow: &str| {
            cron::Schedule::from_str(&format!("0 {minute} {hour} {dom} {month} {dow}"))
                .map_err(|e| ScheduleError::InvalidCron(e.to_string()))
        };
        let both_restricted = !dom.starts_with('*') && !dow.starts_with('*');
        if both_restricted {
            Ok(Self {
                primary: build(dom, "*")?,
                by_weekday: Some(build("*", &weekdays)?),
                tz,
            })
        } else {
            Ok(Self {
                primary: build(dom, &weekdays)?,
                by_weekday: None,
                tz,
            })
        }
    }

    fn next_after(&self, from_ms: i64) -> Result<Option<i64>, ScheduleError> {
        let from = Utc
            .timestamp_millis_opt(from_ms)
            .single()
            .ok_or(ScheduleError::OutOfRange)?
            .with_timezone(&self.tz);
        // An ambiguous local time (DST fall-back) yields both instants; the
        // first one can sit before `from`, so skip anything not after it.
        let next = |s: &cron::Schedule| {
            s.after(&from)
                .map(|t| t.timestamp_millis())
                .find(|&t| t > from_ms)
        };
        let primary = next(&self.primary);
        let weekday = self.by_weekday.as_ref().and_then(next);
        Ok(match (primary, weekday) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        })
    }
}

const WEEKDAY_NAMES: [&str; 7] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/// Rewrites a standard day-of-week field (0-7, Sunday = 0 or 7, names,
/// ranges, steps, lists) as an explicit list of names the `cron` crate reads
/// unambiguously.
fn translate_weekdays(field: &str) -> Result<String, ScheduleError> {
    let invalid =
        |reason: &str| ScheduleError::InvalidCron(format!("day-of-week {field:?}: {reason}"));
    let mut days = BTreeSet::new();
    for item in field.split(',') {
        let (range, step) = match item.split_once('/') {
            Some((range, step)) => {
                let step: u32 = step.parse().map_err(|_| invalid("step must be a number"))?;
                if step == 0 {
                    return Err(invalid("step must be at least 1"));
                }
                (range, Some(step))
            }
            None => (item, None),
        };
        let (start, end) = match range {
            "*" | "?" => (0, 6),
            _ => match range.split_once('-') {
                Some((a, b)) => (
                    weekday_value(a).ok_or_else(|| invalid("unknown day"))?,
                    weekday_value(b).ok_or_else(|| invalid("unknown day"))?,
                ),
                None => {
                    let day = weekday_value(range).ok_or_else(|| invalid("unknown day"))?;
                    (day, if step.is_some() { 6 } else { day })
                }
            },
        };
        if start > end {
            return Err(invalid("range start is after its end"));
        }
        let step = step.unwrap_or(1) as usize;
        days.extend((start..=end).step_by(step).map(|d| d % 7));
    }
    if days.len() == 7 {
        return Ok("*".to_string());
    }
    Ok(days
        .into_iter()
        .map(|d| WEEKDAY_NAMES[d as usize])
        .collect::<Vec<_>>()
        .join(","))
}

fn weekday_value(token: &str) -> Option<u32> {
    if let Ok(n) = token.parse::<u32>() {
        return (n <= 7).then_some(n);
    }
    WEEKDAY_NAMES
        .iter()
        .position(|name| name.eq_ignore_ascii_case(token))
        .map(|i| i as u32)
}
