use serde_json::{json, Value};

use super::convert::{
    convert, is_denied_env_name, safe_repository_url, CatalogOption, Launch, McpCatalogReason,
    OptionKind, RegistryServer, RemoteTransport, Runner,
};
use super::search::{item_status, McpCatalogDefaultOption, McpCatalogState, RunnerAvailability};
use super::snapshot::{CatalogItem, RegistryStatus};

fn options(server: Value) -> Vec<CatalogOption> {
    let parsed: RegistryServer = serde_json::from_value(server).expect("server parses");
    convert(&parsed)
}

fn package(package: Value) -> Result<Launch, McpCatalogReason> {
    let mut package = package;
    if package.get("transport").is_none() {
        package["transport"] = json!({ "type": "stdio" });
    }
    options(json!({ "name": "io.example/pkg", "version": "1.0.0", "packages": [package] }))
        .remove(0)
        .outcome
}

fn remote(remote: Value) -> Result<Launch, McpCatalogReason> {
    options(json!({ "name": "io.example/remote", "version": "1.0.0", "remotes": [remote] }))
        .remove(0)
        .outcome
}

fn argv(outcome: Result<Launch, McpCatalogReason>) -> Vec<String> {
    match outcome {
        Ok(Launch::Stdio { argv, .. }) => argv,
        other => panic!("expected a stdio launch, got {other:?}"),
    }
}

fn reason(outcome: Result<Launch, McpCatalogReason>) -> McpCatalogReason {
    outcome.expect_err("expected an unsupported option")
}

#[test]
fn npm_runs_npx_with_the_pinned_package() {
    assert_eq!(
        argv(package(
            json!({ "registryType": "npm", "identifier": "@scope/server", "version": "1.2.3" })
        )),
        ["npx", "-y", "@scope/server@1.2.3"]
    );
}

#[test]
fn pypi_runs_uvx_with_the_pinned_package() {
    assert_eq!(
        argv(package(
            json!({ "registryType": "pypi", "identifier": "mcp-stata", "version": "0.4.1" })
        )),
        ["uvx", "mcp-stata@0.4.1"]
    );
}

#[test]
fn oci_runs_docker_with_generated_env_flags_only() {
    assert_eq!(
        argv(package(json!({
            "registryType": "oci",
            "identifier": "ghcr.io/example/server:0.1.0",
            "environmentVariables": [
                { "name": "API_KEY", "isSecret": true, "value": "--privileged" },
                { "name": "BASE_URL" }
            ]
        }))),
        [
            "docker",
            "run",
            "-i",
            "--rm",
            "-e",
            "API_KEY",
            "-e",
            "BASE_URL",
            "ghcr.io/example/server:0.1.0"
        ]
    );
}

#[test]
fn nuget_runs_dotnet_dnx_with_the_pinned_package() {
    assert_eq!(
        argv(package(
            json!({ "registryType": "nuget", "identifier": "TimeMcpServer", "version": "1.1.1" })
        )),
        ["dotnet", "dnx", "TimeMcpServer@1.1.1", "--yes"]
    );
}

#[test]
fn package_arguments_are_not_in_the_converted_argv() {
    assert_eq!(
        argv(package(json!({
            "registryType": "npm",
            "identifier": "server",
            "version": "1.0.0",
            "packageArguments": [{ "type": "positional", "value": "--inspect" }]
        }))),
        ["npx", "-y", "server@1.0.0"]
    );
}

