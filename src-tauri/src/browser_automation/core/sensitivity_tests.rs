use serde_json::json;

use super::*;

const PAGE: &str = "https://shop.example/login";

fn scene(tainted: bool) -> Scene<'static> {
    Scene {
        tab_url: PAGE,
        tainted,
        facts_trusted: true,
        trusted_origin: false,
    }
}

fn password_form() -> SensitivityFacts {
    SensitivityFacts {
        frame_origin: Some("https://shop.example".into()),
        target_in_form: true,
        region_has_password: true,
        is_submitter: true,
        form_action: Some("https://shop.example/session".into()),
        ..SensitivityFacts::default()
    }
}

/// `(class, origin, pinned)` per classified item, for literal comparison.
fn summary(items: &[Sensitive]) -> Vec<(ActionClass, Option<&str>, bool)> {
    items
        .iter()
        .map(|s| {
            (
                s.class,
                s.origin.as_ref().map(CanonicalOrigin::as_str),
                s.pinned,
            )
        })
        .collect()
}

#[test]
fn submitting_a_password_form_by_click_or_enter_is_a_password_submit() {
    let facts = password_form();
    let expected = vec![(
        ActionClass::PasswordSubmit,
        Some("https://shop.example"),
        false,
    )];
    assert_eq!(
        summary(&classify(Gesture::Click, &facts, &scene(false))),
        expected
    );
    assert_eq!(
        summary(&classify(Gesture::Key("Enter"), &facts, &scene(false))),
        expected
    );
    assert_eq!(
        summary(&classify(Gesture::Type("hunter2\n"), &facts, &scene(false))),
        expected
    );
}

#[test]
fn typing_into_a_credential_field_without_submitting_it_is_not_sensitive() {
    let field = SensitivityFacts {
        is_submitter: false,
        is_text_entry: true,
        ..password_form()
    };
    assert!(classify(Gesture::Click, &field, &scene(false)).is_empty());
    assert!(classify(Gesture::Fill, &field, &scene(false)).is_empty());
    assert!(classify(Gesture::Type("hunter 2"), &field, &scene(false)).is_empty());
    assert!(classify(Gesture::Key("Tab"), &field, &scene(false)).is_empty());
    assert!(classify(Gesture::Key("Space"), &field, &scene(false)).is_empty());
}

const PASSWORD_SUBMIT: (ActionClass, Option<&str>, bool) = (
    ActionClass::PasswordSubmit,
    Some("https://shop.example"),
    false,
);

#[test]
fn every_way_of_activating_a_control_in_a_password_form_is_a_password_submit() {
    let submit = password_form();
    let control = SensitivityFacts {
        is_submitter: false,
        ..password_form()
    };
    for (gesture, facts, what) in [
        (Gesture::Click, &submit, "check on a submit styled as a switch"),
        (Gesture::Click, &control, "a button whose script submits the form"),
        (Gesture::Key("Space"), &submit, "Space on a focused submit"),
        (Gesture::Key(" "), &submit, "a space key on a focused submit"),
        (Gesture::Type(" "), &submit, "typing a space onto a focused submit"),
        (Gesture::Select, &control, "a select the page submits on change"),
        (Gesture::Fill, &control, "fill on a select"),
    ] {
        assert_eq!(
            summary(&classify(gesture, facts, &scene(false))),
            vec![PASSWORD_SUBMIT],
            "{what}"
        );
    }
}

#[test]
fn a_formless_login_is_a_password_submit() {
    let spa = SensitivityFacts {
        frame_origin: Some("https://shop.example".into()),
        region_has_password: true,
        ..SensitivityFacts::default()
    };
    for gesture in [Gesture::Click, Gesture::Key("Enter"), Gesture::Type("hunter2\n")] {
        assert_eq!(
            summary(&classify(gesture, &spa, &scene(false))),
            vec![PASSWORD_SUBMIT],
            "{gesture:?}"
        );
    }
    let field = SensitivityFacts {
        is_text_entry: true,
        ..spa
    };
    assert!(classify(Gesture::Fill, &field, &scene(false)).is_empty());
    assert!(classify(Gesture::Click, &field, &scene(false)).is_empty());
}

#[test]
fn enter_outside_a_credential_region_submits_nothing() {
    let field = SensitivityFacts {
        is_text_entry: true,
        ..SensitivityFacts::default()
    };
    assert!(classify(Gesture::Key("Enter"), &field, &scene(false)).is_empty());
    assert!(classify(Gesture::Click, &SensitivityFacts::default(), &scene(false)).is_empty());
}

#[test]
fn after_reading_a_page_enter_or_space_on_a_data_carrying_link_is_exfiltration() {
    let link = SensitivityFacts {
        link_target: Some("https://collect.example/x?d=secret".into()),
        ..SensitivityFacts::default()
    };
    for gesture in [Gesture::Key("Enter"), Gesture::Key("Space"), Gesture::Click] {
        assert_eq!(
            summary(&classify(gesture, &link, &scene(true))),
            vec![(
                ActionClass::TaintedExfil,
                Some("https://collect.example"),
                false
            )],
            "{gesture:?}"
        );
    }
    assert!(classify(Gesture::Key("Tab"), &link, &scene(true)).is_empty());
}

