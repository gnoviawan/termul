//! The generated install form (install-form.md) and how its values become
//! the launch spec. A registry input is a *slot* (an env var, a header, an
//! argument or the URL) with one value source: fixed text, one user field, or
//! a template whose variables are each a field (AD-4). The host composes
//! every value; the renderer only draws the fields.
//!
//! Secret fields are collected by the form but sent at commit (AD-5), so a
//! slot that depends on one stays pending until then. Every secret field is
//! required: the consented config lists the slot, and an empty secret would
//! leave it set to nothing.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::convert::{RegistryInput, RegistryPackage, RegistryRemote};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FieldTarget {
    Env { name: String },
    Header { name: String },
    Argument { index: usize, name: Option<String> },
    Url,
}

impl FieldTarget {
    fn id_prefix(&self) -> String {
        match self {
            Self::Env { name } => format!("env/{name}"),
            Self::Header { name } => format!("header/{name}"),
            Self::Argument { index, .. } => format!("arg/{index}"),
            Self::Url => "url".to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldFormat {
    #[default]
    String,
    Number,
    Boolean,
    Filepath,
}

impl FieldFormat {
    fn from_registry(format: Option<&str>) -> Self {
        match format {
            Some("number") => Self::Number,
            Some("boolean") => Self::Boolean,
            Some("filepath") => Self::Filepath,
            _ => Self::String,
        }
    }
}

/// One form field; the wire `McpInstallField`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub id: String,
    pub label: String,
    pub target: FieldTarget,
    pub variable: Option<String>,
    pub is_required: bool,
    pub is_secret: bool,
    pub format: FieldFormat,
    pub choices: Option<Vec<String>>,
    pub default: Option<String>,
    pub placeholder: Option<String>,
    pub description: Option<String>,
}

/// Who supplied a value: registry text, the user, or an imported file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Registry,
    User,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ValueSource {
    Fixed {
        value: String,
        origin: Origin,
    },
    Input {
        field: String,
    },
    /// `text` with `{var}` placeholders; each variable is a field.
    Template {
        text: String,
        variables: Vec<(String, String)>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Slot {
    pub target: FieldTarget,
    pub source: ValueSource,
    pub is_secret: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct FormModel {
    pub fields: Vec<Field>,
    pub slots: Vec<Slot>,
}

/// A registry template names a variable it does not declare (AD-4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnresolvedVariable {
    pub slot: String,
    pub variable: String,
}

impl fmt::Display for UnresolvedVariable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "registry template for `{}` names an undeclared variable `{}`",
            self.slot, self.variable
        )
    }
}

static TEMPLATE_VARIABLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{([A-Za-z_][A-Za-z0-9_.-]*)\}").expect("template regex"));

fn template_variables(text: &str) -> Vec<String> {
    let mut seen = Vec::new();
    for capture in TEMPLATE_VARIABLE.captures_iter(text) {
        let name = capture[1].to_string();
        if !seen.contains(&name) {
            seen.push(name);
        }
    }
    seen
}

fn fill_template(text: &str, values: &BTreeMap<String, String>) -> String {
    TEMPLATE_VARIABLE
        .replace_all(text, |capture: &regex::Captures<'_>| {
            values
                .get(&capture[1])
                .cloned()
                .unwrap_or_else(|| capture[0].to_string())
        })
        .into_owned()
}

fn field_from(
    id: String,
    label: String,
    target: FieldTarget,
    variable: Option<String>,
    is_required: bool,
    spec: &RegistryInput,
) -> Field {
    let is_secret = spec.is_secret;
    Field {
        id,
        label,
        target,
        variable,
        is_required: is_required || is_secret,
        is_secret,
        format: FieldFormat::from_registry(spec.format.as_deref()),
        choices: (!spec.choices.is_empty()).then(|| spec.choices.clone()),
        default: spec.default.clone(),
        placeholder: spec.placeholder.clone(),
        description: spec.description.clone(),
    }
}

impl FormModel {
    /// One slot from a registry input: a fixed value, a whole-value field or
    /// a template with one field per variable.
    fn add_registry_slot(
        &mut self,
        target: FieldTarget,
        label: String,
        spec: &RegistryInput,
    ) -> Result<(), UnresolvedVariable> {
        let prefix = target.id_prefix();
        let source = match spec.value.as_deref() {
            Some(text) => {
                let names = template_variables(text);
                if names.is_empty() {
                    ValueSource::Fixed {
                        value: text.to_string(),
                        origin: Origin::Registry,
                    }
                } else {
                    let mut variables = Vec::with_capacity(names.len());
                    for name in names {
                        let Some(variable) = spec.variables.get(&name) else {
                            return Err(UnresolvedVariable {
                                slot: prefix,
                                variable: name,
                            });
                        };
                        let id = format!("{prefix}/{name}");
                        self.fields.push(field_from(
                            id.clone(),
                            name.clone(),
                            target.clone(),
                            Some(name.clone()),
                            true,
                            variable,
                        ));
                        variables.push((name, id));
                    }
                    ValueSource::Template {
                        text: text.to_string(),
                        variables,
                    }
                }
            }
            None => {
                self.fields.push(field_from(
                    prefix.clone(),
                    label,
                    target.clone(),
                    None,
                    spec.is_required,
                    spec,
                ));
                ValueSource::Input { field: prefix }
            }
        };
        let is_secret = spec.is_secret || spec.variables.values().any(|v| v.is_secret);
        self.slots.push(Slot {
            target,
            source,
            is_secret,
        });
        Ok(())
    }

