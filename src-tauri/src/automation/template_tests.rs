use std::collections::HashMap;

use serde_json::{json, Value};

use super::model::{NodeId, RunTrigger};
use super::template::{parse, Reference, RenderContext, RenderError, TemplateError};

fn node(id: &str) -> NodeId {
    NodeId::parse(id).unwrap()
}

fn outputs() -> HashMap<NodeId, Value> {
    HashMap::from([(
        node("fetch"),
        json!({ "items": [{ "title": "first" }, { "title": "second" }], "count": 2 }),
    )])
}

fn render(src: &str, secrets: Option<&HashMap<String, String>>) -> Result<Value, RenderError> {
    let outputs = outputs();
    let ctx = RenderContext {
        scheduled_for: 1_700_000_000_000,
        trigger: RunTrigger::CatchUp,
        outputs: &outputs,
        secrets,
    };
    parse(src).unwrap().render(&ctx)
}

#[test]
fn lists_every_reference_kind() {
    let t = parse("{{trigger.scheduled_for}} {{ trigger.kind }} {{nodes.fetch.output.items.0.title}} {{secrets.API_KEY}}")
        .unwrap();
    assert_eq!(
        t.references().cloned().collect::<Vec<_>>(),
        vec![
            Reference::TriggerScheduledFor,
            Reference::TriggerKind,
            Reference::NodeOutput {
                node: node("fetch"),
                path: vec!["items".into(), "0".into(), "title".into()],
            },
            Reference::Secret("API_KEY".into()),
        ]
    );
}

#[test]
fn rejects_unknown_roots_and_malformed_holes() {
    assert_eq!(
        parse("a {{ nodes.fetch.output"),
        Err(TemplateError::Unterminated { offset: 2 })
    );
    for bad in [
        "{{ env.HOME }}",
        "{{ trigger.other }}",
        "{{ nodes.Fetch.output }}",
        "{{ nodes.fetch.result }}",
        "{{ secrets }}",
        "{{ nodes..output }}",
    ] {
        assert!(
            matches!(parse(bad), Err(TemplateError::InvalidPath { .. })),
            "{bad}"
        );
    }
}

#[test]
fn whole_string_hole_keeps_the_json_value() {
    assert_eq!(
        render("{{ nodes.fetch.output.items }}", None),
        Ok(json!([{ "title": "first" }, { "title": "second" }]))
    );
    assert_eq!(
        render("{{trigger.scheduled_for}}", None),
        Ok(json!(1_700_000_000_000_i64))
    );
}

#[test]
fn mixed_text_stringifies_each_hole() {
    assert_eq!(
        render(
            "{{trigger.kind}}: {{nodes.fetch.output.count}} items, last {{nodes.fetch.output.items.1.title}} {{nodes.fetch.output.items.0}}",
            None
        ),
        Ok(json!(r#"catch_up: 2 items, last second {"title":"first"}"#))
    );
    assert_eq!(render("no holes", None), Ok(json!("no holes")));
}

#[test]
fn missing_outputs_and_fields_are_errors() {
    assert_eq!(
        render("{{nodes.other.output}}", None),
        Err(RenderError::MissingOutput(node("other")))
    );
    assert_eq!(
        render("x {{nodes.fetch.output.items.9}}", None),
        Err(RenderError::MissingField {
            node: node("fetch"),
            path: vec!["items".into(), "9".into()],
        })
    );
}

#[test]
fn secrets_render_only_when_allowed() {
    let secrets = HashMap::from([("API_KEY".to_string(), "s3cret".to_string())]);
    assert_eq!(
        render("Bearer {{secrets.API_KEY}}", Some(&secrets)),
        Ok(json!("Bearer s3cret"))
    );
    assert_eq!(
        render("Bearer {{secrets.API_KEY}}", None),
        Err(RenderError::SecretForbidden("API_KEY".into()))
    );
    assert_eq!(
        render("{{secrets.OTHER}}", Some(&secrets)),
        Err(RenderError::SecretMissing("OTHER".into()))
    );
    assert_eq!(
        RenderError::SecretMissing("OTHER".into()).to_string(),
        "secret_missing:OTHER"
    );
}
