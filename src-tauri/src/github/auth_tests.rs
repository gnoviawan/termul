use super::auth::{parse_auth_json, parse_auth_text, HostAccount, HostInventory, TokenOrigin};
use super::types::{GithubAuthStatus, GithubTokenSource};

/// `gh auth status --json hosts` on gh 2.98, keyring/hosts.yml login.
const JSON_STORED: &str = r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"gnoviawan","tokenSource":"/root/.config/gh/hosts.yml","scopes":"gist, read:org, repo, workflow","gitProtocol":"https"}]}}"#;

/// Same machine with an invalid `GH_TOKEN` exported (gh 2.98).
const JSON_BAD_ENV: &str = r#"{"hosts":{"github.com":[{"state":"error","error":"non-200 OK status code: 401 Unauthorized","active":true,"host":"github.com","login":"","tokenSource":"GH_TOKEN","gitProtocol":"https"},{"state":"success","active":false,"host":"github.com","login":"gnoviawan","tokenSource":"/root/.config/gh/hosts.yml","scopes":"gist, read:org, repo, workflow","gitProtocol":"https"}]}}"#;

/// `gh auth status` text report on gh 2.98 (token line masked by gh).
const TEXT_CURRENT: &str = "github.com
  \u{2713} Logged in to github.com account gnoviawan (/root/.config/gh/hosts.yml)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
";

/// The pre-2.40 text layout.
const TEXT_LEGACY: &str = "github.com
  \u{2713} Logged in to github.com as octo (oauth_token)
  \u{2713} Git operations for github.com configured to use https protocol.
  \u{2713} Token: *******************
  \u{2713} Token scopes: gist, repo

ghe.corp.example
  \u{2713} Logged in to ghe.corp.example as octo-corp (keyring)
  \u{2713} Token scopes: repo, admin:org
";

fn inventory(json: &str) -> HostInventory {
    parse_auth_json(json.as_bytes()).expect("auth json parses")
}

fn account(ok: bool, active: bool, origin: TokenOrigin, scopes: Option<&[&str]>) -> HostAccount {
    HostAccount {
        ok,
        active,
        login: "octo".to_string(),
        origin,
        scopes: scopes.map(|s| s.iter().map(|x| x.to_string()).collect()),
    }
}

