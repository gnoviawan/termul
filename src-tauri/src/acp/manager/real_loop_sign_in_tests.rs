//! Codex "ChatGPT (device code)" sign-in through the production driver: the
//! mock agent answers `authenticate` with a request-scoped URL elicitation
//! while no turn runs, the shape codex-acp sends. The host must hold it as an
//! agent-level sign-in prompt instead of cancelling it.

use super::*;

const SIGN_IN_REQUEST: &str = "acp:agent_sign_in_request";
const SIGN_IN_RESOLVED: &str = "acp:agent_sign_in_resolved";

/// Start `authenticate` without waiting for it.
fn start_authenticate(h: &Harness) -> tokio::task::JoinHandle<Result<(), String>> {
    let acp = h.acp.clone();
    let agent_id = h.agent_id.clone();
    tokio::spawn(async move {
        acp.authenticate(&agent_id, "chat-gpt-device-code".to_string(), None)
            .await
    })
}

/// The first event of `type_` in `log`, waiting up to 10 s. Panics early when
/// the racing `authenticate` settles first.
async fn wait_for_event(
    log: &EventLog,
    type_: &str,
    racing: Option<&tokio::task::JoinHandle<Result<(), String>>>,
) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some((_, payload)) = log.0.lock().iter().find(|(kind, _)| kind == type_) {
            return payload.clone();
        }
        assert!(
            !racing.is_some_and(|auth| auth.is_finished()),
            "authenticate settled before any {type_} event: {:?}",
            log.0.lock()
        );
        assert!(
            tokio::time::Instant::now() < deadline,
            "no {type_} event: {:?}",
            log.0.lock()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The prompt reaches every sink as an agent-level event carrying the URL and
/// the message, and accepting it lets the agent finish the sign-in.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn device_code_elicitation_is_an_agent_sign_in_prompt_that_accept_completes() {
    let Some(h) = Harness::start().await else {
        return;
    };
    let auth = start_authenticate(&h);
    let mut request_ids = Vec::new();
    for log in &h.logs {
        let payload = wait_for_event(log, SIGN_IN_REQUEST, Some(&auth)).await;
        assert_eq!(payload["agentId"], h.agent_id.0.as_str());
        assert_eq!(payload["url"], "https://auth.example.com/device");
        assert_eq!(payload["message"], "Sign in and enter this code: ABCD-1234");
        assert!(payload.get("sessionId").is_none(), "{payload}");
        request_ids.push(payload["requestId"].as_str().unwrap().to_string());
    }
    assert_eq!(request_ids[0], request_ids[1]);
    let request_id = request_ids.remove(0);

    h.acp
        .respond_elicitation(&h.agent_id, request_id.clone(), "accept".to_string(), None)
        .await
        .expect("accept reaches the held prompt");
    let result = tokio::time::timeout(RUN_TIMEOUT, auth)
        .await
        .expect("authenticate settles")
        .expect("authenticate task");
    assert_eq!(result, Ok(()));
    let resolved = wait_for_event(&h.logs[0], SIGN_IN_RESOLVED, None).await;
    assert_eq!(
        resolved,
        serde_json::json!({ "agentId": h.agent_id.0, "requestId": request_id })
    );
    h.finish().await;
}

/// Dismissing the prompt answers the agent with cancel, so `authenticate`
/// fails the way the agent reports a cancelled sign-in.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dismissing_the_device_code_prompt_cancels_the_sign_in() {
    let Some(h) = Harness::start().await else {
        return;
    };
    let auth = start_authenticate(&h);
    let payload = wait_for_event(&h.logs[0], SIGN_IN_REQUEST, Some(&auth)).await;
    let request_id = payload["requestId"].as_str().unwrap().to_string();

    h.acp
        .respond_elicitation(&h.agent_id, request_id.clone(), "cancel".to_string(), None)
        .await
        .expect("cancel reaches the held prompt");
    let result = tokio::time::timeout(RUN_TIMEOUT, auth)
        .await
        .expect("authenticate settles")
        .expect("authenticate task");
    let error = result.expect_err("a cancelled sign-in fails authenticate");
    assert!(error.contains("device code sign-in was cancelled"), "{error}");
    let resolved = wait_for_event(&h.logs[0], SIGN_IN_RESOLVED, None).await;
    assert_eq!(resolved["requestId"], request_id.as_str());
    h.finish().await;
}
