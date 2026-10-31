use serde_json::json;

use super::schema::{parse, validate, PathError};

fn path_error(path: &str, message: &str) -> PathError {
    PathError {
        path: path.into(),
        message: message.into(),
    }
}

fn messages(schema: serde_json::Value, value: serde_json::Value) -> Vec<String> {
    validate(&parse(&schema).unwrap(), &value)
        .into_iter()
        .map(|e| e.to_string())
        .collect()
}

#[test]
fn accepts_the_supported_keywords() {
    let schema = json!({
        "type": "object",
        "description": "an extraction",
        "properties": {
            "title": { "type": "string" },
            "score": { "type": "number" },
            "rank": { "type": "integer" },
            "ok": { "type": "boolean" },
            "tags": { "type": "array", "items": { "type": "string", "enum": ["a", "b"] } }
        },
        "required": ["title"]
    });
    assert!(parse(&schema).is_ok());
}

#[test]
fn rejects_keywords_outside_the_subset_with_a_path() {
    assert_eq!(
        parse(
            &json!({ "type": "object", "properties": { "d": { "type": "string", "format": "date" } } })
        ),
        Err(path_error(
            "$.properties.d",
            "unsupported keyword \"format\""
        ))
    );
    assert_eq!(
        parse(&json!({ "type": "object", "additionalProperties": false })),
        Err(path_error(
            "$",
            "unsupported keyword \"additionalProperties\""
        ))
    );
    assert_eq!(
        parse(&json!({ "type": "null" })),
        Err(path_error("$", "unsupported type \"null\""))
    );
    assert_eq!(
        parse(&json!({ "properties": {} })),
        Err(path_error("$", "type is required and must be a string"))
    );
    assert_eq!(
        parse(&json!({ "type": "string", "items": { "type": "string" } })),
        Err(path_error("$", "items is not allowed with type \"string\""))
    );
    assert_eq!(
        parse(&json!({ "type": "object", "properties": {}, "required": ["x"] })),
        Err(path_error(
            "$.required[0]",
            "\"x\" is not declared in properties"
        ))
    );
    assert_eq!(
        parse(&json!({ "type": "integer", "enum": [1, "two"] })),
        Err(path_error(
            "$.enum[1]",
            "does not match the declared type: expected integer, got string"
        ))
    );
}

#[test]
fn validates_values_with_every_mismatch_located() {
    let schema = json!({
        "type": "object",
        "properties": {
            "title": { "type": "string" },
            "rank": { "type": "integer" },
            "items": { "type": "array", "items": { "type": "object", "properties": { "n": { "type": "number" } }, "required": ["n"] } },
            "level": { "type": "string", "enum": ["low", "high"] }
        },
        "required": ["title", "rank"]
    });
    assert_eq!(
        messages(
            schema.clone(),
            json!({ "rank": 1.5, "items": [{ "n": 1 }, { "n": "x" }, {}], "level": "mid" })
        ),
        vec![
            "$: missing required property \"title\"",
            "$.items[1].n: expected number, got string",
            "$.items[2]: missing required property \"n\"",
            "$.level: \"mid\" is not one of the allowed values",
            "$.rank: expected integer, got number",
        ]
    );
    assert_eq!(
        messages(schema, json!({ "title": "t", "rank": 3.0, "extra": true })),
        Vec::<String>::new()
    );
    assert_eq!(
        messages(json!({ "type": "array" }), json!({})),
        vec!["$: expected array, got object"]
    );
}
