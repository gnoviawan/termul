//! The session's latest model controls (config options, modes, models),
//! folded from durable `session_created`, `config_options_update` and
//! `mode_update` records. A reopened chat installs them when its replay
//! cursor starts after those records, so the picker shows the session's
//! models instead of "no model choice".
//!
//! Each control is a last-writer-wins register stamped with the seq of the
//! record that set it, so the fold does not depend on visit order: a cache
//! can merge a backward log scan with live appends in either order and still
//! converge to the forward fold of the whole log.

use agent_client_protocol::schema::v1::SessionConfigOption;
use serde::Serialize;
use serde_json::{json, Value};

use crate::acp::events::models_from_config_options;
use crate::acp::session_persistence::PersistedEventRecord;

/// The durable record types that carry controls.
pub(crate) const CONTROLS_RECORD_TYPES: [&str; 3] =
    ["session_created", "config_options_update", "mode_update"];

/// The session controls a payload carries. Each control is omitted when no
/// record set it; `controls_seq` is the seq of the newest record that
/// contributed one.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionControls {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Value>,
    pub controls_seq: u64,
}

#[derive(Debug, Clone, PartialEq)]
struct Stamped {
    seq: u64,
    value: Value,
}

/// Newest value per control, each stamped with the seq that set it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ControlsFold {
    config_options: Option<Stamped>,
    models: Option<Stamped>,
    current_mode_id: Option<Stamped>,
    available_modes: Option<Stamped>,
}

impl ControlsFold {
    #[must_use]
    pub fn of_records<'a>(records: impl IntoIterator<Item = &'a PersistedEventRecord>) -> Self {
        let mut fold = Self::default();
        for record in records {
            fold.observe(record);
        }
        fold
    }

    /// Fold one record in; records of other types change nothing. A
    /// `mode_update` without `availableModes` keeps the advertised list, and
    /// a `config_options_update` without a Model selector keeps the models,
    /// as the renderer's live handlers do. A `session_created` starts the
    /// session's controls over: older values are dropped, so the forward fold
    /// agrees with a backward log scan that stops there.
    pub fn observe(&mut self, record: &PersistedEventRecord) {
        let seq = record.seq;
        let payload = &record.payload;
        match record.type_.as_str() {
            "session_created" => {
                for slot in [
                    &mut self.config_options,
                    &mut self.models,
                    &mut self.current_mode_id,
                    &mut self.available_modes,
                ] {
                    if slot.as_ref().is_some_and(|stamped| stamped.seq < seq) {
                        *slot = None;
                    }
                }
                set(
                    &mut self.config_options,
                    seq,
                    array(payload.get("configOptions")),
                );
                set(
                    &mut self.models,
                    seq,
                    payload.get("models").filter(|models| models.is_object()),
                );
                if let Some(modes) = payload.get("modes") {
                    self.observe_modes(seq, modes);
                }
            }
            "config_options_update" => {
                let Some(options) = array(payload.get("configOptions")) else {
                    return;
                };
                set(&mut self.config_options, seq, Some(options));
                set(&mut self.models, seq, models_of_options(options).as_ref());
            }
            "mode_update" => self.observe_modes(seq, payload),
            _ => {}
        }
    }

    fn observe_modes(&mut self, seq: u64, modes: &Value) {
        set(
            &mut self.current_mode_id,
            seq,
            modes.get("currentModeId").filter(|id| id.is_string()),
        );
        set(
            &mut self.available_modes,
            seq,
            array(modes.get("availableModes"))
                .filter(|modes| modes.as_array().is_some_and(|list| !list.is_empty())),
        );
    }

    /// Keep the newer value of each control.
    pub fn merge(&mut self, other: Self) {
        for (mine, theirs) in [
            (&mut self.config_options, other.config_options),
            (&mut self.models, other.models),
            (&mut self.current_mode_id, other.current_mode_id),
            (&mut self.available_modes, other.available_modes),
        ] {
            if let Some(theirs) = theirs {
                set(mine, theirs.seq, Some(&theirs.value));
            }
        }
    }

    /// Every control is set, so no older record can change the fold.
    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.config_options.is_some()
            && self.models.is_some()
            && self.current_mode_id.is_some()
            && self.available_modes.is_some()
    }

    /// The payload view, `None` when no record set any control.
    #[must_use]
    pub fn controls(&self) -> Option<SessionControls> {
        let controls_seq = [
            &self.config_options,
            &self.models,
            &self.current_mode_id,
            &self.available_modes,
        ]
        .into_iter()
        .flatten()
        .map(|stamped| stamped.seq)
        .max()?;
        let value = |stamped: &Option<Stamped>| stamped.as_ref().map(|s| s.value.clone());
        Some(SessionControls {
            config_options: value(&self.config_options),
            modes: self.current_mode_id.as_ref().map(|current| {
                json!({
                    "currentModeId": current.value,
                    "availableModes": value(&self.available_modes).unwrap_or_else(|| json!([])),
                })
            }),
            models: value(&self.models),
            controls_seq,
        })
    }
}

fn set(slot: &mut Option<Stamped>, seq: u64, value: Option<&Value>) {
    let Some(value) = value else {
        return;
    };
    if slot.as_ref().is_none_or(|current| current.seq <= seq) {
        *slot = Some(Stamped {
            seq,
            value: value.clone(),
        });
    }
}

fn array(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| value.is_array())
}

/// The picker's `{currentModelId, availableModels}` view of a Model
/// selector, `None` when the options carry none or do not parse.
fn models_of_options(options: &Value) -> Option<Value> {
    let options: Vec<SessionConfigOption> = serde_json::from_value(options.clone()).ok()?;
    let models = models_from_config_options(Some(&options))?;
    serde_json::to_value(models).ok()
}