#[test]
fn versions_must_be_pinned_per_runner() {
    for (registry_type, version) in [
        ("npm", Some("latest")),
        ("npm", Some("1.x")),
        ("npm", Some("1.2")),
        ("npm", None),
        ("pypi", Some("latest")),
        ("pypi", None),
        ("nuget", Some("1")),
        ("nuget", Some("latest")),
    ] {
        let mut row = json!({ "registryType": registry_type, "identifier": "server" });
        if let Some(version) = version {
            row["version"] = json!(version);
        }
        assert_eq!(
            reason(package(row)),
            McpCatalogReason::UnpinnedVersion,
            "{registry_type} {version:?}"
        );
    }
    for (registry_type, version) in [
        ("npm", "1.2.3-beta.1"),
        ("pypi", "v1.0.2"),
        ("pypi", "2.0rc1"),
        ("nuget", "1.0.0-preview.1"),
    ] {
        assert!(
            package(
                json!({ "registryType": registry_type, "identifier": "server", "version": version })
            )
            .is_ok(),
            "{registry_type} {version}"
        );
    }
}

#[test]
fn oci_images_pin_by_tag_or_digest() {
    let digest = format!("ghcr.io/example/server@sha256:{}", "a".repeat(64));
    assert_eq!(
        argv(package(
            json!({ "registryType": "oci", "identifier": digest })
        ))[4],
        digest
    );
    assert_eq!(
        argv(package(
            json!({ "registryType": "oci", "identifier": "docker.io/example/server", "version": "1.4" })
        ))[4],
        "docker.io/example/server:1.4"
    );
    let tagged_digest = format!("ghcr.io/example/server:1.4@sha256:{}", "b".repeat(64));
    assert_eq!(
        argv(package(
            json!({ "registryType": "oci", "identifier": tagged_digest })
        ))[4],
        tagged_digest
    );
    for identifier in ["ghcr.io/example/server:latest", "ghcr.io/example/server"] {
        assert_eq!(
            reason(package(
                json!({ "registryType": "oci", "identifier": identifier })
            )),
            McpCatalogReason::UnpinnedVersion,
            "{identifier}"
        );
    }
}

#[test]
fn runtime_arguments_are_unsupported() {
    assert_eq!(
        reason(package(json!({
            "registryType": "npm",
            "identifier": "server",
            "version": "1.0.0",
            "runtimeArguments": [{ "type": "positional", "value": "--package" }]
        }))),
        McpCatalogReason::RuntimeArguments
    );
}

#[test]
fn runtime_hint_must_name_the_rows_runner() {
    assert_eq!(
        reason(package(
            json!({ "registryType": "npm", "identifier": "server", "version": "1.0.0", "runtimeHint": "node" })
        )),
        McpCatalogReason::RuntimeHintMismatch {
            runtime_hint: "node".to_string()
        }
    );
    for (registry_type, hint) in [("npm", "npx"), ("pypi", "uvx"), ("nuget", "dnx")] {
        assert!(
            package(json!({ "registryType": registry_type, "identifier": "server", "version": "1.0.0", "runtimeHint": hint }))
                .is_ok(),
            "{registry_type} {hint}"
        );
    }
}

#[test]
fn runner_hijack_env_names_are_denied_case_insensitively() {
    for name in [
        "NODE_OPTIONS",
        "node_options",
        "npm_config_registry",
        "NPM_CONFIG_CACHE",
        "UV_INDEX_URL",
        "PIP_INDEX_URL",
        "PYTHONPATH",
        "PythonStartup",
        "DOCKER_HOST",
        "PATH",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "DOTNET_ROOT",
        "NUGET_PACKAGES",
    ] {
        assert!(is_denied_env_name(name), "{name}");
        assert_eq!(
            reason(package(json!({
                "registryType": "npm",
                "identifier": "server",
                "version": "1.0.0",
                "environmentVariables": [{ "name": name }]
            }))),
            McpCatalogReason::DeniedEnv {
                name: name.to_string()
            }
        );
    }
    for name in ["API_KEY", "NODE_ENV", "PATHWAY_TOKEN", "UVICORN_PORT"] {
        assert!(!is_denied_env_name(name), "{name}");
    }
}

#[test]
fn env_names_must_be_plain_identifiers() {
    assert_eq!(
        reason(package(json!({
            "registryType": "oci",
            "identifier": "ghcr.io/example/server:1.0.0",
            "environmentVariables": [{ "name": "FOO=bar" }]
        }))),
        McpCatalogReason::InvalidEnvName {
            name: "FOO=bar".to_string()
        }
    );
}

