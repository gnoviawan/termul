//! Map an OpenCode form elicitation onto the existing question card.

use std::collections::BTreeMap;

use agent_client_protocol::schema::v1::{
    ElicitationContentValue, ElicitationPropertySchema, ElicitationSchema, EnumOption,
};

use super::events::QuestionOption;

pub(crate) struct FormField {
    pub name: String,
    pub prompt: String,
    pub options: Vec<QuestionOption>,
}

/// Choice fields the question card can show. Free-text `_custom` companions
/// are skipped; a form with no choice field is declined by the caller.
pub(crate) fn choice_fields(schema: &ElicitationSchema, message: &str) -> Vec<FormField> {
    let mut fields: Vec<FormField> = schema
        .properties
        .iter()
        .filter(|(name, _)| !name.ends_with("_custom"))
        .filter_map(|(name, property)| {
            let ElicitationPropertySchema::String(field) = property else {
                return None;
            };
            let options = field
                .one_of
                .as_ref()
                .map(|options| options.iter().map(option_from_enum).collect::<Vec<_>>())?;
            if options.is_empty() {
                return None;
            }
            let label = field
                .title
                .clone()
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| name.clone());
            Some(FormField {
                name: name.clone(),
                prompt: format!("{message}\n{label}"),
                options,
            })
        })
        .collect();
    // One rendered card uses the elicitation message on its own. Properties
    // that are not choice fields do not count.
    if fields.len() == 1 {
        fields[0].prompt = message.to_string();
    }
    fields
}

/// What one question-card answer does to a multi-field form.
pub(crate) enum FormStep {
    /// The card was declined or cancelled. Reply `decline` and drop answers.
    Declined,
    /// Every choice field has a value. Reply `accept` with `answers`.
    Accepted,
    /// More choice fields remain. Show the field at the updated index.
    Next,
}

/// Record one card answer. `None` declines the whole form, including a cancel
/// on a later field. A selection is stored under the current field name.
pub(crate) fn advance_form(
    field_names: &[String],
    index: &mut usize,
    answers: &mut BTreeMap<String, ElicitationContentValue>,
    values: Option<&[String]>,
) -> FormStep {
    let Some(selected) = values.filter(|selected| !selected.is_empty()) else {
        return FormStep::Declined;
    };
    let Some(name) = field_names.get(*index) else {
        return FormStep::Declined;
    };
    let value = selected.first().cloned().unwrap_or_default();
    answers.insert(name.clone(), value.into());
    *index += 1;
    if *index >= field_names.len() {
        FormStep::Accepted
    } else {
        FormStep::Next
    }
}

fn option_from_enum(option: &EnumOption) -> QuestionOption {
    QuestionOption {
        value: option.value.clone(),
        label: option.title.clone(),
        description: option.description.clone(),
        cardinality: Some("single".to_string()),
    }
}

#[cfg(test)]
mod tests;
