//! Literal `mcp_tool` arguments typed by the tool's input schema. A
//! template renders to a string unless it is exactly one hole, so a literal
//! such as `true` or `3` would reach a tool declaring a boolean or a number
//! as the string `"true"` or `"3"`.

use std::fmt;

use serde_json::Value;

use crate::automation::model::NamedTemplate;
use crate::automation::template;

#[derive(Debug, Clone, PartialEq)]
pub enum Literal {
    /// Render the template as usual: it has holes, or its property declares
    /// no type to parse into.
    Render,
    /// The literal parsed into the property's declared type.
    Typed(Value),
    Mismatch(Mismatch),
}

/// A literal that fits none of its property's declared types.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mismatch {
    pub argument: String,
    /// The declared types, as `integer` or `integer or null`.
    pub expected: String,
}

impl fmt::Display for Mismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "argument {} is not a valid {}",
            self.argument, self.expected
        )
    }
}

/// `argument` typed by the `type` its property declares in `input_schema`.
/// A type list takes `null` for the literal `null`, else the first other
/// type the literal fits. `string`, a missing type and a type this host does
/// not know keep the literal as text.
pub fn literal_argument(input_schema: &Value, argument: &NamedTemplate) -> Literal {
    let text = argument.value.as_str();
    if template::parse(text).map_or(true, |parsed| parsed.has_holes()) {
        return Literal::Render;
    }
    let types: Vec<&str> = match &input_schema["properties"][&argument.name]["type"] {
        Value::String(ty) => vec![ty.as_str()],
        Value::Array(types) => types.iter().filter_map(Value::as_str).collect(),
        _ => return Literal::Render,
    };
    if types.is_empty() {
        return Literal::Render;
    }
    if types.contains(&"null") && text == "null" {
        return Literal::Typed(Value::Null);
    }
    for ty in types.iter().filter(|ty| **ty != "null") {
        match fit(ty, text) {
            Fit::Text => return Literal::Render,
            Fit::Parsed(value) => return Literal::Typed(value),
            Fit::Unfit => {}
        }
    }
    Literal::Mismatch(Mismatch {
        argument: argument.name.clone(),
        expected: types.join(" or "),
    })
}

enum Fit {
    Text,
    Parsed(Value),
    Unfit,
}

fn fit(ty: &str, text: &str) -> Fit {
    let fits: fn(&Value) -> bool = match ty {
        "boolean" => Value::is_boolean,
        "integer" => |value| value.is_i64() || value.is_u64(),
        "number" => Value::is_number,
        "object" => Value::is_object,
        "array" => Value::is_array,
        _ => return Fit::Text,
    };
    match serde_json::from_str::<Value>(text) {
        Ok(value) if fits(&value) => Fit::Parsed(value),
        _ => Fit::Unfit,
    }
}
