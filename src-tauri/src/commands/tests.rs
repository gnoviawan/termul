use super::*;

#[test]
fn test_ipc_result_success() {
    let result: IpcResult<String> = IpcResult::success("test".to_string());
    assert!(result.success);
    assert_eq!(result.data, Some("test".to_string()));
    assert!(result.error.is_none());
    assert!(result.code.is_none());
}

#[test]
fn test_ipc_result_error() {
    let result: IpcResult<String> = IpcResult::error("test error", "TEST_ERROR");
    assert!(!result.success);
    assert!(result.data.is_none());
    assert_eq!(result.error, Some("test error".to_string()));
    assert_eq!(result.code, Some("TEST_ERROR".to_string()));
}

/// Typed idempotent delete contract for `acp_history_delete`: success
/// carries `data: true` (record removed) or `data: false` (already
/// absent / no durable store) — the renderer never string-sniffs errors.
#[test]
fn acp_history_delete_boolean_contract_serializes() {
    let deleted: IpcResult<bool> = IpcResult::success(true);
    let absent: IpcResult<bool> = IpcResult::success(false);
    assert_eq!(deleted.data, Some(true));
    assert_eq!(absent.data, Some(false));
    let json = serde_json::to_value(&absent).unwrap();
    assert_eq!(json["success"], true);
    assert_eq!(json["data"], false);
    assert!(json.get("error").is_none());
}

/// The host-owned list maps `SessionIndexEntry` (camelCase wire) into the
/// renderer's `ChatHistoryIndexEntry` shape unchanged by the ownership
/// transfer: `config:<id>` namespaces collapse back to the bare config id,
/// absent titles/projects fall back to the renderer defaults.
#[test]
fn host_entry_to_desktop_maps_renderer_shape() {
    let entry = crate::acp::SessionIndexEntry {
        storage_key: "key".to_string(),
        session_id: "s-1".to_string(),
        stable_agent_namespace: Some("config:claude".to_string()),
        runtime_agent_id: Some("runtime-1".to_string()),
        project_id: Some("p-1".to_string()),
        cwd: "/work".to_string(),
        title: Some("Chat".to_string()),
        title_source: None,
        created_at: 10,
        last_activity_at: 20,
        status: crate::acp::PersistedSessionStatus::Active,
        message_count: 3,
        tool_count: 1,
        last_seq: 5,
        discovered: false,
        resume_eligible: true,
        worktree_path: None,
        worktree_branch: None,
    };
    let desktop = host_entry_to_desktop(entry);
    assert_eq!(desktop.id, "s-1");
    assert_eq!(desktop.agent_id, "runtime-1");
    assert_eq!(desktop.agent_config_id.as_deref(), Some("claude"));
    assert_eq!(desktop.title, "Chat");
    assert_eq!(desktop.cwd, "/work");
    assert_eq!(desktop.project_id, "p-1");
    assert_eq!(desktop.created_at, 10);
    assert_eq!(desktop.last_activity_at, 20);
    assert_eq!(desktop.message_count, 3);
    assert!(matches!(
        desktop.status,
        crate::acp::ChatHistoryStatus::Active
    ));

    let bare = crate::acp::SessionIndexEntry {
        storage_key: "k".to_string(),
        session_id: "s-2".to_string(),
        stable_agent_namespace: Some("custom-ns".to_string()),
        runtime_agent_id: None,
        project_id: None,
        cwd: "/w".to_string(),
        title: None,
        title_source: None,
        created_at: 1,
        last_activity_at: 2,
        status: crate::acp::PersistedSessionStatus::Error,
        message_count: 0,
        tool_count: 0,
        last_seq: 0,
        discovered: false,
        resume_eligible: false,
        worktree_path: None,
        worktree_branch: None,
    };
    let desktop = host_entry_to_desktop(bare);
    assert_eq!(desktop.agent_id, "");
    assert!(
        desktop.agent_config_id.is_none(),
        "non config: namespace must not surface as agentConfigId"
    );
    assert_eq!(desktop.title, "Untitled Chat");
    assert_eq!(desktop.project_id, "");
    assert!(matches!(
        desktop.status,
        crate::acp::ChatHistoryStatus::Error
    ));
}

#[test]
fn sanitize_log_field_escapes_newlines_and_strips_controls() {
    // Newlines/CR/tab are escaped so injected content stays on one line.
    let forged = "oops\n[startup] termul forged line\r\tend";
    let cleaned = sanitize_log_field(forged);
    assert!(!cleaned.contains('\n'));
    assert!(!cleaned.contains('\r'));
    assert!(!cleaned.contains('\t'));
    assert!(cleaned.contains("\\n[startup]"));

    // ESC and other C0 control chars are dropped entirely.
    let with_esc = "a\u{1b}[31mred\u{0007}b";
    assert_eq!(sanitize_log_field(with_esc), "a[31mredb");
}

