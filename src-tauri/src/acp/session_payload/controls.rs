//! The session's last known mode, model, and config-option controls, folded
//! from durable records so a reopened chat can show its pickers before (or
//! without) a `session/load` / `session/resume` reply. A live-turn attach
//! subscribes past the records that carried them and never sees them again.
//!
//! Values stay opaque JSON, exactly as the agent sent them.

use serde::Serialize;
use serde_json::{json, Value};

use crate::acp::session_persistence::PersistedEventRecord;

/// The record types [`SessionControls::apply`] reads.
pub const CONTROL_RECORD_TYPES: [&str; 3] =
    ["session_created", "config_options_update", "mode_update"];

/// Each key is absent until a record sets it.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionControls {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Value>,
}

impl SessionControls {
    /// Fold seq-ordered records. `None` when no record set a control.
    #[must_use]
    pub fn fold<'a>(records: impl IntoIterator<Item = &'a PersistedEventRecord>) -> Option<Self> {
        let mut controls = Self::default();
        for record in records {
            controls.apply(record);
        }
        controls.known()
    }

    /// `None` when no record has set a control yet.
    #[must_use]
    pub fn known(self) -> Option<Self> {
        (self != Self::default()).then_some(self)
    }

    /// Apply one record. `session_created` sets the keys it carries, a
    /// `config_options_update` replaces the option list, and a `mode_update`
    /// moves the current mode the way the renderer's `_onModeUpdate` does.
    /// Every other record type leaves the controls unchanged.
    pub fn apply(&mut self, record: &PersistedEventRecord) {
        let payload = &record.payload;
        match record.type_.as_str() {
            "session_created" => {
                set_present(&mut self.modes, payload, "modes");
                set_present(&mut self.models, payload, "models");
                set_present(&mut self.config_options, payload, "configOptions");
            }
            "config_options_update" => {
                set_present(&mut self.config_options, payload, "configOptions");
            }
            "mode_update" => self.apply_mode_update(payload),
            _ => {}
        }
    }

    fn apply_mode_update(&mut self, payload: &Value) {
        let Some(current_mode_id) = present(payload, "currentModeId") else {
            return;
        };
        let available_modes = present(payload, "availableModes")
            .filter(|modes| modes.as_array().is_some_and(|modes| !modes.is_empty()))
            .or_else(|| {
                self.modes
                    .as_ref()
                    .and_then(|modes| present(modes, "availableModes"))
            })
            .cloned()
            .unwrap_or_else(|| json!([]));
        self.modes = Some(json!({
            "currentModeId": current_mode_id,
            "availableModes": available_modes,
        }));
    }
}

fn present<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|value| !value.is_null())
}

fn set_present(slot: &mut Option<Value>, payload: &Value, key: &str) {
    if let Some(value) = present(payload, key) {
        *slot = Some(value.clone());
    }
}