#[test]
fn a_card_form_submit_is_a_payment_submit() {
    let facts = SensitivityFacts {
        region_has_password: false,
        region_has_payment: true,
        ..password_form()
    };
    assert_eq!(
        summary(&classify(Gesture::Click, &facts, &scene(false))),
        vec![(
            ActionClass::PaymentSubmit,
            Some("https://shop.example"),
            false
        )]
    );
}

#[test]
fn after_reading_a_page_a_data_carrying_link_to_another_origin_is_exfiltration() {
    let link = |href: &str| SensitivityFacts {
        link_target: Some(href.into()),
        ..SensitivityFacts::default()
    };
    let away = link("https://collect.example/x?d=secret");
    let items = classify(Gesture::Click, &away, &scene(true));
    assert_eq!(
        summary(&items),
        vec![(
            ActionClass::TaintedExfil,
            Some("https://collect.example"),
            false
        )]
    );
    assert_eq!(items[0].target, "https://collect.example/x?d=secret");

    assert!(
        classify(Gesture::Click, &away, &scene(false)).is_empty(),
        "untainted"
    );
    let same = link("https://shop.example/search?q=shoes");
    assert!(
        classify(Gesture::Click, &same, &scene(true)).is_empty(),
        "same origin"
    );
    let bare = link("https://collect.example/about");
    assert!(
        classify(Gesture::Click, &bare, &scene(true)).is_empty(),
        "no data"
    );
    let fragment = link("https://collect.example/#d=secret");
    assert_eq!(
        classify(Gesture::Click, &fragment, &scene(true)).len(),
        1,
        "fragment data"
    );
}

#[test]
fn after_reading_a_page_a_data_carrying_navigation_to_another_origin_is_exfiltration() {
    let facts = SensitivityFacts::default();
    let to = |url: &str| url.parse::<Url>().unwrap();
    let away = to("https://collect.example/?d=secret");
    assert_eq!(
        summary(&classify(Gesture::Navigate(&away), &facts, &scene(true))),
        vec![(
            ActionClass::TaintedExfil,
            Some("https://collect.example"),
            false
        )]
    );
    assert!(classify(Gesture::Navigate(&away), &facts, &scene(false)).is_empty());
    let home = to("https://shop.example/?q=1");
    assert!(classify(Gesture::Navigate(&home), &facts, &scene(true)).is_empty());
    let plain = to("https://collect.example/");
    assert!(classify(Gesture::Navigate(&plain), &facts, &scene(true)).is_empty());

    let blank = Scene {
        tab_url: "about:blank",
        ..scene(true)
    };
    assert_eq!(
        classify(Gesture::Navigate(&home), &facts, &blank).len(),
        1,
        "a tab with no origin yet sends the data away from nothing it read from"
    );
}

#[test]
fn after_reading_a_page_a_submit_to_another_origin_is_exfiltration() {
    let facts = SensitivityFacts {
        region_has_password: false,
        form_action: Some("https://collect.example/post".into()),
        ..password_form()
    };
    assert_eq!(
        summary(&classify(Gesture::Click, &facts, &scene(true))),
        vec![(
            ActionClass::TaintedExfil,
            Some("https://collect.example"),
            false
        )]
    );
    let home = SensitivityFacts {
        form_action: Some("https://shop.example/post".into()),
        ..facts
    };
    assert!(classify(Gesture::Click, &home, &scene(true)).is_empty());
}

#[test]
fn an_upload_is_keyed_on_the_page_origin() {
    let facts = SensitivityFacts {
        frame_origin: Some("https://files.example".into()),
        is_file_input: true,
        ..SensitivityFacts::default()
    };
    let items = classify(Gesture::Upload, &facts, &scene(false));
    assert_eq!(
        summary(&items),
        vec![(ActionClass::Upload, Some("https://files.example"), false)]
    );
    assert_eq!(items[0].target, PAGE);
}

#[test]
fn a_page_with_no_http_origin_classifies_without_an_origin() {
    let facts = SensitivityFacts {
        frame_origin: Some("null".into()),
        ..password_form()
    };
    let blank = Scene {
        tab_url: "about:blank",
        ..scene(false)
    };
    assert_eq!(
        summary(&classify(Gesture::Click, &facts, &blank)),
        vec![(ActionClass::PasswordSubmit, None, false)]
    );
}

#[test]
fn a_helper_reply_of_any_other_shape_is_a_credential_submit() {
    let facts = SensitivityFacts::from_helper(&json!({ "targetInForm": "yes" }));
    assert_eq!(
        summary(&classify(Gesture::Click, &facts, &scene(false))),
        vec![
            (
                ActionClass::PasswordSubmit,
                Some("https://shop.example"),
                false
            ),
            (
                ActionClass::PaymentSubmit,
                Some("https://shop.example"),
                false
            ),
        ]
    );
    let parsed = SensitivityFacts::from_helper(&json!({ "isFileInput": true, "extra": 1 }));
    assert!(parsed.is_file_input && !parsed.target_in_form);
}

