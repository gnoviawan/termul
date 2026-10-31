use std::io::Write;

use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::convert::{McpCatalogReason, OptionKind, Runner};
use super::search::{item_status, McpCatalogDefaultOption, McpCatalogState, RunnerAvailability};
use super::snapshot::{
    item_from_row, load, load_embedded, load_or_empty, RegistryStatus, SnapshotError,
};

const ALL_RUNNERS: RunnerAvailability = RunnerAvailability {
    npx: true,
    uvx: true,
    docker: true,
    dotnet: true,
};

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn meta_for(gz: &[u8]) -> String {
    json!({ "sha256": format!("{:x}", Sha256::digest(gz)), "fetchedAt": "2026-10-27T00:00:00Z" })
        .to_string()
}

fn snapshot(file: Value) -> (Vec<u8>, String) {
    let gz = gzip(file.to_string().as_bytes());
    let meta = meta_for(&gz);
    (gz, meta)
}

fn latest_row(name: &str) -> Value {
    json!({
        "server": { "name": name, "description": "d", "version": "1.0.0" },
        "_meta": { "io.modelcontextprotocol.registry/official": { "status": "active", "isLatest": true } }
    })
}

fn remote(index: usize) -> Option<McpCatalogDefaultOption> {
    Some(McpCatalogDefaultOption {
        kind: OptionKind::Remote,
        index,
    })
}

fn package(index: usize) -> Option<McpCatalogDefaultOption> {
    Some(McpCatalogDefaultOption {
        kind: OptionKind::Package,
        index,
    })
}

fn unsupported(
    reason: McpCatalogReason,
    option: Option<McpCatalogDefaultOption>,
) -> (
    McpCatalogState,
    Option<McpCatalogReason>,
    Option<McpCatalogDefaultOption>,
) {
    (McpCatalogState::Unsupported, Some(reason), option)
}

fn installable(
    option: Option<McpCatalogDefaultOption>,
) -> (
    McpCatalogState,
    Option<McpCatalogReason>,
    Option<McpCatalogDefaultOption>,
) {
    (McpCatalogState::Installable, None, option)
}

