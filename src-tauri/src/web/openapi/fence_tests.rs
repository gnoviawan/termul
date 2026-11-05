//! Drift fence: every route the HTTP router registers has a row in
//! [`ROUTES`], and every row is registered. Reads the router sources, starting
//! at `router()` in `web/router/mod.rs` and following each `.merge(..)` into
//! the sub-router. The scan fails closed: router text it cannot resolve panics
//! instead of dropping routes from both sides of the comparison.

use std::collections::BTreeSet;
use std::path::PathBuf;

use super::{HttpMethod, ROUTES};

const ROUTES_FILE: &str = "src-tauri/src/web/openapi/routes.rs";

/// Method-router constructors and chained calls that add one method.
const METHODS: &[(&str, HttpMethod)] = &[
    ("get", HttpMethod::Get),
    ("post", HttpMethod::Post),
    ("put", HttpMethod::Put),
    ("delete", HttpMethod::Delete),
];

/// The other `axum::routing` method-router constructors. Each needs a
/// `HttpMethod` mapping before the scan can read it.
const AXUM_CONSTRUCTORS: &[&str] = &["any", "connect", "head", "on", "options", "patch", "trace"];

/// Chained `MethodRouter` calls that add no method.
const MODIFIERS: &[&str] = &["layer", "route_layer", "with_state"];

/// Routes registered with `any(..)`, and the methods their handler serves.
/// The canvas bundle handler answers `GET` (and `HEAD`) only.
const ANY_ROUTES: &[(&str, HttpMethod)] = &[("/canvas/{id}/{*rest}", HttpMethod::Get)];

/// Router calls that register routes the scan cannot follow.
const UNSUPPORTED_ROUTER_CALLS: &[&str] = &[".nest(", ".route_service(", ".nest_service("];

struct Module {
    file: String,
    source: String,
}

fn web_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/web")
}

/// The web module at `module` (`git_api`, `router/host_routes`), comments
/// stripped.
fn read_module(module: &str, referenced_from: &str) -> Module {
    let dir = web_dir();
    [format!("{module}.rs"), format!("{module}/mod.rs")]
        .into_iter()
        .find_map(|relative| {
            let source = std::fs::read_to_string(dir.join(&relative)).ok()?;
            Some(Module {
                file: format!("src-tauri/src/web/{relative}"),
                source: strip_comments(&source),
            })
        })
        .unwrap_or_else(|| {
            panic!(
                "drift fence: cannot resolve {referenced_from}: `{module}` is not a module under \
                 src-tauri/src/web. Teach src-tauri/src/web/openapi/fence_tests.rs this form."
            )
        })
}

/// `source` without `//` and `/* */` comments, so commented-out or
/// explanatory router text is not mistaken for a registration. String and
/// char literals are kept intact.
fn strip_comments(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut index = 0;
    let mut kept_from = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                out.push_str(&source[kept_from..index]);
                index += source[index..].find('\n').unwrap_or(source.len() - index);
                kept_from = index;
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                out.push_str(&source[kept_from..index]);
                let close = source[index + 2..]
                    .find("*/")
                    .expect("block comment closes");
                index += close + 4;
                out.push(' ');
                kept_from = index;
            }
            b'"' => index = string_end(source, index),
            b'r' if raw_string_start(source, index) => index = raw_string_end(source, index),
            b'\'' => index = char_literal_end(source, index),
            _ => index += 1,
        }
    }
    out.push_str(&source[kept_from..]);
    out
}

/// The index just past the `"..."` literal opening at `open`.
fn string_end(source: &str, open: usize) -> usize {
    let bytes = source.as_bytes();
    let mut index = open + 1;
    while bytes[index] != b'"' {
        index += if bytes[index] == b'\\' { 2 } else { 1 };
    }
    index + 1
}

fn raw_string_start(source: &str, index: usize) -> bool {
    let after_ident = index > 0 && {
        let previous = source.as_bytes()[index - 1];
        (previous.is_ascii_alphanumeric() || previous == b'_') && previous != b'b'
    };
    !after_ident && source[index + 1..].trim_start_matches('#').starts_with('"')
}