#[test]
fn page_controlled_facts_make_every_submit_shape_a_pinned_prompt_on_unvouched_origins() {
    let untrusted = Scene {
        facts_trusted: false,
        ..scene(false)
    };
    let nothing = SensitivityFacts::default();
    assert_eq!(
        summary(&classify(Gesture::Key("Enter"), &nothing, &untrusted)),
        vec![(
            ActionClass::PasswordSubmit,
            Some("https://shop.example"),
            true
        )]
    );
    let field = SensitivityFacts {
        target_in_form: true,
        ..SensitivityFacts::default()
    };
    assert_eq!(classify(Gesture::Fill, &field, &untrusted).len(), 1);
    assert!(classify(Gesture::Fill, &nothing, &untrusted).is_empty());

    let vouched = Scene {
        trusted_origin: true,
        ..untrusted
    };
    assert!(classify(Gesture::Key("Enter"), &nothing, &vouched).is_empty());

    let merged = classify(Gesture::Click, &password_form(), &untrusted);
    assert_eq!(
        summary(&merged),
        vec![(
            ActionClass::PasswordSubmit,
            Some("https://shop.example"),
            true
        )],
        "the pinned class folds into the observed one"
    );
}

/// Every fact combination, ordered so that a later value is the more
/// sensitive one.
fn all_facts() -> Vec<SensitivityFacts> {
    let actions = [
        Some("https://shop.example/session".to_string()),
        Some("https://collect.example/post".to_string()),
        None,
    ];
    let links = [
        None,
        Some("https://shop.example/a?x=1".to_string()),
        Some("https://collect.example/a?x=1".to_string()),
    ];
    let mut out = Vec::new();
    for bits in 0u8..64 {
        for action in &actions {
            for link in &links {
                out.push(SensitivityFacts {
                    frame_origin: Some("https://shop.example".into()),
                    target_in_form: bits & 1 != 0,
                    region_has_password: bits & 2 != 0,
                    region_has_payment: bits & 4 != 0,
                    is_submitter: bits & 8 != 0,
                    is_file_input: bits & 16 != 0,
                    is_text_entry: bits & 32 == 0,
                    form_action: action.clone(),
                    link_target: link.clone(),
                });
            }
        }
    }
    out
}

fn rank<T: PartialEq>(order: &[T], value: &T) -> usize {
    order.iter().position(|v| v == value).unwrap()
}

/// `a` is at most as sensitive as `b`, fact by fact.
fn at_most(a: &SensitivityFacts, b: &SensitivityFacts) -> bool {
    let actions = [
        Some("https://shop.example/session".to_string()),
        Some("https://collect.example/post".to_string()),
        None,
    ];
    let le = |x: bool, y: bool| !x || y;
    le(a.target_in_form, b.target_in_form)
        && le(a.region_has_password, b.region_has_password)
        && le(a.region_has_payment, b.region_has_payment)
        && le(a.is_submitter, b.is_submitter)
        && le(a.is_file_input, b.is_file_input)
        && le(b.is_text_entry, a.is_text_entry)
        && rank(&actions, &a.form_action) <= rank(&actions, &b.form_action)
        && a.link_target == b.link_target
}

fn classes(items: &[Sensitive]) -> HashSet<ActionClass> {
    items.iter().map(|s| s.class).collect()
}

#[test]
fn classification_is_monotonic_in_every_fact_taint_and_trust() {
    let facts = all_facts();
    let gestures = [
        Gesture::Click,
        Gesture::Key("Enter"),
        Gesture::Key("Space"),
        Gesture::Key("Tab"),
        Gesture::Type("x\n"),
        Gesture::Type("x"),
        Gesture::Fill,
        Gesture::Select,
        Gesture::Upload,
    ];
    let scenes = [
        scene(false),
        scene(true),
        Scene {
            facts_trusted: false,
            ..scene(true)
        },
    ];
    for gesture in gestures {
        for (lo_scene, hi_scene) in scenes.iter().zip(scenes.iter().skip(1)) {
            for f in &facts {
                let lo = classes(&classify(gesture, f, lo_scene));
                let hi = classes(&classify(gesture, f, hi_scene));
                assert!(lo.is_subset(&hi), "{gesture:?} {f:?}: {lo:?} vs {hi:?}");
            }
        }
        for a in &facts {
            for b in facts.iter().filter(|b| at_most(a, b)) {
                for s in &scenes {
                    let lo = classes(&classify(gesture, a, s));
                    let hi = classes(&classify(gesture, b, s));
                    assert!(
                        lo.is_subset(&hi),
                        "{gesture:?} {a:?} <= {b:?}: {lo:?} vs {hi:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn taint_marks_a_session_until_it_is_forgotten() {
    let taint = Taint::default();
    assert!(!taint.is_tainted("s1"));
    taint.mark("s1");
    assert!(taint.is_tainted("s1"));
    assert!(!taint.is_tainted("s2"));
    taint.forget("s1");
    assert!(!taint.is_tainted("s1"));
}
