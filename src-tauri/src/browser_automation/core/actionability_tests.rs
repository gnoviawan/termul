use std::collections::VecDeque;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::Value;

use super::*;
use crate::browser_automation::engine::assets::Script;
use crate::browser_automation::engine::events::DialogAnswer;
use crate::browser_automation::engine::{
    CapabilityTable, EngineFacts, EngineFuture, EngineTraits, InputMode, Support,
};

/// Answers facts probes from a script; the last answer repeats.
struct ScriptedFacts {
    facts: EngineFacts,
    answers: Mutex<VecDeque<ActionabilityFacts>>,
    probes: Mutex<usize>,
}

impl ScriptedFacts {
    fn new(answers: impl IntoIterator<Item = ActionabilityFacts>) -> Self {
        Self {
            facts: EngineFacts {
                capabilities: CapabilityTable::uniform(Support::Trusted),
                traits: EngineTraits {
                    isolated_world: true,
                    background_render: true,
                    network_observe: false,
                },
            },
            answers: Mutex::new(answers.into_iter().collect()),
            probes: Mutex::new(0),
        }
    }
}

impl BrowserEngine for ScriptedFacts {
    fn facts(&self) -> &EngineFacts {
        &self.facts
    }
    fn evaluate<'a>(&'a self, _tab: &'a str, _script: Script) -> EngineFuture<'a, Value> {
        unreachable!("facts come from element_facts")
    }
    fn element_facts<'a>(
        &'a self,
        _tab: &'a str,
        _frame: Option<&'a str>,
        _path: &'a str,
    ) -> EngineFuture<'a, ActionabilityFacts> {
        *self.probes.lock() += 1;
        let mut answers = self.answers.lock();
        let next = if answers.len() > 1 {
            answers.pop_front().unwrap()
        } else {
            answers.front().cloned().unwrap()
        };
        Box::pin(async move { Ok(next) })
    }
    fn pointer_click<'a>(&'a self, _tab: &'a str, _at: Point, _mode: InputMode) -> EngineFuture<'a, ()> {
        unreachable!()
    }
    fn screenshot<'a>(&'a self, _tab: &'a str) -> EngineFuture<'a, Vec<u8>> {
        unreachable!()
    }
    fn answer_dialog<'a>(&'a self, _tab: &'a str, _id: u64, _answer: DialogAnswer) -> EngineFuture<'a, bool> {
        unreachable!()
    }
}

fn node() -> RefNode {
    RefNode {
        role: "button".into(),
        name: "Pay".into(),
        path: "@e1".into(),
        frame: String::new(),
    }
}

fn ready() -> ElementState {
    ElementState {
        role: "button".into(),
        name: "Pay".into(),
        point: Point { x: 40.0, y: 20.0 },
        visible: true,
        stable: true,
        hit: true,
        enabled: true,
        kind: ControlKind::Other,
        focus_on_click: false,
    }
}

fn present(edit: impl FnOnce(&mut ElementState)) -> ActionabilityFacts {
    let mut state = ready();
    edit(&mut state);
    ActionabilityFacts::Present(state)
}

async fn wait(engine: &ScriptedFacts, need: Need) -> Result<Target, BrowserError> {
    let deadline = Deadline::after(Duration::from_secs(60));
    wait_until_actionable(engine, "agent-1", "@e1", &node(), need, deadline).await
}

fn reason(result: Result<Target, BrowserError>) -> (&'static str, Option<&'static str>) {
    let err = result.expect_err("the target is not actionable");
    (err.code, err.reason)
}

#[tokio::test(start_paused = true)]
async fn a_ready_element_answers_at_once_with_its_centre() {
    let engine = ScriptedFacts::new([present(|_| {})]);
    let target = wait(&engine, Need::Activate).await.unwrap();
    assert_eq!(target.point, Point { x: 40.0, y: 20.0 });
    assert_eq!(*engine.probes.lock(), 1);
}

#[tokio::test(start_paused = true)]
async fn covered_moving_and_hidden_elements_time_out_with_the_reason() {
    for (facts, expected) in [
        (present(|s| s.hit = false), "covered"),
        (present(|s| s.stable = false), "unstable"),
        (present(|s| s.visible = false), "not_visible"),
        (present(|s| s.enabled = false), "disabled"),
    ] {
        let engine = ScriptedFacts::new([facts]);
        assert_eq!(reason(wait(&engine, Need::Activate).await), ("timeout", Some(expected)));
        assert!(*engine.probes.lock() > 10, "{expected}: it kept polling for the whole wait");
    }
}

#[tokio::test(start_paused = true)]
async fn an_element_that_settles_inside_the_wait_is_acted_on() {
    let engine = ScriptedFacts::new([
        present(|s| s.stable = false),
        present(|s| s.hit = false),
        present(|_| {}),
    ]);
    assert!(wait(&engine, Need::Activate).await.is_ok());
    assert_eq!(*engine.probes.lock(), 3);
}

#[tokio::test(start_paused = true)]
async fn a_hidden_element_whose_name_vanished_is_still_a_timeout_not_a_stale_ref() {
    let engine = ScriptedFacts::new([present(|s| {
        s.visible = false;
        s.name.clear();
    })]);
    assert_eq!(reason(wait(&engine, Need::Activate).await), ("timeout", Some("not_visible")));
}

#[tokio::test(start_paused = true)]
async fn a_detached_or_repurposed_element_is_a_stale_ref() {
    for facts in [
        ActionabilityFacts::Detached,
        present(|s| s.role = "link".into()),
        present(|s| s.name = "Cancel".into()),
    ] {
        let engine = ScriptedFacts::new([facts.clone()]);
        assert_eq!(reason(wait(&engine, Need::Activate).await).0, "stale_ref", "{facts:?}");
    }
}

#[tokio::test(start_paused = true)]
async fn text_actions_need_an_editable_control_and_hover_ignores_disabled() {
    let button = ScriptedFacts::new([present(|_| {})]);
    assert_eq!(reason(wait(&button, Need::Type).await), ("timeout", Some("not_editable")));

    let select = ScriptedFacts::new([present(|s| s.kind = ControlKind::Select)]);
    assert_eq!(wait(&select, Need::Fill).await.unwrap().kind, ControlKind::Select);
    assert_eq!(reason(wait(&select, Need::Type).await), ("timeout", Some("not_editable")));

    let disabled = ScriptedFacts::new([present(|s| s.enabled = false)]);
    assert!(wait(&disabled, Need::Pointer).await.is_ok());
}
