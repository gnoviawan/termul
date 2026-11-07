use std::collections::HashMap;

use super::*;

fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    move |name| map.get(name).cloned()
}

fn found(name: &str, value: &str) -> Option<EnvValue> {
    Some(EnvValue {
        name: name.to_owned(),
        value: value.to_owned(),
    })
}

#[test]
fn new_name_only() {
    let mut notices = Notices::default();
    let read = env(&[("TROUPE_WEB_AUTH_TOKEN", "abc")]);
    assert_eq!(
        lookup_noting("WEB_AUTH_TOKEN", read, &mut notices),
        found("TROUPE_WEB_AUTH_TOKEN", "abc")
    );
    assert_eq!(notices.take_pending(), Vec::<String>::new());
}

#[test]
fn old_name_only_queues_one_line_per_variable() {
    let mut notices = Notices::default();
    let read = env(&[("TERMUL_PROJECTS_FILE", "/srv/projects.json")]);
    assert_eq!(
        lookup_noting("PROJECTS_FILE", &read, &mut notices),
        found("TERMUL_PROJECTS_FILE", "/srv/projects.json")
    );
    assert_eq!(
        lookup_noting("PROJECTS_FILE", &read, &mut notices),
        found("TERMUL_PROJECTS_FILE", "/srv/projects.json")
    );
    assert_eq!(
        notices.take_pending(),
        vec![
            "TERMUL_PROJECTS_FILE is deprecated; rename it to TROUPE_PROJECTS_FILE \
             (TERMUL_PROJECTS_FILE still works for now)"
                .to_owned()
        ]
    );
    let _ = lookup_noting("PROJECTS_FILE", &read, &mut notices);
    assert_eq!(notices.take_pending(), Vec::<String>::new());
}

#[test]
fn both_names_new_wins_without_a_notice() {
    let mut notices = Notices::default();
    let read = env(&[
        ("TROUPE_SESSIONS_DIR", "/new"),
        ("TERMUL_SESSIONS_DIR", "/old"),
    ]);
    assert_eq!(
        lookup_noting("SESSIONS_DIR", read, &mut notices),
        found("TROUPE_SESSIONS_DIR", "/new")
    );
    assert_eq!(notices.take_pending(), Vec::<String>::new());
}

#[test]
fn neither_name() {
    let mut notices = Notices::default();
    let read = env(&[("TROUPE_OTHER", "1"), ("TERMUL_OTHER", "1")]);
    assert_eq!(lookup_noting("SESSIONS_DIR", read, &mut notices), None);
    assert_eq!(notices.take_pending(), Vec::<String>::new());
}

#[test]
fn blank_new_name_does_not_hide_the_old_one() {
    let read = env(&[
        ("TROUPE_ALLOWED_ORIGINS", " "),
        ("TERMUL_ALLOWED_ORIGINS", "https://a.example"),
    ]);
    assert_eq!(
        lookup("ALLOWED_ORIGINS", read),
        found("TERMUL_ALLOWED_ORIGINS", "https://a.example")
    );
    let read = env(&[("TROUPE_ALLOWED_ORIGINS", "")]);
    assert_eq!(
        lookup("ALLOWED_ORIGINS", read),
        found("TROUPE_ALLOWED_ORIGINS", "")
    );
    let mut notices = Notices::default();
    let read = env(&[("TROUPE_ALLOWED_ORIGINS", ""), ("TERMUL_ALLOWED_ORIGINS", " ")]);
    assert_eq!(
        lookup_noting("ALLOWED_ORIGINS", read, &mut notices),
        found("TROUPE_ALLOWED_ORIGINS", "")
    );
    assert_eq!(notices.take_pending(), Vec::<String>::new());
}

#[test]
fn names_for_child_processes() {
    assert_eq!(
        names("SERVER"),
        ["TROUPE_SERVER".to_owned(), "TERMUL_SERVER".to_owned()]
    );
}