#[test]
fn package_grammar_rejects_flags_and_cmd_metacharacters() {
    for identifier in [
        "-e", "--yes", "pkg&calc", "pkg|more", "a^b", "a%PATH%", "a\"b", "a b", "a(b)", "a!b",
        "a<b", "",
    ] {
        assert_eq!(
            reason(package(
                json!({ "registryType": "npm", "identifier": identifier, "version": "1.0.0" })
            )),
            McpCatalogReason::InvalidPackage,
            "{identifier:?}"
        );
    }
    for version in ["-1.0.0", "1.0.0&calc", "1.0.0 --yes"] {
        assert_eq!(
            reason(package(
                json!({ "registryType": "npm", "identifier": "server", "version": version })
            )),
            McpCatalogReason::InvalidPackage,
            "{version:?}"
        );
    }
}

#[test]
fn package_grammar_rejects_url_path_vcs_and_alias_specs() {
    for (registry_type, identifier) in [
        ("npm", "https://evil.example/p.tgz"),
        ("npm", "file:../x"),
        ("npm", "git+https://evil.example/r.git"),
        ("npm", "github:user/repo"),
        ("npm", "npm:other"),
        ("npm", "user/repo"),
        ("npm", "../server"),
        ("npm", "server.tgz"),
        ("npm", "Server"),
        ("pypi", "https://evil.example/p.whl"),
        ("pypi", "https://evil.example/pkg@1.0.whl"),
        ("pypi", "git+https://evil.example/r"),
        ("pypi", "./server"),
        ("nuget", "https://evil.example/p.nupkg"),
        ("nuget", "../Server"),
        ("oci", "https://ghcr.io/example/server:1.0.0"),
        ("oci", "ghcr.io/Example/server:1.0.0"),
    ] {
        assert_eq!(
            reason(package(
                json!({ "registryType": registry_type, "identifier": identifier, "version": "1.0.0" })
            )),
            McpCatalogReason::InvalidPackage,
            "{registry_type} {identifier:?}"
        );
    }
    for version in ["1.0.0-a.tgz", "1.0.0+b.TAR.GZ", "1.0.0-x.tar"] {
        assert_eq!(
            reason(package(
                json!({ "registryType": "npm", "identifier": "server", "version": version })
            )),
            McpCatalogReason::InvalidPackage,
            "{version}"
        );
    }
    for (registry_type, identifier, expected) in [
        (
            "npm",
            "@scope/server-name",
            vec!["npx", "-y", "@scope/server-name@1.0.0"],
        ),
        ("npm", "server.js", vec!["npx", "-y", "server.js@1.0.0"]),
        ("pypi", "Mcp_Server.x", vec!["uvx", "Mcp_Server.x@1.0.0"]),
        (
            "nuget",
            "Example.Mcp.Server",
            vec!["dotnet", "dnx", "Example.Mcp.Server@1.0.0", "--yes"],
        ),
    ] {
        assert_eq!(
            argv(package(
                json!({ "registryType": registry_type, "identifier": identifier, "version": "1.0.0" })
            )),
            expected,
            "{registry_type} {identifier:?}"
        );
    }
}

#[test]
fn packages_must_come_from_the_runners_registry() {
    for (registry_type, base) in [
        ("npm", "https://registry.npmjs.org"),
        ("npm", "https://registry.npmjs.org/"),
        ("pypi", "https://pypi.org"),
        ("nuget", "https://api.nuget.org/v3/index.json"),
        ("npm", ""),
    ] {
        assert!(
            argv(package(json!({
                "registryType": registry_type,
                "identifier": "server",
                "version": "1.0.0",
                "registryBaseUrl": base
            })))
            .contains(&"server@1.0.0".to_string()),
            "{registry_type} {base}"
        );
    }
    for (registry_type, base) in [
        ("npm", "https://evil.example"),
        ("pypi", "https://evil.example/simple"),
        ("nuget", "https://evil.example/v3/index.json"),
    ] {
        assert_eq!(
            reason(package(json!({
                "registryType": registry_type,
                "identifier": "server",
                "version": "1.0.0",
                "registryBaseUrl": base
            }))),
            McpCatalogReason::UnsupportedRegistry {
                registry: base.to_string()
            },
            "{registry_type} {base}"
        );
    }
}

