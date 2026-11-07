use super::*;

#[test]
fn the_report_arrives_only_with_the_last_answer() {
    let mut tally = ResetTally::new(3);
    assert_eq!(tally.record(true), None);
    assert_eq!(tally.record(false), None);
    assert_eq!(tally.record(true), Some(ClearReport { reset: 2, failed: 1 }));
}

#[test]
fn a_single_reset_reports_on_its_own_answer() {
    assert_eq!(
        ResetTally::new(1).record(true),
        Some(ClearReport { reset: 1, failed: 0 })
    );
}

#[test]
fn only_the_app_ui_origin_keeps_its_saved_grants() {
    let app = "http://tauri.localhost";
    let kept: Vec<bool> = [
        "http://tauri.localhost",
        "http://TAURI.localhost/",
        "https://tauri.localhost",
        "https://meet.example.com",
        "http://localhost:1420",
    ]
    .iter()
    .map(|saved| is_app_origin(saved, app))
    .collect();
    assert_eq!(kept, [true, true, false, false, false]);
}

#[tokio::test]
async fn the_clear_runs_until_it_settles_and_then_never_again() {
    let once = ClearOnce::default();
    let report = ClearReport { reset: 2, failed: 0 };
    let mut attempts = Vec::new();
    for answer in [Err(ClearError::Failed), Ok(report), Err(ClearError::Failed)] {
        attempts.push(once.run(|| async move { answer }).await);
    }
    assert_eq!(attempts, [Some(Err(ClearError::Failed)), Some(Ok(report)), None]);

    let unsupported = ClearOnce::default();
    assert_eq!(
        unsupported.run(|| async { Err(ClearError::Unsupported) }).await,
        Some(Err(ClearError::Unsupported))
    );
    assert_eq!(unsupported.run(|| async { Ok(report) }).await, None);
}
