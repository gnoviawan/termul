use std::collections::BTreeMap;

use super::*;
use agent_client_protocol::schema::v1::{
    ElicitationContentValue, ElicitationPropertySchema, ElicitationSchema, EnumOption,
    StringPropertySchema,
};

#[test]
fn choice_fields_keep_one_of_options_and_skip_custom_companions() {
    let schema = ElicitationSchema::new()
        .property(
            "pm",
            ElicitationPropertySchema::String(StringPropertySchema::new().one_of(vec![
                EnumOption::new("bun", "Bun"),
                EnumOption::new("npm", "npm"),
            ])),
            true,
        )
        .property(
            "pm_custom",
            ElicitationPropertySchema::String(StringPropertySchema::new()),
            false,
        );
    let fields = choice_fields(&schema, "Which package manager?");
    assert_eq!(fields.len(), 1);
    assert_eq!(fields[0].name, "pm");
    assert_eq!(fields[0].prompt, "Which package manager?");
    assert_eq!(fields[0].options[0].value, "bun");
    assert_eq!(fields[0].options[0].label, "Bun");
}

#[test]
fn choice_fields_label_each_field_when_the_form_has_several() {
    let schema = ElicitationSchema::new()
        .property(
            "pm",
            ElicitationPropertySchema::String(
                StringPropertySchema::new()
                    .title("Package manager")
                    .one_of(vec![EnumOption::new("bun", "Bun")]),
            ),
            true,
        )
        .property(
            "ci",
            ElicitationPropertySchema::String(
                StringPropertySchema::new()
                    .title("CI")
                    .one_of(vec![EnumOption::new("github", "GitHub")]),
            ),
            true,
        );
    let fields = choice_fields(&schema, "Pick the defaults");
    assert_eq!(fields.len(), 2);
    assert_eq!(fields[0].prompt, "Pick the defaults\nCI");
    assert_eq!(fields[1].prompt, "Pick the defaults\nPackage manager");
}

#[test]
fn advance_form_accepts_one_field_and_declines_a_cancel() {
    let names = vec!["pm".to_string()];
    let mut index = 0;
    let mut answers = BTreeMap::new();
    assert!(matches!(
        advance_form(&names, &mut index, &mut answers, None),
        FormStep::Declined
    ));
    assert!(answers.is_empty());

    index = 0;
    assert!(matches!(
        advance_form(&names, &mut index, &mut answers, Some(&["bun".to_string()])),
        FormStep::Accepted
    ));
    assert_eq!(
        answers.get("pm"),
        Some(&ElicitationContentValue::String("bun".to_string()))
    );
}

#[test]
fn advance_form_walks_fields_and_a_later_cancel_declines() {
    let names = vec!["pm".to_string(), "ci".to_string()];
    let mut index = 0;
    let mut answers = BTreeMap::new();
    assert!(matches!(
        advance_form(&names, &mut index, &mut answers, Some(&["bun".to_string()])),
        FormStep::Next
    ));
    assert_eq!(index, 1);
    assert!(matches!(
        advance_form(&names, &mut index, &mut answers, None),
        FormStep::Declined
    ));
}

#[test]
fn choice_fields_are_empty_without_options() {
    let schema = ElicitationSchema::new().property(
        "note",
        ElicitationPropertySchema::String(StringPropertySchema::new()),
        false,
    );
    assert!(choice_fields(&schema, "Tell me").is_empty());
}
