//! The JSON Schema subset agent nodes declare for their output: `type`
//! (object|array|string|number|integer|boolean), `properties`, `required`,
//! `items`, `enum`, `description`. Any other keyword is rejected.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct Schema {
    pub shape: Shape,
    pub allowed: Option<Vec<Value>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Shape {
    Object {
        properties: BTreeMap<String, Schema>,
        required: Vec<String>,
    },
    Array {
        items: Option<Box<Schema>>,
    },
    String,
    Number,
    Integer,
    Boolean,
}

/// A located problem. `path` is JSONPath-like: `$`, `$.properties.name`,
/// `$.items[2]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathError {
    pub path: String,
    pub message: String,
}

impl fmt::Display for PathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

impl std::error::Error for PathError {}

pub fn parse(schema: &Value) -> Result<Schema, PathError> {
    parse_at(schema, "$")
}

fn err(path: &str, message: impl Into<String>) -> PathError {
    PathError {
        path: path.to_string(),
        message: message.into(),
    }
}

const KEYWORDS: [&str; 6] = [
    "type",
    "properties",
    "required",
    "items",
    "enum",
    "description",
];

fn parse_at(schema: &Value, path: &str) -> Result<Schema, PathError> {
    let obj = schema
        .as_object()
        .ok_or_else(|| err(path, "schema must be an object"))?;
    if let Some(unknown) = obj.keys().find(|k| !KEYWORDS.contains(&k.as_str())) {
        return Err(err(path, format!("unsupported keyword {unknown:?}")));
    }
    if obj.get("description").is_some_and(|d| !d.is_string()) {
        return Err(err(path, "description must be a string"));
    }
    let ty = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| err(path, "type is required and must be a string"))?;
    let shape = match ty {
        "object" => parse_object(obj, path)?,
        "array" => {
            reject_keys(obj, path, &["properties", "required"], ty)?;
            let items = obj
                .get("items")
                .map(|i| parse_at(i, &format!("{path}.items")).map(Box::new))
                .transpose()?;
            Shape::Array { items }
        }
        "string" | "number" | "integer" | "boolean" => {
            reject_keys(obj, path, &["properties", "required", "items"], ty)?;
            match ty {
                "string" => Shape::String,
                "number" => Shape::Number,
                "integer" => Shape::Integer,
                _ => Shape::Boolean,
            }
        }
        other => return Err(err(path, format!("unsupported type {other:?}"))),
    };
    let allowed = match obj.get("enum") {
        None => None,
        Some(Value::Array(values)) if !values.is_empty() => {
            let probe = Schema {
                shape: shape.clone(),
                allowed: None,
            };
            for (i, value) in values.iter().enumerate() {
                if let Some(first) = validate(&probe, value).into_iter().next() {
                    return Err(err(
                        &format!("{path}.enum[{i}]"),
                        format!("does not match the declared type: {}", first.message),
                    ));
                }
            }
            Some(values.clone())
        }
        Some(_) => return Err(err(path, "enum must be a non-empty array")),
    };
    Ok(Schema { shape, allowed })
}

fn parse_object(obj: &Map<String, Value>, path: &str) -> Result<Shape, PathError> {
    reject_keys(obj, path, &["items"], "object")?;
    let mut properties = BTreeMap::new();
    if let Some(props) = obj.get("properties") {
        let props = props
            .as_object()
            .ok_or_else(|| err(path, "properties must be an object"))?;
        for (name, sub) in props {
            properties.insert(
                name.clone(),
                parse_at(sub, &format!("{path}.properties.{name}"))?,
            );
        }
    }
    let mut required = Vec::new();
    if let Some(req) = obj.get("required") {
        let req = req
            .as_array()
            .ok_or_else(|| err(path, "required must be an array of strings"))?;
        for (i, name) in req.iter().enumerate() {
            let name = name
                .as_str()
                .ok_or_else(|| err(&format!("{path}.required[{i}]"), "must be a string"))?;
            if !properties.contains_key(name) {
                return Err(err(
                    &format!("{path}.required[{i}]"),
                    format!("{name:?} is not declared in properties"),
                ));
            }
            required.push(name.to_string());
        }
    }
    Ok(Shape::Object {
        properties,
        required,
    })
}

fn reject_keys(
    obj: &Map<String, Value>,
    path: &str,
    keys: &[&str],
    ty: &str,
) -> Result<(), PathError> {
    match keys.iter().find(|k| obj.contains_key(**k)) {
        Some(key) => Err(err(path, format!("{key} is not allowed with type {ty:?}"))),
        None => Ok(()),
    }
}

/// Every mismatch between `value` and `schema`; empty means valid.
pub fn validate(schema: &Schema, value: &Value) -> Vec<PathError> {
    let mut errors = Vec::new();
    validate_at(schema, value, "$", &mut errors);
    errors
}

fn validate_at(schema: &Schema, value: &Value, path: &str, errors: &mut Vec<PathError>) {
    let type_ok = match (&schema.shape, value) {
        (Shape::Object { .. }, Value::Object(_))
        | (Shape::Array { .. }, Value::Array(_))
        | (Shape::String, Value::String(_))
        | (Shape::Number, Value::Number(_))
        | (Shape::Boolean, Value::Bool(_)) => true,
        (Shape::Integer, Value::Number(n)) => {
            n.is_i64() || n.is_u64() || n.as_f64().is_some_and(|f| f.fract() == 0.0)
        }
        _ => false,
    };
    if !type_ok {
        errors.push(err(
            path,
            format!(
                "expected {}, got {}",
                shape_name(&schema.shape),
                value_name(value)
            ),
        ));
        return;
    }
    if let Some(allowed) = &schema.allowed {
        if !allowed.contains(value) {
            errors.push(err(
                path,
                format!("{value} is not one of the allowed values"),
            ));
        }
    }
    match (&schema.shape, value) {
        (
            Shape::Object {
                properties,
                required,
            },
            Value::Object(map),
        ) => {
            for name in required {
                if !map.contains_key(name) {
                    errors.push(err(path, format!("missing required property {name:?}")));
                }
            }
            for (name, sub) in properties {
                if let Some(v) = map.get(name) {
                    validate_at(sub, v, &format!("{path}.{name}"), errors);
                }
            }
        }
        (Shape::Array { items: Some(items) }, Value::Array(values)) => {
            for (i, v) in values.iter().enumerate() {
                validate_at(items, v, &format!("{path}[{i}]"), errors);
            }
        }
        _ => {}
    }
}

fn shape_name(shape: &Shape) -> &'static str {
    match shape {
        Shape::Object { .. } => "object",
        Shape::Array { .. } => "array",
        Shape::String => "string",
        Shape::Number => "number",
        Shape::Integer => "integer",
        Shape::Boolean => "boolean",
    }
}

fn value_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