/// The committed fixture holds one real registry row per AD-4 class
/// (`scripts/mcp-registry-fixture-names.txt`).
#[test]
fn the_fixture_covers_every_state_and_reason_class() {
    let catalog = load_embedded();
    assert!(catalog.source.updated_at.is_some());
    assert!(
        catalog.source.sample,
        "the committed fixture is marked as the sample"
    );
    let status = |name: &str, runners| {
        let item = catalog
            .items
            .iter()
            .find(|item| item.name == name)
            .unwrap_or_else(|| panic!("{name} is in the fixture"));
        item_status(item, runners)
    };
    let expected = [
        (
            "io.github.workmagicio/workmagic-mcp",
            installable(remote(0)),
        ),
        ("com.tre-app/tre", installable(remote(0))),
        ("ai.anzenna/anzenna", installable(remote(0))),
        ("space.r3plica/catalog", installable(remote(0))),
        ("io.github.sharan01x/usetested", installable(remote(0))),
        ("to.hooka/mcp", installable(package(0))),
        ("io.github.tmonk/mcp-stata", installable(package(0))),
        ("io.github.luckyjupiter/occultron", installable(package(0))),
        ("io.github.BargLabs/cejel", installable(package(0))),
        (
            "io.github.domdomegg/time-mcp-nuget",
            installable(package(0)),
        ),
        (
            "io.github.jghiglia2380/0latency",
            unsupported(McpCatalogReason::SecretInUrl, remote(0)),
        ),
        (
            "io.github.yotamfreund-eng/greeting",
            unsupported(McpCatalogReason::UnpinnedVersion, package(0)),
        ),
        (
            "io.github.ycjcl868/mcp-server-fear-greed",
            unsupported(McpCatalogReason::UnpinnedVersion, package(0)),
        ),
        (
            "io.github.JacobBruce/CAIT",
            unsupported(
                McpCatalogReason::UnsupportedRegistryType {
                    registry_type: "mcpb".to_string(),
                },
                package(0),
            ),
        ),
        (
            "io.github.craftbag/craftbag-mcp",
            unsupported(
                McpCatalogReason::UnsupportedRegistryType {
                    registry_type: "cargo".to_string(),
                },
                package(0),
            ),
        ),
        (
            "io.github.mickymultani/crypto-bytes",
            unsupported(McpCatalogReason::RuntimeArguments, package(0)),
        ),
        (
            "ai.kaiv/postgres",
            unsupported(McpCatalogReason::SecretInArguments, package(0)),
        ),
        (
            "io.github.SamuelMoraesF/mcp-nfse-nacional",
            unsupported(
                McpCatalogReason::DeniedEnv {
                    name: "NODE_OPTIONS".to_string(),
                },
                package(0),
            ),
        ),
        (
            "io.github.jugbeep/lustre",
            unsupported(
                McpCatalogReason::RuntimeHintMismatch {
                    runtime_hint: "node".to_string(),
                },
                package(0),
            ),
        ),
        (
            "icu.steeped.registry/nodejsmcp",
            unsupported(
                McpCatalogReason::NonStdioTransport {
                    transport: "streamable-http".to_string(),
                },
                package(0),
            ),
        ),
        (
            "io.github.mbtest870-ctrl/agenza",
            (
                McpCatalogState::SourceOnly,
                Some(McpCatalogReason::NoInstallOptions),
                None,
            ),
        ),
    ];
    for (name, expected) in &expected {
        assert_eq!(&status(name, ALL_RUNNERS), expected, "{name}");
    }
    assert_eq!(
        catalog.items.len(),
        expected.len() + ICON_FIXTURES.len(),
        "only the deleted row is dropped"
    );
    assert!(
        catalog
            .items
            .iter()
            .all(|item| item.name != "ai.fluxink/mcp-server"),
        "a deleted latest row never browses"
    );
    let deprecated = catalog
        .items
        .iter()
        .find(|item| item.name == "io.github.sharan01x/usetested")
        .unwrap();
    assert_eq!(deprecated.status, RegistryStatus::Deprecated);

    for (name, runtime) in [
        ("to.hooka/mcp", Runner::Npx),
        ("io.github.tmonk/mcp-stata", Runner::Uvx),
        ("io.github.luckyjupiter/occultron", Runner::Docker),
        ("io.github.domdomegg/time-mcp-nuget", Runner::Dotnet),
    ] {
        assert_eq!(
            status(name, RunnerAvailability::default()),
            (
                McpCatalogState::NeedsRuntime,
                Some(McpCatalogReason::NeedsRuntime { runtime }),
                package(0)
            ),
            "{name}"
        );
    }
}

#[test]
fn a_valid_snapshot_loads_sorted_with_its_fetch_time() {
    let (gz, meta) = snapshot(json!({
        "formatVersion": 1,
        "servers": [latest_row("io.example/b"), latest_row("io.example/a")],
        "versions": [["io.example/a", "1.0.0", "active"]]
    }));
    let catalog = load(&gz, &meta).unwrap();
    let names: Vec<&str> = catalog
        .items
        .iter()
        .map(|item| item.name.as_str())
        .collect();
    assert_eq!(names, ["io.example/a", "io.example/b"]);
    assert_eq!(
        catalog.source.updated_at.as_deref(),
        Some("2026-10-27T00:00:00Z")
    );
}

