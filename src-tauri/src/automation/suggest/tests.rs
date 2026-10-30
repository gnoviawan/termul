use chrono::{NaiveDateTime, TimeZone};
use chrono_tz::Tz;

use super::normalize::tokens;
use super::{detect, match_prompt, Prompt};
use crate::automation::model::Schedule;

const BERLIN: Tz = Tz::Europe__Berlin;

fn at(tz: Tz, local: &str) -> i64 {
    let naive = NaiveDateTime::parse_from_str(local, "%Y-%m-%d %H:%M").unwrap();
    tz.from_local_datetime(&naive).unwrap().timestamp_millis()
}

fn prompt(tz: Tz, local: &str, text: &str) -> Prompt {
    Prompt {
        at_ms: at(tz, local),
        text: text.to_string(),
    }
}

fn cron(expr: &str, tz: Tz) -> Schedule {
    Schedule::Cron {
        expr: expr.to_string(),
        timezone: tz.name().to_string(),
    }
}

fn weekday_prs() -> Vec<Prompt> {
    vec![
        prompt(
            BERLIN,
            "2026-10-26 09:05",
            "summarize the open PRs in termul",
        ),
        prompt(
            BERLIN,
            "2026-10-27 09:02",
            "Summarize the 4 open PRs in termul since 2026-10-26",
        ),
        prompt(
            BERLIN,
            "2026-10-28 09:11",
            "summarize the open PRs in termul, there were 7 yesterday",
        ),
        prompt(
            BERLIN,
            "2026-10-29 09:07",
            "please summarize the open PRs in termul (PR 1571 first)",
        ),
    ]
}

#[test]
fn tokens_keep_the_words_and_drop_the_details() {
    let set = tokens(
        "Please summarize PR #1571 at https://github.com/gnoviawan/termul/pull/1571 \
         from src/main.rs, id 3f9a2b7c1d and 2026-10-26.",
    );
    assert_eq!(
        set.into_iter().collect::<Vec<_>>(),
        vec!["github.com", "id", "pr", "summarize"]
    );
}

#[test]
fn four_weekday_mornings_are_one_weekday_suggestion() {
    let now = at(BERLIN, "2026-10-30 08:00");
    let found = detect(&weekday_prs(), now, BERLIN);

    assert_eq!(found.len(), 1);
    let suggestion = &found[0].suggestion;
    assert_eq!(
        suggestion.representative,
        "please summarize the open PRs in termul (PR 1571 first)"
    );
    assert_eq!(suggestion.occurrences, 4);
    assert_eq!(suggestion.days, 4);
    assert_eq!(suggestion.last_at, at(BERLIN, "2026-10-29 09:07"));
    assert_eq!(suggestion.cadence.schedule, cron("0 9 * * 1-5", BERLIN));
    assert_eq!(suggestion.cadence.label, "weekdays at 09:00");
    assert_eq!(suggestion.fingerprint.len(), 16);
}

#[test]
fn the_fingerprint_ignores_the_details_of_each_ask() {
    let now = at(BERLIN, "2026-10-30 08:00");
    let mut reworded = weekday_prs();
    reworded[1].text = "summarize open PRs in termul again".to_string();
    assert_eq!(
        detect(&weekday_prs(), now, BERLIN)[0]
            .suggestion
            .fingerprint,
        detect(&reworded, now, BERLIN)[0].suggestion.fingerprint
    );
}

#[test]
fn asks_a_week_apart_are_weekly_on_their_weekday() {
    let prompts = vec![
        prompt(
            BERLIN,
            "2026-10-05 17:20",
            "draft the weekly release notes for termul",
        ),
        prompt(
            BERLIN,
            "2026-10-12 17:40",
            "draft weekly release notes for termul v1.9",
        ),
        prompt(
            BERLIN,
            "2026-10-19 17:35",
            "Draft the weekly release notes for termul!",
        ),
        prompt(
            BERLIN,
            "2026-10-26 17:25",
            "draft the weekly release notes for termul",
        ),
    ];
    let found = detect(&prompts, at(BERLIN, "2026-10-30 08:00"), BERLIN);

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].suggestion.days, 4);
    assert_eq!(
        found[0].suggestion.cadence.schedule,
        cron("30 17 * * 1", BERLIN)
    );
    assert_eq!(found[0].suggestion.cadence.label, "Mondays at 17:30");
}