/// The index just past the `r#"..."#` literal opening at `open`.
fn raw_string_end(source: &str, open: usize) -> usize {
    let hashes = source[open + 1..].len() - source[open + 1..].trim_start_matches('#').len();
    let body = open + 2 + hashes;
    let terminator = format!("\"{}", "#".repeat(hashes));
    body + source[body..].find(&terminator).expect("raw string closes") + terminator.len()
}

/// The index just past a char literal at `open`, or past the `'` of a
/// lifetime.
fn char_literal_end(source: &str, open: usize) -> usize {
    let rest = &source[open + 1..];
    if let Some(escaped) = rest.strip_prefix('\\') {
        return open + 1 + escaped.find('\'').expect("char literal closes") + 2;
    }
    let mut chars = rest.char_indices();
    match (chars.next(), chars.next()) {
        (Some(_), Some((at, '\''))) => open + 1 + at + 1,
        _ => open + 1,
    }
}

/// The text between the parenthesis at `open` and its matching close.
fn balanced(source: &str, open: usize) -> &str {
    let mut depth = 0usize;
    let mut in_string = false;
    let bytes = source.as_bytes();
    for (index, &byte) in bytes.iter().enumerate().skip(open) {
        match byte {
            b'"' if index == 0 || bytes[index - 1] != b'\\' => in_string = !in_string,
            b'(' | b'{' if !in_string => depth += 1,
            b')' | b'}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return &source[open + 1..index];
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced source after byte {open}");
}

/// The body of `fn <name>` in `module`.
fn fn_body<'a>(module: &'a Module, name: &str) -> &'a str {
    let source = &module.source;
    let start = source
        .find(&format!("fn {name}("))
        .or_else(|| source.find(&format!("fn {name}<")))
        .unwrap_or_else(|| panic!("drift fence: fn `{name}` not found in {}", module.file));
    let open = start + source[start..].find('{').expect("fn has a body");
    balanced(source, open)
}

/// `"literal"` or a `const IDENT: &str = "literal";` declared in `module`.
fn resolve_path(argument: &str, module: &Module) -> String {
    let argument = argument.trim();
    if let Some(literal) = argument.strip_prefix('"') {
        return literal.trim_end_matches('"').to_string();
    }
    let source = &module.source;
    let declaration = format!("const {argument}: &str = \"");
    let start = source.find(&declaration).unwrap_or_else(|| {
        panic!(
            "drift fence: route path `{argument}` in {} is neither a literal nor a &str const",
            module.file
        )
    }) + declaration.len();
    source[start..start + source[start..].find('"').expect("const literal ends")].to_string()
}

/// Splits `a, b(c, d)` at the first top-level comma.
fn split_first_argument(arguments: &str) -> (&str, &str) {
    let mut depth = 0usize;
    for (index, byte) in arguments.bytes().enumerate() {
        match byte {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b',' if depth == 0 => return (&arguments[..index], &arguments[index + 1..]),
            _ => {}
        }
    }
    panic!("`.route({arguments})` has no method router");
}

/// A call chain `a::b(x).c(y)` as `[("a::b", "x"), ("c", "y")]`, or `None`
/// when `expression` is not one.
fn call_chain(expression: &str) -> Option<Vec<(&str, &str)>> {
    let mut calls = Vec::new();
    let mut rest = expression.trim();
    loop {
        let open = rest.find('(')?;
        let callee = rest[..open].trim();
        let is_path = !callee.is_empty()
            && callee
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == ':');
        if !is_path {
            return None;
        }
        let arguments = balanced(rest, open);
        calls.push((callee, arguments));
        rest = rest[open + 1 + arguments.len() + 1..].trim_start();
        if rest.is_empty() {
            return Some(calls);
        }
        rest = rest.strip_prefix('.')?.trim_start();
    }
}

