//! The resolved launch spec of an MCP entry: what the host will start or
//! connect to once a plan is committed (AD-5), and what the AD-7 digest
//! covers. Env and header values never live here (AD-6); only their names.

use serde::{Deserialize, Serialize};

use super::convert::OptionKind;

/// An env or header slot. The value travels separately, as a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueSlot {
    pub name: String,
    pub is_secret: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

impl ResolvedConfig {
    pub(crate) fn slots(&self) -> &[ValueSlot] {
        match self {
            Self::Stdio { env, .. } => env,
            Self::Http { headers, .. } | Self::Sse { headers, .. } => headers,
        }
    }
}

/// Which catalog row and option an entry came from (CAP-8 drift checks).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub name: String,
    pub version: String,
    pub kind: OptionKind,
    pub index: usize,
    pub repository_id: Option<String>,
}
