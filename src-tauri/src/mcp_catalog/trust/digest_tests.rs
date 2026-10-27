use super::digest::launch_digest;
use crate::mcp_catalog::convert::OptionKind;
use crate::mcp_catalog::resolved::{Provenance, ResolvedConfig, ValueSlot};

fn slot(name: &str, is_secret: bool) -> ValueSlot {
    ValueSlot {
        name: name.to_string(),
        is_secret,
    }
}

fn hooka() -> ResolvedConfig {
    ResolvedConfig::Stdio {
        command: "npx".to_string(),
        args: vec!["-y".to_string(), "hooka-mcp@0.1.2".to_string()],
        env: vec![slot("HOOKA_API_KEY", true), slot("HOOKA_REGION", false)],
    }
}

fn hooka_provenance() -> Provenance {
    Provenance {
        name: "to.hooka/mcp".to_string(),
        version: "0.1.2".to_string(),
        kind: OptionKind::Package,
        index: 0,
        repository_id: None,
    }
}

/// Stored approvals outlive releases, so the digest of a fixed spec is a
/// promise: this literal changes only with `DIGEST_FORM_VERSION`.
#[test]
fn digest_of_a_fixed_spec_is_pinned() {
    assert_eq!(
        launch_digest(&hooka(), Some(&hooka_provenance())),
        "sha256:b7a9164474c1e27836e7856a3f96e079c762a1c69dc0b33cea68d335fdbde4f9"
    );
}

#[test]
fn env_order_and_secret_flags_do_not_change_the_digest() {
    let reordered = ResolvedConfig::Stdio {
        command: "npx".to_string(),
        args: vec!["-y".to_string(), "hooka-mcp@0.1.2".to_string()],
        env: vec![slot("HOOKA_REGION", true), slot("HOOKA_API_KEY", false)],
    };
    assert_eq!(
        launch_digest(&reordered, Some(&hooka_provenance())),
        launch_digest(&hooka(), Some(&hooka_provenance()))
    );
}

#[test]
fn argv_env_name_and_provenance_changes_each_change_the_digest() {
    let base = launch_digest(&hooka(), Some(&hooka_provenance()));

    let other_args = ResolvedConfig::Stdio {
        command: "npx".to_string(),
        args: vec![
            "-y".to_string(),
            "hooka-mcp@0.1.2".to_string(),
            "--verbose".to_string(),
        ],
        env: vec![slot("HOOKA_API_KEY", true), slot("HOOKA_REGION", false)],
    };
    assert_ne!(launch_digest(&other_args, Some(&hooka_provenance())), base);

    let other_env = ResolvedConfig::Stdio {
        command: "npx".to_string(),
        args: vec!["-y".to_string(), "hooka-mcp@0.1.2".to_string()],
        env: vec![slot("HOOKA_API_KEY", true)],
    };
    assert_ne!(launch_digest(&other_env, Some(&hooka_provenance())), base);

    let upgraded = Provenance {
        version: "0.1.3".to_string(),
        ..hooka_provenance()
    };
    assert_ne!(launch_digest(&hooka(), Some(&upgraded)), base);
    assert_ne!(launch_digest(&hooka(), None), base);
}

#[test]
fn remote_digest_covers_transport_url_and_header_names() {
    let http = ResolvedConfig::Http {
        url: "https://tre-app.com/api/mcp".to_string(),
        headers: vec![slot("Authorization", true)],
    };
    let sse = ResolvedConfig::Sse {
        url: "https://tre-app.com/api/mcp".to_string(),
        headers: vec![slot("Authorization", true)],
    };
    let other_url = ResolvedConfig::Http {
        url: "https://tre-app.com/api/mcp?x=1".to_string(),
        headers: vec![slot("Authorization", true)],
    };
    let no_header = ResolvedConfig::Http {
        url: "https://tre-app.com/api/mcp".to_string(),
        headers: vec![],
    };
    let base = launch_digest(&http, None);
    assert_eq!(
        base,
        "sha256:950e4bd8f305f97b90df7158f994818ce7ddf248b9f00d43c93b531201e8646f"
    );
    assert_ne!(launch_digest(&sse, None), base);
    assert_ne!(launch_digest(&other_url, None), base);
    assert_ne!(launch_digest(&no_header, None), base);
}
