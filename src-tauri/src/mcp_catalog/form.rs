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
    Template {
        text: String,
        variables: Vec<TemplateVariable>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TemplateVariable {
    pub name: String,
    pub field: String,
    pub is_secret: bool,
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
        default: spec.default.clone().filter(|_| !is_secret),
        placeholder: spec.placeholder.clone(),
        description: spec.description.clone(),
    }
}

impl FormModel {
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
                        variables.push(TemplateVariable {
                            name,
                            field: id,
                            is_secret: variable.is_secret,
                        });
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Supplied {
    pub value: String,
    pub origin: Origin,
}

pub(crate) type Values = BTreeMap<String, Supplied>;

pub(crate) fn validate_inputs(
    fields: &[Field],
    inputs: &BTreeMap<String, String>,
    phase: Phase,
) -> Result<Values, String> {
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
        let raw = match inputs.get(&field.id).filter(|value| !value.is_empty()) {
            Some(typed) => Some((typed, Origin::User)),
            None => field.default.as_ref().map(|default| (default, Origin::Registry)),
        };
        match raw {
            Some((raw, origin)) => {
                let value = check_value(field, raw)?;
                values.insert(field.id.clone(), Supplied { value, origin });
            }
            None if field.is_required => return Err(format!("`{}` is required", field.id)),
            None => {}
        }
    }
    Ok(values)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Resolved {
    Value {
        value: String,
        origin: Origin,
    },
    Pending,
    Omitted,
}

pub(crate) fn resolve(slot: &Slot, values: &Values) -> Resolved {
    match &slot.source {
        ValueSource::Fixed { value, origin } => Resolved::Value {
            value: value.clone(),
            origin: *origin,
        },
        ValueSource::Input { field } => match values.get(field) {
            Some(supplied) => Resolved::Value {
                value: supplied.value.clone(),
                origin: supplied.origin,
            },
            None if slot.is_secret => Resolved::Pending,
            None => Resolved::Omitted,
        },
        ValueSource::Template { text, variables } => {
            if variables.iter().any(|v| !values.contains_key(&v.field)) {
                return Resolved::Pending;
            }
            let (value, origin) = fill_variables(text, variables, values, |_| true);
            Resolved::Value { value, origin }
        }
    }
}

/// `text` with each variable `bind` accepts filled from `values`; any other
/// stays its `{name}` placeholder.
fn fill_variables(
    text: &str,
    variables: &[TemplateVariable],
    values: &Values,
    bind: impl Fn(&TemplateVariable) -> bool,
) -> (String, Origin) {
    let supplied: Vec<(&TemplateVariable, &Supplied)> = variables
        .iter()
        .filter(|v| bind(v))
        .filter_map(|v| Some((v, values.get(&v.field)?)))
        .collect();
    let bound: BTreeMap<String, String> = supplied
        .iter()
        .map(|(v, supplied)| (v.name.clone(), supplied.value.clone()))
        .collect();
    let typed = supplied.iter().any(|(_, s)| s.origin == Origin::User);
    (
        fill_template(text, &bound),
        if typed { Origin::User } else { Origin::Registry },
    )
}

/// What the consent view shows for an env or header slot. `withheld` marks a
/// value the user types into a secret field: it is not shown, and inside a
/// template it stays its `{name}` placeholder so the registry text around it
/// still is. Registry and file text is shown even when flagged secret,
/// because the user did not choose it and is consenting to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Shown {
    pub text: Option<String>,
    pub withheld: bool,
    pub origin: Origin,
}

pub(crate) fn shown(slot: &Slot, values: &Values) -> Shown {
    match &slot.source {
        ValueSource::Fixed { value, origin } => Shown {
            text: Some(value.clone()),
            withheld: false,
            origin: *origin,
        },
        ValueSource::Input { field } => match values.get(field) {
            Some(supplied) if !(slot.is_secret && supplied.origin == Origin::User) => Shown {
                text: Some(supplied.value.clone()),
                withheld: false,
                origin: supplied.origin,
            },
            _ => Shown {
                text: None,
                withheld: true,
                origin: Origin::User,
            },
        },
        ValueSource::Template { text, variables } => {
            let (text, origin) = fill_variables(text, variables, values, |v| !v.is_secret);
            Shown {
                text: Some(text),
                withheld: variables.iter().any(|v| v.is_secret),
                origin,
            }
        }
    }
}
