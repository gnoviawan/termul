use serde::{Deserialize, Serialize};

use super::convert::OptionKind;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ValueSlot {
    pub name: String,
    pub is_secret: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "transport", rename_all = "lowercase")]
pub enum ResolvedConfig {
    Stdio {
        command: String,
        args: Vec<String>,
        env: Vec<ValueSlot>,
    },
    Http {
        url: String,
        headers: Vec<ValueSlot>,
    },
    Sse {
        url: String,
        headers: Vec<ValueSlot>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub name: String,
    pub version: String,
    pub kind: OptionKind,
    pub index: usize,
    pub repository_id: Option<String>,
}