#[test]
fn oci_images_must_come_from_an_allowed_registry() {
    for identifier in [
        "example/server:1.0.0",
        "ghcr.io/example/server:1.0.0",
        "quay.io/example/server:1.0.0",
        "us-docker.pkg.dev/project/repo/server:1.0.0",
    ] {
        assert_eq!(
            argv(package(
                json!({ "registryType": "oci", "identifier": identifier })
            ))[4],
            identifier
        );
    }
    for (identifier, host) in [
        ("localhost:5000/server:1.0.0", "localhost:5000"),
        ("evil.example/server:1.0.0", "evil.example"),
        ("ghcr.io.evil.example/server:1.0.0", "ghcr.io.evil.example"),
        ("pkg.dev.evil.example/server:1.0.0", "pkg.dev.evil.example"),
    ] {
        assert_eq!(
            reason(package(
                json!({ "registryType": "oci", "identifier": identifier })
            )),
            McpCatalogReason::UnsupportedRegistry {
                registry: host.to_string()
            },
            "{identifier}"
        );
    }
    assert_eq!(
        reason(package(json!({
            "registryType": "oci",
            "identifier": "ghcr.io/example/server:1.0.0",
            "registryBaseUrl": "https://quay.io"
        }))),
        McpCatalogReason::UnsupportedRegistry {
            registry: "https://quay.io".to_string()
        }
    );
    assert_eq!(
        argv(package(json!({
            "registryType": "oci",
            "identifier": "ghcr.io/example/server:1.0.0",
            "registryBaseUrl": "https://ghcr.io"
        })))[4],
        "ghcr.io/example/server:1.0.0"
    );
}

#[test]
fn download_redirect_env_names_are_denied() {
    for name in [
        "HTTPS_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "NO_PROXY",
        "NODE_TLS_REJECT_UNAUTHORIZED",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "Ssl_Cert_Dir",
        "REQUESTS_CA_BUNDLE",
        "curl_ca_bundle",
    ] {
        assert!(is_denied_env_name(name), "{name}");
    }
}

#[test]
fn unknown_registry_types_and_non_stdio_transports_are_unsupported() {
    for registry_type in ["mcpb", "cargo", "gem"] {
        assert_eq!(
            reason(package(
                json!({ "registryType": registry_type, "identifier": "server", "version": "1.0.0" })
            )),
            McpCatalogReason::UnsupportedRegistryType {
                registry_type: registry_type.to_string()
            }
        );
    }
    assert_eq!(
        reason(package(json!({
            "registryType": "npm",
            "identifier": "server",
            "version": "1.0.0",
            "transport": { "type": "streamable-http", "url": "http://localhost:8080/mcp" }
        }))),
        McpCatalogReason::NonStdioTransport {
            transport: "streamable-http".to_string()
        }
    );
}

#[test]
fn secrets_in_arguments_are_unsupported() {
    assert_eq!(
        reason(package(json!({
            "registryType": "npm",
            "identifier": "server",
            "version": "1.0.0",
            "packageArguments": [{ "type": "positional", "isSecret": true, "valueHint": "database_url" }]
        }))),
        McpCatalogReason::SecretInArguments
    );
    assert_eq!(
        reason(package(json!({
            "registryType": "npm",
            "identifier": "server",
            "version": "1.0.0",
            "packageArguments": [{
                "type": "named",
                "name": "--token",
                "value": "{token}",
                "variables": { "token": { "isSecret": true } }
            }]
        }))),
        McpCatalogReason::SecretInArguments
    );
}