    pub(crate) fn for_package(package: &RegistryPackage) -> Result<Self, UnresolvedVariable> {
        let mut model = Self::default();
        for env in &package.environment_variables {
            model.add_registry_slot(
                FieldTarget::Env {
                    name: env.name.clone(),
                },
                env.name.clone(),
                env,
            )?;
        }
        for (index, argument) in package.package_arguments.iter().enumerate() {
            let named = argument.argument_type.as_deref() == Some("named");
            let name = named.then(|| argument.name.clone());
            let label = match &name {
                Some(name) => name.clone(),
                None => argument
                    .value_hint
                    .clone()
                    .filter(|hint| !hint.is_empty())
                    .unwrap_or_else(|| format!("argument {}", index + 1)),
            };
            model.add_registry_slot(FieldTarget::Argument { index, name }, label, argument)?;
        }
        Ok(model)
    }

    pub(crate) fn for_remote(remote: &RegistryRemote) -> Result<Self, UnresolvedVariable> {
        let mut model = Self::default();
        let url = RegistryInput {
            value: Some(remote.url.clone()),
            variables: remote.variables.clone(),
            ..RegistryInput::default()
        };
        model.add_registry_slot(FieldTarget::Url, "url".to_string(), &url)?;
        for header in &remote.headers {
            model.add_registry_slot(
                FieldTarget::Header {
                    name: header.name.clone(),
                },
                header.name.clone(),
                header,
            )?;
        }
        Ok(model)
    }

    /// Every value from a file: no fields, every slot fixed (AD-5 import).
    pub(crate) fn fixed(slots: impl IntoIterator<Item = (FieldTarget, String)>) -> Self {
        Self {
            fields: Vec::new(),
            slots: slots
                .into_iter()
                .map(|(target, value)| Slot {
                    target,
                    source: ValueSource::Fixed {
                        value,
                        origin: Origin::File,
                    },
                    is_secret: false,
                })
                .collect(),
        }
    }
}

/// Which half of the form a request carries (AD-5: secrets only at commit).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    Plan,
    Commit,
}

fn check_value(field: &Field, raw: &str) -> Result<String, String> {
    if let Some(choices) = &field.choices {
        if !choices.iter().any(|choice| choice == raw) {
            return Err(format!("`{}` must be one of the listed choices", field.id));
        }
    }
    match field.format {
        FieldFormat::Number => {
            let trimmed = raw.trim();
            match trimmed.parse::<f64>() {
                Ok(number) if number.is_finite() => Ok(trimmed.to_string()),
                _ => Err(format!("`{}` must be a number", field.id)),
            }
        }
        FieldFormat::Boolean => match raw.trim() {
            "true" | "false" => Ok(raw.trim().to_string()),
            _ => Err(format!("`{}` must be `true` or `false`", field.id)),
        },
        FieldFormat::String | FieldFormat::Filepath => Ok(raw.to_string()),
    }
}

/// Validate the fields of one phase against `inputs` and apply defaults.
/// Returns field id → value for every field of that phase that has one.
pub(crate) fn validate_inputs(
    fields: &[Field],
    inputs: &BTreeMap<String, String>,
    phase: Phase,
) -> Result<BTreeMap<String, String>, String> {
    let in_phase = |field: &Field| field.is_secret == matches!(phase, Phase::Commit);
    for id in inputs.keys() {
        match fields.iter().find(|field| &field.id == id) {
            None => return Err(format!("unknown field `{id}`")),
            Some(field) if !in_phase(field) => {
                return Err(match phase {
                    Phase::Plan => format!("`{id}` is secret; send it at commit"),
                    Phase::Commit => {
                        format!("`{id}` is not secret; commit accepts secret values only")
                    }
                })
            }
            Some(_) => {}
        }
    }
    let mut values = BTreeMap::new();
    for field in fields.iter().filter(|field| in_phase(field)) {
        let raw = inputs
            .get(&field.id)
            .filter(|value| !value.is_empty())
            .or(field.default.as_ref());
        match raw {
            Some(raw) => {
                values.insert(field.id.clone(), check_value(field, raw)?);
            }
            None if field.is_required => return Err(format!("`{}` is required", field.id)),
            None => {}
        }
    }
    Ok(values)
}

/// A slot's value given the values known so far.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Resolved {
    Value {
        value: String,
        origin: Origin,
    },
    /// Depends on a field not in `values` (a secret before commit).
    Pending,
    /// An optional input left empty: the slot is left out.
    Omitted,
}

pub(crate) fn resolve(slot: &Slot, values: &BTreeMap<String, String>) -> Resolved {
    match &slot.source {
        ValueSource::Fixed { value, origin } => Resolved::Value {
            value: value.clone(),
            origin: *origin,
        },
        ValueSource::Input { field } => match values.get(field) {
            Some(value) => Resolved::Value {
                value: value.clone(),
                origin: Origin::User,
            },
            None if slot.is_secret => Resolved::Pending,
            None => Resolved::Omitted,
        },
        ValueSource::Template { text, variables } => {
            if variables
                .iter()
                .any(|(_, field)| !values.contains_key(field))
            {
                return Resolved::Pending;
            }
            let bound: BTreeMap<String, String> = variables
                .iter()
                .filter_map(|(name, field)| Some((name.clone(), values.get(field)?.clone())))
                .collect();
            Resolved::Value {
                value: fill_template(text, &bound),
                origin: Origin::User,
            }
        }
    }
}
