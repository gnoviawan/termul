use super::*;

fn set_env(port: &str, token: &str, session: &str, agent: &str) {
    std::env::set_var(ENV_PORT, port);
    std::env::set_var(ENV_TOKEN, token);
    std::env::set_var(ENV_SESSION_ID, session);
    std::env::set_var(ENV_AGENT_ID, agent);
}

fn clear_env() {
    std::env::remove_var(ENV_PORT);
    std::env::remove_var(ENV_TOKEN);
    std::env::remove_var(ENV_SESSION_ID);
    std::env::remove_var(ENV_AGENT_ID);
}

// `parse_env` reads `std::env` — these tests are not parallel-safe, so
// serialize them with a shared lock.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn parse_env_rejects_missing_port() {
    let _g = ENV_LOCK.lock().unwrap();
    clear_env();
    std::env::set_var(ENV_TOKEN, "tok");
    std::env::set_var(ENV_SESSION_ID, "sess");
    let err = parse_env().expect_err("missing PORT must error");
    assert!(err.contains(ENV_PORT));
    clear_env();
}

#[test]
fn parse_env_rejects_missing_token() {
    let _g = ENV_LOCK.lock().unwrap();
    clear_env();
    std::env::set_var(ENV_PORT, "1234");
    std::env::set_var(ENV_SESSION_ID, "sess");
    let err = parse_env().expect_err("missing TOKEN must error");
    assert!(err.contains(ENV_TOKEN));
    clear_env();
}

#[test]
fn parse_env_rejects_missing_session_id() {
    let _g = ENV_LOCK.lock().unwrap();
    clear_env();
    std::env::set_var(ENV_PORT, "1234");
    std::env::set_var(ENV_TOKEN, "tok");
    let err = parse_env().expect_err("missing SESSION_ID must error");
    assert!(err.contains(ENV_SESSION_ID));
    clear_env();
}

#[test]
fn parse_env_rejects_blank_token() {
    let _g = ENV_LOCK.lock().unwrap();
    clear_env();
    set_env("1234", "   ", "sess", "agent");
    let err = parse_env().expect_err("blank TOKEN must error");
    assert!(err.contains(ENV_TOKEN));
    clear_env();
}

#[test]
fn parse_env_rejects_non_numeric_port() {
    let _g = ENV_LOCK.lock().unwrap();
    clear_env();
    set_env("not-a-port", "tok", "sess", "agent");
    let err = parse_env().expect_err("non-numeric PORT must error");
    assert!(err.contains(ENV_PORT));
    clear_env();
}

#[test]
fn parse_env_accepts_valid_config() {
    let _g = ENV_LOCK.lock().unwrap();
    clear_env();
    set_env("4242", "tok-abc", "sess-xyz", "agent-1");
    let cfg = parse_env().expect("valid env must parse");
    assert_eq!(cfg.port, 4242);
    assert_eq!(cfg.token, "tok-abc");
    assert_eq!(cfg.session_id, "sess-xyz");
    assert_eq!(cfg.agent_id, "agent-1");
    clear_env();
}

#[test]
fn parse_env_agent_id_is_optional() {
    let _g = ENV_LOCK.lock().unwrap();
    clear_env();
    set_env("4242", "tok", "sess", "");
    std::env::remove_var(ENV_AGENT_ID);
    let cfg = parse_env().expect("AGENT_ID is optional");
    assert_eq!(cfg.agent_id, "");
    clear_env();
}
