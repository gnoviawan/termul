use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::json;
use tokio::sync::{mpsc, oneshot};

use super::*;

fn request(type_: &str, payload: serde_json::Value) -> WsRequest {
    WsRequest {
        id: "r".to_string(),
        type_: type_.to_string(),
        payload,
        command_id: None,
    }
}

#[test]
fn entity_keys_name_the_first_entity_and_never_collide_across_kinds() {
    let key = |type_, payload| entity_key(&request(type_, payload));
    assert_eq!(
        key("send_prompt", json!({"agentId": "a", "sessionId": "s"})).as_deref(),
        Some("session:s"),
        "a session request is keyed by the session even though it names the agent"
    );
    assert_eq!(
        key("cancel_prompt", json!({"agentId": "a", "sessionId": "s"})),
        key("send_prompt", json!({"agentId": "a", "sessionId": "s", "text": "x"})),
    );
    assert_eq!(key("install_acp_agent", json!({"agentId": "a"})).as_deref(), Some("agent:a"));
    assert_eq!(key("watch_project", json!({"projectId": "p"})).as_deref(), Some("project:p"));
    assert_eq!(key("add_project", json!({"id": "p", "name": "n"})).as_deref(), Some("project:p"));
    assert_eq!(key("store_write", json!({"key": "k", "value": 1})).as_deref(), Some("store:k"));
    assert_eq!(key("terminal_x", json!({"terminalId": "t"})).as_deref(), Some("terminal:t"));
    assert_ne!(
        key("close_session", json!({"sessionId": "same"})),
        key("kill_agent", json!({"agentId": "same"})),
        "an agent and a session sharing an id are different entities"
    );
    for answer in ["respond_permission", "answer_question", "respond_elicitation"] {
        assert_eq!(
            key(answer, json!({"agentId": "a", "requestId": "r", "questionId": "q"})),
            None,
            "{answer} must not queue behind a long handler on its agent"
        );
    }
    assert_eq!(key("ping", json!({})), None);
    assert_eq!(key("list_agents", json!({})), None);
    assert_eq!(key("subscribe", json!({"sessionId": ""})), None, "an empty id names nothing");
}

#[tokio::test]
async fn same_key_jobs_run_in_arrival_order_even_when_the_first_is_slow() {
    let exec = KeyedExecutor::new(CancellationToken::new());
    let (done_tx, mut done_rx) = mpsc::unbounded_channel();
    for (index, delay_ms) in [(0, 40u64), (1, 0), (2, 0)] {
        let done = done_tx.clone();
        exec.submit(Some("session:s".to_string()), async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let _ = done.send(index);
        })
        .expect("accepted");
    }
    let mut order = Vec::new();
    for _ in 0..3 {
        order.push(done_rx.recv().await.expect("job ran"));
    }
    assert_eq!(order, vec![0, 1, 2], "later jobs on one entity wait for earlier ones");
}

#[tokio::test]
async fn a_blocked_entity_does_not_hold_up_other_entities_or_keyless_jobs() {
    let exec = KeyedExecutor::new(CancellationToken::new());
    let (release, gate) = oneshot::channel::<()>();
    let (done_tx, mut done_rx) = mpsc::unbounded_channel();
    let slow_done = done_tx.clone();
    exec.submit(Some("agent:a".to_string()), async move {
        let _ = gate.await;
        let _ = slow_done.send("slow");
    })
    .expect("accepted");
    let queued_done = done_tx.clone();
    exec.submit(Some("agent:a".to_string()), async move {
        let _ = queued_done.send("queued behind slow");
    })
    .expect("accepted");
    for (key, label) in [(Some("session:s".to_string()), "other entity"), (None, "keyless")] {
        let done = done_tx.clone();
        exec.submit(key, async move {
            let _ = done.send(label);
        })
        .expect("accepted");
    }
    let mut seen = vec![done_rx.recv().await.unwrap(), done_rx.recv().await.unwrap()];
    seen.sort_unstable();
    assert_eq!(seen, vec!["keyless", "other entity"]);
    assert!(done_rx.try_recv().is_err(), "the same-entity job stays blocked");

    release.send(()).expect("slow job still waiting");
    assert_eq!(done_rx.recv().await, Some("slow"));
    assert_eq!(done_rx.recv().await, Some("queued behind slow"));
}

#[tokio::test]
async fn a_panicking_job_closes_the_connection_but_the_queue_keeps_draining() {
    let fault = CancellationToken::new();
    let exec = KeyedExecutor::new(fault.clone());
    let (done_tx, done_rx) = oneshot::channel();
    exec.submit(Some("session:s".to_string()), async { panic!("handler bug") })
        .expect("accepted");
    exec.submit(Some("session:s".to_string()), async move {
        let _ = done_tx.send(());
    })
    .expect("accepted");
    done_rx.await.expect("the job queued behind the panic still ran");
    assert!(fault.is_cancelled(), "a handler panic must close the connection");
}

#[tokio::test]
async fn submissions_beyond_the_inflight_cap_are_refused_until_jobs_finish() {
    let exec = KeyedExecutor::new(CancellationToken::new());
    let (release, _) = tokio::sync::broadcast::channel::<()>(1);
    for _ in 0..MAX_INFLIGHT_REQUESTS {
        let mut gate = release.subscribe();
        exec.submit(None, async move {
            let _ = gate.recv().await;
        })
        .expect("under the cap");
    }
    assert_eq!(exec.inflight(), MAX_INFLIGHT_REQUESTS);
    assert_eq!(exec.submit(None, async {}), Err(Saturated));
    release.send(()).expect("jobs are waiting");
    tokio::time::timeout(Duration::from_secs(5), async {
        while exec.inflight() > 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("jobs finish");
    assert!(exec.submit(None, async {}).is_ok(), "room again once jobs finished");
}

#[tokio::test]
async fn dropping_the_executor_aborts_running_jobs() {
    static DROPPED: AtomicUsize = AtomicUsize::new(0);
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            DROPPED.fetch_add(1, Ordering::SeqCst);
        }
    }
    let exec = KeyedExecutor::new(CancellationToken::new());
    let (entered_tx, entered_rx) = oneshot::channel();
    exec.submit(Some("session:s".to_string()), async move {
        let _guard = Guard;
        let _ = entered_tx.send(());
        std::future::pending::<()>().await;
    })
    .expect("accepted");
    entered_rx.await.expect("job started");
    drop(exec);
    tokio::time::timeout(Duration::from_secs(5), async {
        while DROPPED.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the job's future was dropped with its connection");
}
