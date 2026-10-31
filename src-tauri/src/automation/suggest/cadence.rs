//! When a repeated ask usually happens, as a cron schedule the user can
//! accept as is.

use chrono::{DateTime, Datelike, NaiveDate, Timelike, Weekday};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

use crate::automation::model::Schedule;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cadence {
    pub schedule: Schedule,
    /// "weekdays at 09:00", "Mondays at 09:00", "daily at 09:00".
    pub label: String,
}

/// A median gap between ask days in this range reads as weekly.
const WEEKLY_GAP_DAYS: std::ops::RangeInclusive<i64> = 6..=8;
const SLOT_MINUTES: u32 = 30;
const DAY_MINUTES: u32 = 24 * 60;

/// The cadence of asks at `times` (local to `tz`, at least one): weekly on
/// the most common weekday when the asks are about a week apart, weekdays
/// when every ask fell on Monday to Friday, daily otherwise. The time is the
/// median ask time rounded to the nearest half hour.
pub fn cadence(times: &[DateTime<Tz>], tz: Tz) -> Cadence {
    let mut minutes: Vec<u32> = times.iter().map(|t| t.hour() * 60 + t.minute()).collect();
    minutes.sort_unstable();
    let median = lower_median(&minutes).unwrap_or(0);
    let slot = (median + SLOT_MINUTES / 2) / SLOT_MINUTES * SLOT_MINUTES % DAY_MINUTES;
    let (hour, minute) = (slot / 60, slot % 60);
    let at = format!("{hour:02}:{minute:02}");

    let mut days: Vec<NaiveDate> = times.iter().map(DateTime::date_naive).collect();
    days.sort_unstable();
    days.dedup();
    let mut gaps: Vec<i64> = days
        .windows(2)
        .map(|pair| (pair[1] - pair[0]).num_days())
        .collect();
    gaps.sort_unstable();

    let (dow, label) = match lower_median(&gaps) {
        Some(gap) if WEEKLY_GAP_DAYS.contains(&gap) => {
            let weekday = most_common_weekday(&days);
            (
                weekday.num_days_from_sunday().to_string(),
                format!("{}s at {at}", weekday_name(weekday)),
            )
        }
        _ if days.iter().all(|day| is_workday(day.weekday())) => {
            ("1-5".to_string(), format!("weekdays at {at}"))
        }
        _ => ("*".to_string(), format!("daily at {at}")),
    };
    Cadence {
        schedule: Schedule::Cron {
            expr: format!("{minute} {hour} * * {dow}"),
            timezone: tz.name().to_string(),
        },
        label,
    }
}

fn lower_median<T: Copy>(sorted: &[T]) -> Option<T> {
    sorted.get(sorted.len().saturating_sub(1) / 2).copied()
}

fn is_workday(day: Weekday) -> bool {
    !matches!(day, Weekday::Sat | Weekday::Sun)
}

/// Ties go to the earlier day of the week, Monday first.
fn most_common_weekday(days: &[NaiveDate]) -> Weekday {
    let mut counts = [0usize; 7];
    for day in days {
        counts[day.weekday().num_days_from_monday() as usize] += 1;
    }
    let best = (0..7).rev().max_by_key(|&i| counts[i]).unwrap_or(0);
    Weekday::try_from(best as u8).unwrap_or(Weekday::Mon)
}

fn weekday_name(day: Weekday) -> &'static str {
    match day {
        Weekday::Mon => "Monday",
        Weekday::Tue => "Tuesday",
        Weekday::Wed => "Wednesday",
        Weekday::Thu => "Thursday",
        Weekday::Fri => "Friday",
        Weekday::Sat => "Saturday",
        Weekday::Sun => "Sunday",
    }
}
