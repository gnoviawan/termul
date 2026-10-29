use std::process::ExitCode;

use super::run_account;
use crate::acp::ClaudeAgentService;

fn account_names(service: &ClaudeAgentService) -> Vec<String> {
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(service.profile_list())
        .unwrap()
        .profiles
        .into_iter()
        .map(|row| row.name)
        .collect()
}

fn run(service: &ClaudeAgentService, args: &[&str]) -> ExitCode {
    let args: Vec<String> = args.iter().map(ToString::to_string).collect();
    run_account(service, &args)
}

#[test]
fn a_help_flag_anywhere_in_account_args_prints_usage_and_adds_nothing() {
    let root = tempfile::tempdir().unwrap();
    let service = ClaudeAgentService::with_logins_for_test(root.path(), &[]);
    let before = account_names(&service);

    for args in [
        &["add", "--help"][..],
        &["add", "-h"],
        &["--help"],
        &["rename", "x", "--help"],
    ] {
        assert_eq!(run(&service, args), ExitCode::SUCCESS, "{args:?}");
    }
    assert_eq!(account_names(&service), before);

    assert_eq!(run(&service, &["add", "Work"]), ExitCode::SUCCESS);
    assert!(account_names(&service).contains(&"Work".to_string()));
}
