use serde_json::{json, Value};

use super::arguments::Mismatch;
use super::{literal_argument, Literal};
use crate::automation::model::{NamedTemplate, Template};

fn typed(ty: Value, value: &str) -> Literal {
    let schema = json!({ "type": "object", "properties": { "arg": { "type": ty } } });
    let argument = NamedTemplate {
        name: "arg".into(),
        value: Template(value.into()),
    };
    literal_argument(&schema, &argument)
}

fn mismatch(expected: &str) -> Literal {
    Literal::Mismatch(Mismatch {
        argument: "arg".into(),
        expected: expected.into(),
    })
}

#[test]
fn each_declared_type_parses_a_literal_that_fits_it() {
    assert_eq!(typed(json!("boolean"), "true"), Literal::Typed(json!(true)));
    assert_eq!(
        typed(json!("boolean"), "false"),
        Literal::Typed(json!(false))
    );
    assert_eq!(typed(json!("integer"), "3"), Literal::Typed(json!(3)));
    assert_eq!(typed(json!("integer"), "-42"), Literal::Typed(json!(-42)));
    assert_eq!(typed(json!("number"), "2.5"), Literal::Typed(json!(2.5)));
    assert_eq!(typed(json!("number"), "7"), Literal::Typed(json!(7)));
    assert_eq!(
        typed(json!("object"), r#"{"a": 1}"#),
        Literal::Typed(json!({ "a": 1 }))
    );
    assert_eq!(
        typed(json!("array"), r#"["bug", 2]"#),
        Literal::Typed(json!(["bug", 2]))
    );
}

#[test]
fn a_literal_that_does_not_fit_its_type_is_a_mismatch() {
    assert_eq!(typed(json!("boolean"), "yes"), mismatch("boolean"));
    assert_eq!(typed(json!("integer"), "2.5"), mismatch("integer"));
    assert_eq!(typed(json!("integer"), "\"3\""), mismatch("integer"));
    assert_eq!(typed(json!("number"), "NaN"), mismatch("number"));
    assert_eq!(typed(json!("number"), ""), mismatch("number"));
    assert_eq!(typed(json!("object"), "[1]"), mismatch("object"));
    assert_eq!(typed(json!("array"), "{}"), mismatch("array"));
    assert_eq!(typed(json!("array"), "bug"), mismatch("array"));
}

#[test]
fn a_type_list_takes_null_for_null_and_else_the_first_type_that_fits() {
    let nullable = json!(["integer", "null"]);
    assert_eq!(typed(nullable.clone(), "null"), Literal::Typed(Value::Null));
    assert_eq!(typed(nullable.clone(), "12"), Literal::Typed(json!(12)));
    assert_eq!(typed(nullable, "twelve"), mismatch("integer or null"));
    assert_eq!(
        typed(json!(["boolean", "array"]), "[true]"),
        Literal::Typed(json!([true]))
    );
    assert_eq!(typed(json!(["integer", "string"]), "abc"), Literal::Render);
    assert_eq!(typed(json!(["string", "integer"]), "3"), Literal::Render);
}

#[test]
fn string_missing_and_unknown_types_keep_the_literal_as_text() {
    assert_eq!(typed(json!("string"), "true"), Literal::Render);
    assert_eq!(typed(json!("date"), "3"), Literal::Render);
    assert_eq!(typed(json!([]), "3"), Literal::Render);
    let schema = json!({ "type": "object", "properties": { "arg": { "description": "any" } } });
    let argument = NamedTemplate {
        name: "arg".into(),
        value: Template("true".into()),
    };
    assert_eq!(literal_argument(&schema, &argument), Literal::Render);
    assert_eq!(
        literal_argument(&json!({ "type": "object" }), &argument),
        Literal::Render
    );
}

#[test]
fn a_template_with_holes_renders_as_before() {
    assert_eq!(
        typed(json!("integer"), "{{nodes.seed.output}}"),
        Literal::Render
    );
    assert_eq!(
        typed(json!("boolean"), "{{trigger.kind}} true"),
        Literal::Render
    );
}

#[test]
fn a_mismatch_names_the_argument_and_the_expected_types_but_not_the_value() {
    let Literal::Mismatch(mismatch) = typed(json!(["integer", "null"]), "secret-ish") else {
        panic!("expected a mismatch");
    };
    assert_eq!(
        mismatch.to_string(),
        "argument arg is not a valid integer or null"
    );
}