#[test]
fn remotes_map_streamable_http_to_http_and_keep_sse() {
    assert_eq!(
        remote(json!({ "type": "streamable-http", "url": "https://mcp.example.com/mcp" })),
        Ok(Launch::Remote {
            transport: RemoteTransport::Http,
            url: "https://mcp.example.com/mcp".to_string()
        })
    );
    assert_eq!(
        remote(json!({ "type": "sse", "url": "https://mcp.example.com/sse" })),
        Ok(Launch::Remote {
            transport: RemoteTransport::Sse,
            url: "https://mcp.example.com/sse".to_string()
        })
    );
    assert_eq!(
        reason(remote(
            json!({ "type": "websocket", "url": "https://mcp.example.com/ws" })
        )),
        McpCatalogReason::UnknownRemoteTransport {
            transport: "websocket".to_string()
        }
    );
}

#[test]
fn remotes_must_be_https_on_a_public_host() {
    assert_eq!(
        reason(remote(
            json!({ "type": "streamable-http", "url": "http://mcp.example.com/mcp" })
        )),
        McpCatalogReason::InsecureUrl
    );
    for url in [
        "https://localhost/mcp",
        "https://api.localhost/mcp",
        "https://127.0.0.1/mcp",
        "https://127.1/mcp",
        "https://10.0.0.5/mcp",
        "https://172.16.4.1/mcp",
        "https://192.168.1.2:8443/mcp",
        "https://169.254.169.254/latest",
        "https://100.64.0.1/mcp",
        "https://0.0.0.0/mcp",
        "https://[::1]/mcp",
        "https://[fd00::1]/mcp",
        "https://[fe80::1]/mcp",
        "https://[::ffff:10.0.0.1]/mcp",
    ] {
        assert_eq!(
            reason(remote(json!({ "type": "streamable-http", "url": url }))),
            McpCatalogReason::LocalNetworkUrl,
            "{url}"
        );
    }
    assert_eq!(
        reason(remote(json!({ "type": "sse", "url": "not a url" }))),
        McpCatalogReason::InvalidUrl
    );
    assert!(remote(
        json!({ "type": "streamable-http", "url": "https://{tenant}.example.com/mcp" })
    )
    .is_ok());
    assert_eq!(
        reason(remote(
            json!({ "type": "streamable-http", "url": "https://mcp.example.com/path/{tenant" })
        )),
        McpCatalogReason::InvalidUrl
    );
}

#[test]
fn secret_url_variables_are_unsupported_but_secret_headers_are_not() {
    assert_eq!(
        reason(remote(json!({
            "type": "sse",
            "url": "https://mcp.example.com/mcp?key={api_key}",
            "variables": { "api_key": { "isSecret": true } }
        }))),
        McpCatalogReason::SecretInUrl
    );
    assert!(remote(json!({
        "type": "streamable-http",
        "url": "https://mcp.example.com/mcp",
        "headers": [{ "name": "Authorization", "isSecret": true }]
    }))
    .is_ok());
}

#[test]
fn repository_links_leave_the_host_only_over_https() {
    assert_eq!(
        safe_repository_url("https://github.com/example/server").as_deref(),
        Some("https://github.com/example/server")
    );
    for url in [
        "http://github.com/example/server",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "http://localhost:3000/repo",
        "",
    ] {
        assert_eq!(safe_repository_url(url), None, "{url}");
    }
}

fn item(server: Value) -> CatalogItem {
    let parsed: RegistryServer = serde_json::from_value(server).expect("server parses");
    CatalogItem {
        options: Some(convert(&parsed)),
        name: parsed.name,
        title: parsed.title,
        description: parsed.description,
        version: parsed.version,
        status: RegistryStatus::Active,
        repository_url: None,
        icon: None,
    }
}

const ALL_RUNNERS: RunnerAvailability = RunnerAvailability {
    npx: true,
    uvx: true,
    docker: true,
    dotnet: true,
};