#[test]
fn a_corrupted_or_empty_snapshot_serves_an_empty_catalog() {
    let (gz, meta) =
        snapshot(json!({ "formatVersion": 1, "servers": [latest_row("io.example/a")] }));
    let mut flipped = gz.clone();
    let middle = flipped.len() / 2;
    flipped[middle] ^= 0xff;
    assert!(matches!(
        load(&flipped, &meta),
        Err(SnapshotError::Checksum)
    ));

    let garbage = b"not gzip".to_vec();
    assert!(matches!(
        load(&garbage, &meta_for(&garbage)),
        Err(SnapshotError::Decompress(_))
    ));
    let not_json = gzip(b"{ nope");
    assert!(matches!(
        load(&not_json, &meta_for(&not_json)),
        Err(SnapshotError::Json(_))
    ));
    assert!(matches!(load(&gz, "{}"), Err(SnapshotError::Meta(_))));

    let (empty, empty_meta) = snapshot(json!({ "formatVersion": 1, "servers": [] }));
    assert!(matches!(
        load(&empty, &empty_meta),
        Err(SnapshotError::Empty)
    ));
    let (future, future_meta) =
        snapshot(json!({ "formatVersion": 2, "servers": [latest_row("io.example/a")] }));
    assert!(matches!(
        load(&future, &future_meta),
        Err(SnapshotError::FormatVersion(2))
    ));

    for (gz, meta) in [
        (flipped, meta.clone()),
        (empty, empty_meta),
        (Vec::new(), meta),
    ] {
        let catalog = load_or_empty(&gz, &meta);
        assert!(catalog.items.is_empty());
        assert_eq!(catalog.source.updated_at, None);
    }
}

#[test]
fn a_row_that_does_not_parse_is_unsupported_without_failing_the_load() {
    let mut broken = latest_row("io.example/broken");
    broken["server"]["remotes"] = json!("not a list");
    broken["server"]["title"] = json!("Broken");
    let item = item_from_row(broken).expect("the row still browses");
    assert_eq!(item.title.as_deref(), Some("Broken"));
    assert_eq!(item.options, None);
    assert_eq!(
        item_status(&item, ALL_RUNNERS),
        (
            McpCatalogState::Unsupported,
            Some(McpCatalogReason::Unparseable),
            None
        )
    );

    let (gz, meta) = snapshot(json!({
        "formatVersion": 1,
        "servers": [latest_row("io.example/ok"), { "server": { "remotes": [] }, "_meta": {} }, latest_row("")]
    }));
    let names: Vec<String> = load(&gz, &meta)
        .unwrap()
        .items
        .into_iter()
        .map(|item| item.name)
        .collect();
    assert_eq!(names, ["io.example/ok"]);
}

#[test]
fn parsing_ignores_schema_and_unknown_fields() {
    let mut row = latest_row("io.example/future");
    row["server"]["$schema"] =
        json!("https://static.modelcontextprotocol.io/schemas/2099-01-01/server.schema.json");
    row["server"]["somethingNew"] = json!({ "nested": true });
    row["server"]["remotes"] =
        json!([{ "type": "streamable-http", "url": "https://mcp.example.com/mcp", "extra": 1 }]);
    let item = item_from_row(row).unwrap();
    assert_eq!(item_status(&item, ALL_RUNNERS), installable(remote(0)));
}

const ICON_FIXTURES: [(&str, &str); 3] = [
    ("ai.abmeter/abmeter", "https://abmeter.ai/favicon.svg"),
    ("ai.agenttrust/mcp-server", "https://agenttrust.ai/icon.png"),
    (
        "ai.alpic.mcp/alpic-mcp",
        "https://raw.githubusercontent.com/alpic-ai/public-assets/refs/heads/main/alpic%20logo%20light%20200x200.png",
    ),
];

#[test]
fn the_fixture_picks_one_https_logo_for_each_server_that_lists_icons() {
    let catalog = load_embedded();
    let icon = |name: &str| {
        catalog
            .items
            .iter()
            .find(|item| item.name == name)
            .unwrap_or_else(|| panic!("{name} is in the fixture"))
            .icon
            .as_ref()
            .map(|source| source.url().to_string())
    };
    for (name, url) in ICON_FIXTURES {
        assert_eq!(icon(name).as_deref(), Some(url), "{name}");
    }
    assert_eq!(
        icon("io.github.BargLabs/cejel").as_deref(),
        Some("https://cejel.dev/brand-icon.png")
    );
    assert_eq!(icon("to.hooka/mcp"), None);
}
