use super::model::Schedule;
use super::schedule::{backoff_ms, check, compute_next_run, next_runs, ScheduleError};

fn utc(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s)
        .unwrap()
        .timestamp_millis()
}

fn cron(expr: &str, tz: &str) -> Schedule {
    Schedule::Cron {
        expr: expr.to_string(),
        timezone: tz.to_string(),
    }
}

#[test]
fn weekday_cron_in_new_york_follows_wall_clock_across_spring_forward() {
    let s = cron("0 5 * * 1-5", "America/New_York");
    assert_eq!(
        compute_next_run(&s, utc("2026-03-05T12:00:00Z")),
        Ok(Some(utc("2026-03-06T10:00:00Z")))
    );
    assert_eq!(
        next_runs(&s, utc("2026-03-06T12:00:00Z"), 3),
        Ok(vec![
            utc("2026-03-09T09:00:00Z"),
            utc("2026-03-10T09:00:00Z"),
            utc("2026-03-11T09:00:00Z"),
        ])
    );
}

#[test]
fn cron_in_a_missing_local_hour_skips_that_day() {
    let s = cron("30 2 * * *", "America/New_York");
    assert_eq!(
        compute_next_run(&s, utc("2026-03-08T05:00:00Z")),
        Ok(Some(utc("2026-03-09T06:30:00Z")))
    );
}

#[test]
fn cron_in_a_repeated_local_hour_fires_once_and_never_in_the_past() {
    let s = cron("30 1 * * *", "America/New_York");
    assert_eq!(
        compute_next_run(&s, utc("2026-11-01T04:00:00Z")),
        Ok(Some(utc("2026-11-01T05:30:00Z")))
    );
    assert_eq!(
        compute_next_run(&s, utc("2026-11-01T05:30:00Z")),
        Ok(Some(utc("2026-11-02T06:30:00Z")))
    );
    assert_eq!(
        compute_next_run(&s, utc("2026-11-01T06:10:00Z")),
        Ok(Some(utc("2026-11-01T06:30:00Z")))
    );
}

#[test]
fn cron_day_of_week_uses_standard_numbering() {
    let from = utc("2026-06-02T00:00:00Z");
    for sunday in ["0 9 * * 0", "0 9 * * 7", "0 9 * * sun"] {
        assert_eq!(
            compute_next_run(&cron(sunday, "UTC"), from),
            Ok(Some(utc("2026-06-07T09:00:00Z"))),
            "{sunday}"
        );
    }
}

#[test]
fn cron_with_both_day_fields_fires_when_either_matches() {
    assert_eq!(
        next_runs(&cron("0 0 1 * 1", "UTC"), utc("2026-06-02T00:00:00Z"), 5),
        Ok(vec![
            utc("2026-06-08T00:00:00Z"),
            utc("2026-06-15T00:00:00Z"),
            utc("2026-06-22T00:00:00Z"),
            utc("2026-06-29T00:00:00Z"),
            utc("2026-07-01T00:00:00Z"),
        ])
    );
}

#[test]
fn invalid_cron_and_timezone_are_rejected() {
    assert!(matches!(
        compute_next_run(&cron("0 0 5 * * *", "UTC"), 0),
        Err(ScheduleError::InvalidCron(_))
    ));
    assert!(matches!(
        check(&cron("0 5 * * 1-9", "UTC")),
        Err(ScheduleError::InvalidCron(_))
    ));
    assert_eq!(
        check(&cron("0 5 * * *", "Mars/Olympus")),
        Err(ScheduleError::InvalidTimezone("Mars/Olympus".to_string()))
    );
    assert_eq!(
        check(&cron("*/15 9-17 * * mon-fri", "Europe/Berlin")),
        Ok(())
    );
}

#[test]
fn every_collapses_a_backlog_into_the_next_slot() {
    let s = Schedule::Every {
        every_ms: 60_000,
        anchor_ms: 1_000_000,
    };
    assert_eq!(
        compute_next_run(&s, 1_000_000 + 10 * 60_000 + 5),
        Ok(Some(1_660_000))
    );
    assert_eq!(compute_next_run(&s, 1_120_000), Ok(Some(1_180_000)));
    assert_eq!(compute_next_run(&s, 5), Ok(Some(1_000_000)));
    assert_eq!(
        next_runs(&s, 1_000_000, 3),
        Ok(vec![1_060_000, 1_120_000, 1_180_000])
    );
    assert_eq!(
        compute_next_run(
            &Schedule::Every {
                every_ms: 0,
                anchor_ms: 0
            },
            5
        ),
        Err(ScheduleError::ZeroInterval)
    );
}

#[test]
fn at_fires_only_in_the_future() {
    let s = Schedule::At { at: 5_000 };
    assert_eq!(compute_next_run(&s, 4_999), Ok(Some(5_000)));
    assert_eq!(compute_next_run(&s, 5_000), Ok(None));
    assert_eq!(compute_next_run(&s, 9_000), Ok(None));
    assert_eq!(next_runs(&s, 0, 3), Ok(vec![5_000]));
}

#[test]
fn backoff_ladder_starts_at_the_first_failure_and_clamps() {
    assert_eq!(backoff_ms(0), None);
    assert_eq!(backoff_ms(1), Some(30_000));
    assert_eq!(backoff_ms(2), Some(60_000));
    assert_eq!(backoff_ms(3), Some(300_000));
    assert_eq!(backoff_ms(4), Some(900_000));
    assert_eq!(backoff_ms(5), Some(3_600_000));
    assert_eq!(backoff_ms(40), Some(3_600_000));
}