#[test]
fn the_default_option_is_remote_first_and_streamable_http_before_sse() {
    let item = item(json!({
        "name": "io.example/both",
        "version": "1.0.0",
        "remotes": [
            { "type": "sse", "url": "https://mcp.example.com/sse" },
            { "type": "streamable-http", "url": "https://mcp.example.com/mcp" }
        ],
        "packages": [{ "registryType": "npm", "identifier": "server", "version": "1.0.0", "transport": { "type": "stdio" } }]
    }));
    assert_eq!(
        item_status(&item, ALL_RUNNERS),
        (
            McpCatalogState::Installable,
            None,
            Some(McpCatalogDefaultOption {
                kind: OptionKind::Remote,
                index: 1
            })
        )
    );
}

#[test]
fn the_item_state_is_its_best_option_state() {
    let mixed = item(json!({
        "name": "io.example/mixed",
        "version": "1.0.0",
        "remotes": [{ "type": "streamable-http", "url": "http://mcp.example.com/mcp" }],
        "packages": [
            { "registryType": "mcpb", "identifier": "https://example.com/x.mcpb", "transport": { "type": "stdio" } },
            { "registryType": "pypi", "identifier": "server", "version": "1.0.0", "transport": { "type": "stdio" } },
            { "registryType": "npm", "identifier": "server", "version": "1.0.0", "transport": { "type": "stdio" } }
        ]
    }));
    let package = |index| {
        Some(McpCatalogDefaultOption {
            kind: OptionKind::Package,
            index,
        })
    };
    assert_eq!(
        item_status(&mixed, ALL_RUNNERS),
        (McpCatalogState::Installable, None, package(1))
    );
    let npx_only = RunnerAvailability {
        npx: true,
        ..RunnerAvailability::default()
    };
    assert_eq!(
        item_status(&mixed, npx_only),
        (McpCatalogState::Installable, None, package(2))
    );
    assert_eq!(
        item_status(&mixed, RunnerAvailability::default()),
        (
            McpCatalogState::NeedsRuntime,
            Some(McpCatalogReason::NeedsRuntime {
                runtime: Runner::Uvx
            }),
            package(1)
        )
    );

    let unsupported = item(json!({
        "name": "io.example/unsupported",
        "version": "1.0.0",
        "packages": [{ "registryType": "cargo", "identifier": "server", "version": "1.0.0" }]
    }));
    assert_eq!(
        item_status(&unsupported, ALL_RUNNERS),
        (
            McpCatalogState::Unsupported,
            Some(McpCatalogReason::UnsupportedRegistryType {
                registry_type: "cargo".to_string()
            }),
            package(0)
        )
    );

    let source_only = item(json!({ "name": "io.example/source", "version": "1.0.0" }));
    assert_eq!(
        item_status(&source_only, ALL_RUNNERS),
        (
            McpCatalogState::SourceOnly,
            Some(McpCatalogReason::NoInstallOptions),
            None
        )
    );
}

#[test]
fn reasons_serialize_as_a_code_with_camel_case_detail() {
    assert_eq!(
        serde_json::to_value(McpCatalogReason::RuntimeHintMismatch {
            runtime_hint: "node".to_string()
        })
        .unwrap(),
        json!({ "code": "runtime-hint-mismatch", "runtimeHint": "node" })
    );
    assert_eq!(
        serde_json::to_value(McpCatalogReason::NeedsRuntime {
            runtime: Runner::Dotnet
        })
        .unwrap(),
        json!({ "code": "needs-runtime", "runtime": "dotnet" })
    );
    assert_eq!(
        serde_json::to_value(McpCatalogReason::NoInstallOptions).unwrap(),
        json!({ "code": "no-install-options" })
    );
    assert_eq!(
        serde_json::to_value(McpCatalogReason::UnsupportedRegistry {
            registry: "evil.example".to_string()
        })
        .unwrap(),
        json!({ "code": "unsupported-registry", "registry": "evil.example" })
    );
}