#[test]
fn asks_that_include_a_weekend_are_daily() {
    let prompts = vec![
        prompt(
            BERLIN,
            "2026-10-23 07:50",
            "check the nightly build logs for failures",
        ),
        prompt(
            BERLIN,
            "2026-10-24 08:10",
            "check the nightly build logs for failures",
        ),
        prompt(
            BERLIN,
            "2026-10-25 08:05",
            "check nightly build logs for new failures",
        ),
    ];
    let found = detect(&prompts, at(BERLIN, "2026-10-30 08:00"), BERLIN);

    assert_eq!(found.len(), 1);
    assert_eq!(
        found[0].suggestion.cadence.schedule,
        cron("0 8 * * *", BERLIN)
    );
    assert_eq!(found[0].suggestion.cadence.label, "daily at 08:00");
}

#[test]
fn unrelated_prompts_suggest_nothing() {
    let prompts = vec![
        prompt(
            BERLIN,
            "2026-10-26 09:05",
            "summarize the open PRs in termul",
        ),
        prompt(
            BERLIN,
            "2026-10-27 09:05",
            "fix the flaky websocket reconnect test",
        ),
        prompt(
            BERLIN,
            "2026-10-28 09:05",
            "rename the sidebar settings button label",
        ),
        prompt(
            BERLIN,
            "2026-10-29 09:05",
            "write a migration for the session index",
        ),
    ];
    assert_eq!(
        detect(&prompts, at(BERLIN, "2026-10-30 08:00"), BERLIN),
        vec![]
    );
}

#[test]
fn the_same_ask_on_fewer_than_three_days_suggests_nothing() {
    let prompts = vec![
        prompt(
            BERLIN,
            "2026-10-28 09:05",
            "summarize the open PRs in termul",
        ),
        prompt(
            BERLIN,
            "2026-10-28 15:00",
            "summarize the open PRs in termul",
        ),
        prompt(
            BERLIN,
            "2026-10-29 09:05",
            "summarize the open PRs in termul",
        ),
        prompt(
            BERLIN,
            "2026-10-29 16:30",
            "summarize the open PRs in termul",
        ),
    ];
    assert_eq!(
        detect(&prompts, at(BERLIN, "2026-10-30 08:00"), BERLIN),
        vec![]
    );
}

#[test]
fn days_are_counted_in_the_users_zone() {
    // Three Berlin days, two UTC days.
    let prompts = vec![
        prompt(
            BERLIN,
            "2026-10-26 23:30",
            "summarize the open PRs in termul",
        ),
        prompt(
            BERLIN,
            "2026-10-27 00:30",
            "summarize the open PRs in termul",
        ),
        prompt(
            BERLIN,
            "2026-10-28 00:30",
            "summarize the open PRs in termul",
        ),
    ];
    let now = at(BERLIN, "2026-10-30 08:00");
    assert_eq!(detect(&prompts, now, BERLIN)[0].suggestion.days, 3);
    assert_eq!(detect(&prompts, now, Tz::UTC), vec![]);
}

#[test]
fn asks_older_than_thirty_days_do_not_count() {
    let mut prompts = weekday_prs();
    prompts.truncate(2);
    prompts.push(prompt(
        BERLIN,
        "2026-09-29 09:00",
        "summarize the open PRs in termul",
    ));
    assert_eq!(
        detect(&prompts, at(BERLIN, "2026-10-30 08:00"), BERLIN),
        vec![]
    );
}

#[test]
fn a_new_prompt_matches_the_suggestion_it_repeats() {
    let found = detect(&weekday_prs(), at(BERLIN, "2026-10-30 08:00"), BERLIN);

    let hit = match_prompt(&found, "Summarize the open PRs in termul for Friday");
    assert_eq!(hit, Some(&found[0].suggestion));
    assert_eq!(match_prompt(&found, "fix the flaky reconnect test"), None);
    assert_eq!(match_prompt(&found, "summarize"), None);
}
