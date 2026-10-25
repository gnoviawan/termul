use super::*;
use crate::browser_automation::core::dispatch::REGISTRY;

#[test]
fn a_call_that_waits_for_consent_still_answers_before_the_child_gives_up() {
    let max_action = REGISTRY.iter().map(|spec| spec.budget).max().unwrap();
    assert_eq!(max_action, ACTION_CLICK);
    assert!(CONSENT_WAIT + max_action + MARGIN < ROUND_TRIP);
    assert_eq!(FRAME_BUDGET + MARGIN, ROUND_TRIP);
    assert!(EVAL_STEP >= CDP_CALL);
}

#[tokio::test(start_paused = true)]
async fn deadlines_admit_only_budgets_that_still_fit() {
    let deadline = Deadline::after(Duration::from_secs(10));
    assert!(deadline.admits(Duration::from_secs(10)));
    assert!(!deadline.admits(Duration::from_secs(11)));
    assert_eq!(deadline.clamp(Duration::from_secs(3)), Duration::from_secs(3));

    tokio::time::advance(Duration::from_secs(8)).await;
    assert_eq!(deadline.remaining(), Duration::from_secs(2));
    assert!(!deadline.admits(Duration::from_secs(3)));
    assert_eq!(deadline.clamp(Duration::from_secs(3)), Duration::from_secs(2));

    tokio::time::advance(Duration::from_secs(5)).await;
    assert_eq!(deadline.remaining(), Duration::ZERO, "an expired deadline saturates");
}