/// The module and fn a call path such as `crate::web::git_api::stage` or
/// `log_api::route` names, relative to the web module `current`.
fn resolve_fn(callee: &str, current: &str) -> (String, String) {
    let path = callee.strip_prefix("crate::web::").unwrap_or(callee);
    match path.rsplit_once("::") {
        Some((module, name)) => (module.replace("::", "/"), name.to_string()),
        None => (current.to_string(), path.to_string()),
    }
}

fn method_named(name: &str) -> Option<HttpMethod> {
    METHODS
        .iter()
        .find(|(call, _)| *call == name)
        .map(|(_, method)| *method)
}

/// The methods `expression` (a `.route(path, expression)` method router, or
/// the body of a helper that returns one) registers for `path`.
fn method_router_methods(
    expression: &str,
    path: &str,
    module: &str,
    file: &str,
) -> BTreeSet<HttpMethod> {
    let unresolved = |why: &str| -> ! {
        panic!(
            "drift fence: cannot resolve the methods of route `{path}` in {file}: {why}\n  \
             text: `{}`\nTeach src-tauri/src/web/openapi/fence_tests.rs this form.",
            expression.trim()
        )
    };
    let calls = call_chain(expression).unwrap_or_else(|| unresolved("not a call chain"));
    let mut methods = BTreeSet::new();
    for (position, (callee, _)) in calls.iter().enumerate() {
        let name = callee.rsplit("::").next().unwrap_or(callee);
        if let Some(method) = method_named(name) {
            methods.insert(method);
            continue;
        }
        if position > 0 {
            if !MODIFIERS.contains(&name) {
                unresolved(&format!("unrecognized method-router call `.{name}(`"));
            }
            continue;
        }
        if name == "any" {
            let (_, method) = ANY_ROUTES
                .iter()
                .find(|(any_path, _)| *any_path == path)
                .unwrap_or_else(|| unresolved("`any(..)` on a path missing from ANY_ROUTES"));
            methods.insert(*method);
        } else if AXUM_CONSTRUCTORS.contains(&name) || name.ends_with("_service") {
            unresolved(&format!("unrecognized method-router constructor `{name}(`"));
        } else {
            let (helper_module, helper) = resolve_fn(callee, module);
            let source = read_module(&helper_module, &format!("`{callee}` in {file}"));
            let body = fn_body(&source, &helper);
            if body.contains(';') {
                unresolved(&format!(
                    "helper `{callee}` is not a single method-router expression"
                ));
            }
            methods.extend(method_router_methods(
                body,
                path,
                &helper_module,
                &source.file,
            ));
        }
    }
    if methods.is_empty() {
        unresolved("no HTTP method found");
    }
    methods
}

/// Every `(method, path)` registered inside `fn <name>` of web module
/// `module`, merged sub-routers included.
fn registered_in(
    module: &str,
    name: &str,
    referenced_from: &str,
    routes: &mut BTreeSet<(HttpMethod, String)>,
) {
    let source = read_module(module, referenced_from);
    let body = fn_body(&source, name);
    let body_start = body.as_ptr() as usize - source.source.as_ptr() as usize;
    for (index, _) in body.match_indices(".route(") {
        let open = body_start + index + ".route".len();
        let (path, method_router) = split_first_argument(balanced(&source.source, open));
        let path = resolve_path(path, &source);
        let method_router = method_router.trim().trim_end_matches(',');
        let methods = method_router_methods(method_router, &path, module, &source.file);
        routes.extend(methods.into_iter().map(|method| (method, path.clone())));
    }
    for call in UNSUPPORTED_ROUTER_CALLS {
        if let Some(index) = body.find(call) {
            let arguments = balanced(&source.source, body_start + index + call.len() - 1);
            panic!(
                "drift fence: `{call}{arguments})` in fn {name} of {} registers routes the scan \
                 cannot follow. Teach src-tauri/src/web/openapi/fence_tests.rs this form.",
                source.file
            );
        }
    }
    for (index, _) in body.match_indices(".merge(") {
        let arguments = balanced(&source.source, body_start + index + ".merge".len());
        let target = call_chain(arguments)
            .filter(|calls| calls.len() == 1)
            .map(|calls| resolve_fn(calls[0].0, module));
        let Some((sub_module, sub_fn)) = target else {
            panic!(
                "drift fence: cannot resolve `.merge({})` in fn {name} of {}. Merge a call to a \
                 web-module router fn, or teach src-tauri/src/web/openapi/fence_tests.rs this form.",
                arguments.trim(),
                source.file
            );
        };
        let merge = format!(
            "`.merge({})` in fn {name} of {}",
            arguments.trim(),
            source.file
        );
        registered_in(&sub_module, &sub_fn, &merge, routes);
    }
}

