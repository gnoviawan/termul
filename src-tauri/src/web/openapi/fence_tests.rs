//! Drift fence: every route the HTTP router registers has a row in
//! [`ROUTES`], and every row is registered. Reads the router sources, starting
//! at `router()` in `web/router/mod.rs` and following each
//! `.merge(crate::web::<module>::<fn>(..))` into the sub-router.

use std::collections::BTreeSet;
use std::path::PathBuf;

use super::{HttpMethod, ROUTES};

const ROUTES_FILE: &str = "src-tauri/src/web/openapi/routes.rs";

fn web_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/web")
}

fn read_module(module: &str) -> String {
    let dir = web_dir();
    let candidates = [
        dir.join(format!("{module}.rs")),
        dir.join(module).join("mod.rs"),
    ];
    candidates
        .iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_else(|| panic!("no source file for web module `{module}`"))
}

/// The source without `//` line comments, so commented-out or explanatory
/// `.route(` text is not mistaken for a registration.
fn strip_line_comments(source: &str) -> String {
    source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
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

/// The body of `fn <name>` in `source`.
fn fn_body<'a>(source: &'a str, name: &str) -> &'a str {
    let start = source
        .find(&format!("fn {name}("))
        .or_else(|| source.find(&format!("fn {name}<")))
        .unwrap_or_else(|| panic!("fn {name} not found"));
    let open = start + source[start..].find('{').expect("fn has a body");
    balanced(source, open)
}

/// `"literal"` or a `const IDENT: &str = "literal";` declared in `source`.
fn resolve_path(argument: &str, source: &str) -> String {
    let argument = argument.trim();
    if let Some(literal) = argument.strip_prefix('"') {
        return literal.trim_end_matches('"').to_string();
    }
    let declaration = format!("const {argument}: &str = \"");
    let start = source
        .find(&declaration)
        .unwrap_or_else(|| panic!("route path `{argument}` is neither a literal nor a &str const"))
        + declaration.len();
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

/// The axum method-router constructors (`get(`, `.post(`, ...) in `text`.
/// `any(` is the canvas bundle catch-all, whose handler serves `GET` (and
/// `HEAD`) only.
fn method_calls(text: &str) -> BTreeSet<HttpMethod> {
    const CALLS: &[(&str, HttpMethod)] = &[
        ("get(", HttpMethod::Get),
        ("post(", HttpMethod::Post),
        ("put(", HttpMethod::Put),
        ("delete(", HttpMethod::Delete),
        ("any(", HttpMethod::Get),
    ];
    let mut methods = BTreeSet::new();
    for (call, method) in CALLS {
        for (index, _) in text.match_indices(call) {
            let preceded_by_ident = text[..index]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == ':');
            if !preceded_by_ident {
                methods.insert(*method);
            }
        }
    }
    methods
}

/// Methods of a route registered through a helper such as
/// `log_api::route()`: the method calls inside that helper's body.
fn helper_methods(expression: &str) -> BTreeSet<HttpMethod> {
    let call = expression.trim();
    let (module, rest) = call
        .split_once("::")
        .unwrap_or_else(|| panic!("cannot resolve the methods of `{call}`"));
    let name = &rest[..rest.find('(').expect("helper is a call")];
    method_calls(fn_body(&read_module(module), name))
}

/// Every `(method, path)` registered inside `fn <name>` of web module
/// `module`, merged sub-routers included.
fn registered_in(module: &str, name: &str, routes: &mut BTreeSet<(HttpMethod, String)>) {
    let source = strip_line_comments(&read_module(module));
    let body = fn_body(&source, name);
    let body_start = body.as_ptr() as usize - source.as_ptr() as usize;
    for (index, _) in body.match_indices(".route(") {
        let open = body_start + index + ".route".len();
        let (path, method_router) = split_first_argument(balanced(&source, open));
        let path = resolve_path(path, &source);
        let mut methods = method_calls(method_router);
        if methods.is_empty() {
            methods = helper_methods(method_router);
        }
        assert!(!methods.is_empty(), "no HTTP method found for route {path}");
        routes.extend(methods.into_iter().map(|method| (method, path.clone())));
    }
    for (index, _) in body.match_indices(".merge(crate::web::") {
        let target = &body[index + ".merge(crate::web::".len()..];
        let target = &target[..target.find('(').expect("merge target is a call")];
        let (sub_module, sub_fn) = target.split_once("::").expect("module::fn merge target");
        registered_in(sub_module, sub_fn, routes);
    }
}

fn registered_routes() -> BTreeSet<(HttpMethod, String)> {
    let mut routes = BTreeSet::new();
    registered_in("router", "router", &mut routes);
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