fn with_accounts(host: &str, accounts: Vec<HostAccount>) -> HostInventory {
    let mut inventory = HostInventory::default();
    inventory.hosts.insert(host.to_string(), accounts);
    inventory
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

#[test]
fn stored_login_with_required_scopes_is_connected_with_no_fixes() {
    assert_eq!(
        inventory(JSON_STORED).status_for("github.com"),
        GithubAuthStatus::Connected {
            host: "github.com".to_string(),
            account: "gnoviawan".to_string(),
            scopes: strings(&["gist", "read:org", "repo", "workflow"]),
            token_source: GithubTokenSource::Keyring,
            missing_scopes: vec![],
            fix_commands: vec![],
        }
    );
}

fn unset(var: &str) -> String {
    if cfg!(windows) {
        format!("Remove-Item Env:{var}")
    } else {
        format!("unset {var}")
    }
}

#[test]
fn invalid_env_token_hiding_a_stored_login_offers_unset() {
    assert_eq!(
        inventory(JSON_BAD_ENV).status_for("github.com"),
        GithubAuthStatus::Unauthenticated {
            host: "github.com".to_string(),
            login_command: unset("GH_TOKEN"),
        }
    );
}

#[test]
fn invalid_env_token_alone_offers_unset_then_login() {
    let inventory = with_accounts(
        "github.com",
        vec![account(
            false,
            true,
            TokenOrigin::Env("GH_TOKEN".into()),
            None,
        )],
    );
    assert_eq!(
        inventory.status_for("github.com"),
        GithubAuthStatus::Unauthenticated {
            host: "github.com".to_string(),
            login_command: format!("{}; gh auth login --hostname github.com", unset("GH_TOKEN")),
        }
    );
}

#[test]
fn failed_stored_login_offers_login() {
    let inventory = with_accounts(
        "github.com",
        vec![account(false, true, TokenOrigin::Stored, None)],
    );
    assert_eq!(
        inventory.status_for("github.com"),
        GithubAuthStatus::Unauthenticated {
            host: "github.com".to_string(),
            login_command: "gh auth login --hostname github.com".to_string(),
        }
    );
}

#[test]
fn env_token_hiding_a_stored_login_offers_unset() {
    let inventory = with_accounts(
        "github.com",
        vec![
            account(
                true,
                true,
                TokenOrigin::Env("GITHUB_TOKEN".into()),
                Some(&["repo", "read:org"]),
            ),
            account(
                true,
                false,
                TokenOrigin::Stored,
                Some(&["repo", "read:org"]),
            ),
        ],
    );
    let GithubAuthStatus::Connected {
        token_source,
        fix_commands,
        missing_scopes,
        ..
    } = inventory.status_for("github.com")
    else {
        panic!("expected connected");
    };
    assert_eq!(token_source, GithubTokenSource::Env);
    assert_eq!(missing_scopes, Vec::<String>::new());
    let unset = if cfg!(windows) {
        "Remove-Item Env:GITHUB_TOKEN"
    } else {
        "unset GITHUB_TOKEN"
    };
    assert_eq!(fix_commands, strings(&[unset]));
}

#[test]
fn stored_login_missing_read_org_offers_a_refresh_for_that_scope() {
    let inventory = with_accounts(
        "github.com",
        vec![account(
            true,
            true,
            TokenOrigin::Stored,
            Some(&["repo", "gist"]),
        )],
    );
    let GithubAuthStatus::Connected {
        missing_scopes,
        fix_commands,
        ..
    } = inventory.status_for("github.com")
    else {
        panic!("expected connected");
    };
    assert_eq!(missing_scopes, strings(&["read:org"]));
    assert_eq!(
        fix_commands,
        strings(&["gh auth refresh -h github.com -s read:org"])
    );
}

#[test]
fn admin_org_satisfies_read_org_and_unknown_scopes_report_nothing_missing() {
    let granted = with_accounts(
        "github.com",
        vec![account(
            true,
            true,
            TokenOrigin::Stored,
            Some(&["repo", "admin:org"]),
        )],
    );
    let unknown = with_accounts(
        "github.com",
        vec![account(true, true, TokenOrigin::Stored, None)],
    );
    for inventory in [granted, unknown] {
        let GithubAuthStatus::Connected { missing_scopes, .. } = inventory.status_for("github.com")
        else {
            panic!("expected connected");
        };
        assert_eq!(missing_scopes, Vec::<String>::new());
    }
}

#[test]
fn no_hosts_is_unauthenticated_for_the_asked_host() {
    let inventory = inventory(r#"{"hosts":{}}"#);
    assert!(!inventory.knows("ghe.corp.example"));
    assert_eq!(
        inventory.status_for("ghe.corp.example"),
        GithubAuthStatus::Unauthenticated {
            host: "ghe.corp.example".to_string(),
            login_command: "gh auth login --hostname ghe.corp.example".to_string(),
        }
    );
}

#[test]
fn current_text_report_parses_like_the_json() {
    assert_eq!(parse_auth_text(TEXT_CURRENT), inventory(JSON_STORED));
}

#[test]
fn legacy_text_report_lists_every_host() {
    let inventory = parse_auth_text(TEXT_LEGACY);
    assert_eq!(
        inventory.hosts.keys().collect::<Vec<_>>(),
        vec!["ghe.corp.example", "github.com"]
    );
    let GithubAuthStatus::Connected {
        account,
        scopes,
        missing_scopes,
        token_source,
        ..
    } = inventory.status_for("github.com")
    else {
        panic!("expected connected");
    };
    assert_eq!(account, "octo");
    assert_eq!(scopes, strings(&["gist", "repo"]));
    assert_eq!(missing_scopes, strings(&["read:org"]));
    assert_eq!(token_source, GithubTokenSource::Keyring);
    assert!(matches!(
        inventory.status_for("ghe.corp.example"),
        GithubAuthStatus::Connected { ref account, ref missing_scopes, .. }
            if account == "octo-corp" && missing_scopes.is_empty()
    ));
}

#[test]
fn text_report_for_a_failed_env_token_marks_the_account_failed() {
    let text = "github.com
  X Failed to log in to github.com using token (GH_TOKEN)
  - Active account: true
  - The token in GH_TOKEN is invalid.
";
    assert_eq!(
        parse_auth_text(text).hosts["github.com"],
        vec![HostAccount {
            ok: false,
            active: true,
            login: String::new(),
            origin: TokenOrigin::Env("GH_TOKEN".into()),
            scopes: None,
        }]
    );
}

#[test]
fn auth_status_serializes_as_the_ts_union() {
    let status = inventory(JSON_STORED).status_for("github.com");
    assert_eq!(
        serde_json::to_value(status).unwrap(),
        serde_json::json!({
            "state": "connected",
            "host": "github.com",
            "account": "gnoviawan",
            "scopes": ["gist", "read:org", "repo", "workflow"],
            "tokenSource": "keyring",
            "missingScopes": [],
            "fixCommands": []
        })
    );
    assert_eq!(
        serde_json::to_value(GithubAuthStatus::Unauthenticated {
            host: "h".into(),
            login_command: "c".into()
        })
        .unwrap(),
        serde_json::json!({ "state": "unauthenticated", "host": "h", "loginCommand": "c" })
    );
    assert_eq!(
        serde_json::to_value(GithubAuthStatus::CliMissing).unwrap(),
        serde_json::json!({ "state": "cli_missing" })
    );
}

fn text_inventory(stderr: &'static str) -> Result<HostInventory, crate::github::GithubError> {
    let (process, _) = super::fake_gh::fake_gh(move |args| {
        if args.iter().any(|arg| arg == "--json") {
            return super::fake_gh::fail("unknown flag: --json");
        }
        super::fake_gh::fail(stderr)
    });
    super::auth::load_inventory(&super::runner::GhRunner::new(process))
}

#[test]
fn old_gh_signed_out_text_report_is_an_empty_inventory() {
    assert_eq!(
        text_inventory("You are not logged into any GitHub hosts. To log in, run: gh auth login"),
        Ok(HostInventory::default())
    );
}

#[test]
fn old_gh_failing_text_report_is_an_error_not_a_sign_out() {
    let error = text_inventory("failed to read configuration: permission denied").unwrap_err();
    assert_eq!(
        error.to_string(),
        "gh failed: failed to read configuration: permission denied"
    );
}