fn registered_routes() -> BTreeSet<(HttpMethod, String)> {
    let mut routes = BTreeSet::new();
    registered_in("router", "router", "the router entry point", &mut routes);
    routes
}

fn describe(routes: &BTreeSet<&(HttpMethod, String)>) -> String {
    routes
        .iter()
        .map(|(method, path)| format!("  {} {path}", method.as_str().to_uppercase()))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn every_registered_route_has_a_routes_row_and_every_row_is_registered() {
    let registered = registered_routes();
    assert!(
        registered.len() > 100,
        "the router scan must find the whole table, found {}",
        registered.len()
    );
    let documented: BTreeSet<(HttpMethod, String)> = ROUTES
        .iter()
        .map(|route| (route.method, route.path.to_string()))
        .collect();

    let undocumented: BTreeSet<_> = registered.difference(&documented).collect();
    assert!(
        undocumented.is_empty(),
        "These routes are registered but missing from the OpenAPI spec. Add a row for each \
         to `ROUTES` in {ROUTES_FILE}:\n{}",
        describe(&undocumented)
    );
    let unregistered: BTreeSet<_> = documented.difference(&registered).collect();
    assert!(
        unregistered.is_empty(),
        "These `ROUTES` rows in {ROUTES_FILE} have no registered route. Fix the method or \
         path, or delete the row:\n{}",
        describe(&unregistered)
    );
}

#[test]
fn the_router_scan_reads_methods_from_chained_calls_and_helpers() {
    let routes = registered_routes();
    for expected in [
        (HttpMethod::Get, "/projects"),
        (HttpMethod::Post, "/projects"),
        (HttpMethod::Delete, "/projects/{projectId}"),
        (HttpMethod::Post, "/host/agent-idle-window"),
        (HttpMethod::Post, "/log/frontend-error"),
        (HttpMethod::Post, "/mcp-catalog/install/plan"),
        (HttpMethod::Delete, "/api/automation-secrets"),
        (HttpMethod::Post, "/host/browser-policy/project"),
        (HttpMethod::Post, "/canvas/crashed"),
        (HttpMethod::Get, "/canvas/{id}/{*rest}"),
        (HttpMethod::Get, "/server/config"),
    ] {
        assert!(
            routes.contains(&(expected.0, expected.1.to_string())),
            "scan missed {} {}",
            expected.0.as_str(),
            expected.1
        );
    }
    assert!(
        !routes.contains(&(HttpMethod::Get, "/log/frontend-error".to_string())),
        "a helper's single method must not widen to others"
    );
}

#[test]
#[should_panic(expected = "unrecognized method-router call `.patch(`")]
fn the_router_scan_refuses_a_chained_method_it_cannot_map() {
    method_router_methods("get(a).patch(b)", "/probe", "router", "probe.rs");
}

#[test]
#[should_panic(expected = "unrecognized method-router constructor `on(`")]
fn the_router_scan_refuses_an_unmapped_constructor() {
    method_router_methods("on(MethodFilter::GET, a)", "/probe", "router", "probe.rs");
}

#[test]
fn comment_stripping_keeps_literals_and_drops_trailing_and_block_comments() {
    let source = "let url = \"http://x\"; // .route(\"/a\")\nlet c = '\"'; /* .merge(m::f()) */ let r = r#\"//\"#;";
    assert_eq!(
        strip_comments(source),
        "let url = \"http://x\"; \nlet c = '\"';   let r = r#\"//\"#;"
    );
}