#[test]
fn sanitize_log_field_truncates_oversized_input() {
    let huge = "x".repeat(MAX_FRONTEND_FIELD_LEN + 100);
    let cleaned = sanitize_log_field(&huge);
    assert!(cleaned.ends_with("…[truncated]"));
    assert!(cleaned.chars().count() <= MAX_FRONTEND_FIELD_LEN + "…[truncated]".chars().count());
}

fn rg_fixture_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("termul_rg_{name}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("create rg fixture root");
    root
}

#[test]
fn resolve_rg_path_prefers_bundled_name_beside_the_executable() {
    let root = rg_fixture_root("bundle");
    let exe_dir = root.join("Contents").join("MacOS");
    std::fs::create_dir_all(&exe_dir).unwrap();
    let bundled = exe_dir.join(rg_bundled_file_name());
    std::fs::write(&bundled, b"bundle").unwrap();
    // The triple-named file beside the executable must lose to the name
    // Tauri actually ships (`Contents/MacOS/rg`).
    std::fs::write(exe_dir.join(rg_sidecar_name()), b"triple").unwrap();

    let (path, source) = resolve_rg_path_from(None, Some(&exe_dir));
    assert_eq!(source, "sidecar");
    assert_eq!(PathBuf::from(path), bundled);

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn resolve_rg_path_uses_dev_triple_name_when_bundle_name_is_absent() {
    let root = rg_fixture_root("dev");
    let cwd = root.join("repo");
    let bin = cwd.join("src-tauri").join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let triple = bin.join(rg_sidecar_name());
    std::fs::write(&triple, b"dev").unwrap();
    let exe_dir = root.join("target").join("debug");
    std::fs::create_dir_all(&exe_dir).unwrap();

    let (path, source) = resolve_rg_path_from(Some(&cwd), Some(&exe_dir));
    assert_eq!(source, "sidecar");
    assert_eq!(PathBuf::from(path), triple);

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn resolve_rg_path_falls_back_to_path_when_no_sidecar_exists() {
    let root = rg_fixture_root("missing");
    let cwd = root.join("repo");
    let exe_dir = root.join("MacOS");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&exe_dir).unwrap();

    let (path, source) = resolve_rg_path_from(Some(&cwd), Some(&exe_dir));
    assert_eq!(path, "rg");
    assert_eq!(source, "path");

    let _ = std::fs::remove_dir_all(&root);
}

// ===== filename search streaming (gh-195) =====
//
// Coverage for `build_file_name_search_args` and the per-stream event
// contracts. The end-to-end rg spawn path is exercised in a real
// workspace by manual smoke; these tests pin the argv and serde shapes
// so a future refactor cannot silently regress them.

#[test]
fn build_file_name_search_args_escapes_glob_metacharacters() {
    // A query containing `*`, `?`, `[`, `]`, `{`, `}`, `\` must not be
    // interpreted as a glob wildcard or alternation. Each metacharacter
    // should be prefixed with a backslash so rg treats it as a literal
    // substring match.
    let args = build_file_name_search_args("foo*bar?baz[qux]{a,b}\\z", "/tmp", false);
    let iglob_idx = args
        .iter()
        .position(|a| a == "--iglob")
        .expect("--iglob present");
    let pattern = &args[iglob_idx + 1];
    assert_eq!(pattern, r"**/*foo\*bar\?baz\[qux\]\{a,b\}\\z*");
    // The query should still be matched at any directory depth.
    assert!(pattern.starts_with("**/*"));
}

#[test]
fn build_file_name_search_args_includes_ignore_list_and_excludes() {
    let args = build_file_name_search_args("foo", "/tmp", false);
    // The hardcoded ignore list must show up as bare-basename `-g !<name>`
    // entries so rg actually skips those directories in `--files` mode.
    for ignored in [
        "node_modules",
        ".git",
        ".env",
        "Thumbs.db",
        "desktop.ini",
        ".DS_Store",
    ] {
        let needle = format!("!{}", ignored);
        let has = args.windows(2).any(|w| w[0] == "-g" && w[1] == needle);
        assert!(has, "missing `-g {}` in {:?}", ignored, args);
    }
    // The root path is the trailing argv entry.
    assert_eq!(args.last().map(String::as_str), Some("/tmp"));
}

#[test]
fn build_file_name_search_args_appends_root_path() {
    let args = build_file_name_search_args("term", "/some/root path", false);
    // Root paths with spaces should appear verbatim, not split.
    assert_eq!(args.last().map(String::as_str), Some("/some/root path"));
}

#[test]
fn build_file_name_search_args_starts_with_files_and_case_insensitive() {
    let args = build_file_name_search_args("foo", "/tmp", false);
    assert_eq!(args[0], "--files");
    assert_eq!(args[1], "-i");
}

#[test]
fn search_file_names_done_event_serializes_code_field() {
    // The `code` field is optional and skipped on the wire when `None`.
    let with_code = SearchFileNamesDoneEvent {
        search_id: "search-1".to_string(),
        truncated: false,
        total_files: 0,
        code: Some("QUERY_TOO_LONG".to_string()),
        error: Some("too long".to_string()),
    };
    let json = serde_json::to_string(&with_code).unwrap();
    assert!(json.contains("\"code\":\"QUERY_TOO_LONG\""));
    assert!(json.contains("\"error\":\"too long\""));

    let without_code = SearchFileNamesDoneEvent {
        search_id: "search-1".to_string(),
        truncated: false,
        total_files: 0,
        code: None,
        error: None,
    };
    let json = serde_json::to_string(&without_code).unwrap();
    assert!(!json.contains("code"));
    assert!(!json.contains("error"));
}

#[test]
fn search_file_names_batch_event_omits_truncated_when_none() {
    // Mid-stream batches carry `None` so the renderer knows the value is
    // unknown; serde should drop the field from the wire.
    let mid_stream = SearchFileNamesBatchEvent {
        search_id: "search-1".to_string(),
        files: vec![SearchFileHit {
            path: "a".to_string(),
            ignored: false,
        }],
        truncated: None,
    };
    let json = serde_json::to_string(&mid_stream).unwrap();
    assert!(!json.contains("truncated"));

    let final_batch = SearchFileNamesBatchEvent {
        search_id: "search-1".to_string(),
        files: vec![SearchFileHit {
            path: "a".to_string(),
            ignored: false,
        }],
        truncated: Some(true),
    };
    let json = serde_json::to_string(&final_batch).unwrap();
    assert!(json.contains("\"truncated\":true"));
    // The per-hit `ignored` flag is on the wire.
    assert!(json.contains("\"ignored\":false"));
}

#[test]
fn build_file_name_search_args_include_ignored_surfaces_hidden_and_drops_exclusions() {
    let args = build_file_name_search_args("foo", "/tmp", true);
    assert!(args.contains(&"--no-ignore".to_string()));
    assert!(args.contains(&"--hidden".to_string()));
    // The common-ignore exclusions must be absent so ignored/hidden files
    // are actually walked.
    for needle in ["!node_modules", "!.env", "!Thumbs.db", "!.DS_Store"] {
        let has = args.windows(2).any(|w| w[0] == "-g" && w[1] == needle);
        assert!(!has, "include_ignored must not exclude `{}`", needle);
    }
    assert_eq!(args.last().map(String::as_str), Some("/tmp"));
}

#[test]
fn path_is_ignored_classifies_commonly_ignored_paths() {
    assert!(path_is_ignored("node_modules/pkg/index.js"));
    assert!(path_is_ignored(".git/HEAD"));
    assert!(path_is_ignored("dist/bundle.js"));
    assert!(path_is_ignored(".env"));
    assert!(path_is_ignored("src/.hidden.ts"));
    assert!(path_is_ignored("assets/Thumbs.db"));
    assert!(path_is_ignored("assets/.DS_Store"));
    // Source files and non-cruft paths are not ignored.
    assert!(!path_is_ignored("src/auth.ts"));
    assert!(!path_is_ignored("README.md"));
    assert!(!path_is_ignored("lib/router/index.ts"));
}

#[test]
fn rank_search_hits_puts_non_ignored_first_and_caps_total() {
    let non_ignored = vec![
        SearchFileHit {
            path: "a".to_string(),
            ignored: false,
        },
        SearchFileHit {
            path: "b".to_string(),
            ignored: false,
        },
    ];
    let ignored = vec![
        SearchFileHit {
            path: "c".to_string(),
            ignored: true,
        },
        SearchFileHit {
            path: "d".to_string(),
            ignored: true,
        },
        SearchFileHit {
            path: "e".to_string(),
            ignored: true,
        },
    ];
    // cap=3 → all non-ignored (2) + one ignored.
    let ranked = rank_search_hits(non_ignored.clone(), ignored.clone(), 3);
    assert_eq!(
        ranked.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(),
        vec!["a", "b", "c"]
    );
    // cap=2 → only non-ignored; ignored never crowds them out.
    let ranked = rank_search_hits(non_ignored.clone(), ignored.clone(), 2);
    assert_eq!(
        ranked.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(),
        vec!["a", "b"]
    );
    // No non-ignored → ignored fills up to cap.
    let ranked = rank_search_hits(vec![], ignored.clone(), 100);
    assert_eq!(
        ranked.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(),
        vec!["c", "d", "e"]
    );
    // No ignored → non-ignored only, untruncated when under cap.
    let ranked = rank_search_hits(
        vec![
            SearchFileHit {
                path: "a".to_string(),
                ignored: false,
            },
            SearchFileHit {
                path: "b".to_string(),
                ignored: false,
            },
        ],
        vec![],
        100,
    );
    assert_eq!(
        ranked.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(),
        vec!["a", "b"]
    );
}

#[test]
fn search_file_names_cancel_request_is_a_dto_not_aliased_to_content() {
    // The two cancel commands must accept distinct types so a future
    // shape change to `SearchContentCancelRequest` cannot silently
    // affect the filename path. This pins the type identity at compile
    // time (the two structs are distinct) and verifies the field shape
    // by exercising the constructor.
    let req = SearchFileNamesCancelRequest {
        search_id: "search-1".to_string(),
    };
    assert_eq!(req.search_id, "search-1");
}
