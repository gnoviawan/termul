use super::*;

#[test]
fn run_id_is_stable_and_short() {
    let a = run_id();
    let b = run_id();
    assert_eq!(a, b, "run id must be stable within a process");
    assert_eq!(a.len(), 8, "run id is the 8-char short form");
}

#[test]
fn bare_level_sets_global_no_module_overrides() {
    let d = parse_directives("trace");
    assert_eq!(d.global, LevelFilter::Trace);
    assert!(d.per_module.is_empty());

    let d = parse_directives("warn");
    assert_eq!(d.global, LevelFilter::Warn);
}

#[test]
fn off_genuinely_disables_logging() {
    let d = parse_directives("off");
    assert_eq!(d.global, LevelFilter::Off);
    assert!(d.per_module.is_empty());
}

#[test]
fn module_scoped_directive_keeps_global_at_floor() {
    // `termul_manager=debug` must NOT raise other crates: global stays at
    // the floor, the module gets its own override.
    let d = parse_directives("termul_manager=debug");
    assert_eq!(d.global, default_floor());
    assert_eq!(
        d.per_module,
        vec![("termul_manager".to_string(), LevelFilter::Debug)]
    );
}

#[test]
fn multiple_modules_are_scoped_independently() {
    let d = parse_directives("hyper=warn,termul_manager=trace");
    assert_eq!(d.global, default_floor());
    assert_eq!(
        d.per_module,
        vec![
            ("hyper".to_string(), LevelFilter::Warn),
            ("termul_manager".to_string(), LevelFilter::Trace),
        ]
    );
}

#[test]
fn bare_module_name_without_level_is_ignored() {
    // A bare module name (no level) must not silently widen verbosity.
    let d = parse_directives("some_module");
    assert_eq!(d.global, default_floor());
    assert!(d.per_module.is_empty());
}

#[test]
fn global_level_and_module_override_combine() {
    let d = parse_directives("info,termul_manager=trace");
    assert_eq!(d.global, LevelFilter::Info);
    assert_eq!(
        d.per_module,
        vec![("termul_manager".to_string(), LevelFilter::Trace)]
    );
}

#[test]
fn unrecognized_level_tokens_are_ignored() {
    let d = parse_directives("bogus,termul_manager=nonsense");
    assert_eq!(d.global, default_floor());
    assert!(d.per_module.is_empty());
}

#[test]
fn build_channel_matches_compilation_profile() {
    let expected = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    assert_eq!(build_channel(), expected);
}
