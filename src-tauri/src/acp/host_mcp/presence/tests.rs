//! The guest a session shows: pacing, flash timing and hiding on the pure
//! book; the notices a fake renderer receives through the canvas router; and,
//! through the real parent and `Bridge`, that presence never holds up or
//! fails the agent's call and fades out when the turn ends or the session
//! closes.

use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::time::Instant;

use super::*;
use crate::acp::host_mcp::bridge::Bridge;
use crate::acp::host_mcp::canvas::{CanvasCallFrame, CanvasError, CanvasErrorCode, CanvasRouter};
use crate::acp::host_mcp::gateway_harness::{mount_renderer, Harness};

const PROJECT: &str = "proj-presence";
const SESSION: &str = "sess-presence";
const EXECUTE: &str = "engine.execute";

fn origin() -> CallOrigin<'static> {
    CallOrigin {
        session_id: SESSION,
        agent_id: "agent-1",
        project_id: PROJECT,
    }
}

fn nodes(ids: &[u64]) -> Activity {
    Activity {
        kind: Look::Write,
        targets: Targets::Nodes {
            ids: ids.to_vec(),
            last: None,
        },
    }
}

fn node_with_bounds(id: u64, x: f64, y: f64) -> Value {
    json!({ "id": id, "absoluteBounds": { "x": x, "y": y, "width": 100, "height": 40 } })
}

// ---- the book, on explicit time ----

#[test]
fn moves_are_paced_to_one_per_interval_and_the_latest_waiting_one_wins() {
    let mut book = GuestBook::default();
    let start = Instant::now();
    let epoch = book
        .offer(origin(), "opencode", nodes(&[1]))
        .expect("a drain starts");
    assert_eq!(
        book.offer(origin(), "opencode", nodes(&[2])),
        None,
        "one drain per guest"
    );
    let Step::Locate { activity, .. } = book.next(SESSION, epoch, start) else {
        panic!("the first move runs at once");
    };
    assert_eq!(
        activity,
        nodes(&[2]),
        "the latest activity replaced the first"
    );
    book.shown(SESSION, epoch, Look::Write, Some((1.0, 1.0)), &[2], start);

    assert_eq!(book.offer(origin(), "opencode", nodes(&[3])), None);
    assert_eq!(book.offer(origin(), "opencode", nodes(&[4])), None);
    assert_eq!(
        book.next(SESSION, epoch, start + Duration::from_millis(50)),
        Step::Wait(start + MOVE_EVERY)
    );
    let Step::Locate { activity, .. } = book.next(SESSION, epoch, start + MOVE_EVERY) else {
        panic!("the next move is due");
    };
    assert_eq!(activity, nodes(&[4]));
    assert_eq!(book.next(SESSION, epoch, start + MOVE_EVERY), Step::Done);
    assert!(
        book.offer(origin(), "opencode", nodes(&[5])).is_some(),
        "a finished drain starts again"
    );
}

#[test]
fn a_ring_waits_for_the_cursor_only_while_the_guest_is_on_screen() {
    let mut book = GuestBook::default();
    let start = Instant::now();
    let epoch = book.offer(origin(), "opencode", nodes(&[1])).unwrap();
    let spawn = book
        .shown(
            SESSION,
            epoch,
            Look::Write,
            Some((150.0, 60.0)),
            &[1],
            start,
        )
        .unwrap();
    assert_eq!(
        spawn,
        Shown {
            cursor: Some(json!({
                "id": SESSION,
                "name": "opencode",
                "color": colour_of(SESSION),
                "x": 150.0,
                "y": 60.0,
            })),
            flash: Some((
                json!({ "id": SESSION, "ids": [1], "kind": "write" }),
                Duration::ZERO
            )),
        }
    );
    let glide = book
        .shown(
            SESSION,
            epoch,
            Look::Read,
            Some((1.0, 2.0)),
            &[2],
            start + Duration::from_secs(1),
        )
        .unwrap();
    assert_eq!(
        glide.flash,
        Some((
            json!({ "id": SESSION, "ids": [2], "kind": "read" }),
            FLASH_DELAY
        ))
    );
    let respawn = book
        .shown(
            SESSION,
            epoch,
            Look::Write,
            Some((1.0, 2.0)),
            &[3],
            start + Duration::from_secs(7),
        )
        .unwrap();
    assert_eq!(
        respawn.flash.map(|(_, delay)| delay),
        Some(Duration::ZERO),
        "the editor faded it after 5 s idle"
    );
    let unlocated = book
        .shown(
            SESSION,
            epoch,
            Look::Write,
            None,
            &[4],
            start + Duration::from_secs(8),
        )
        .unwrap();
    assert_eq!(unlocated.cursor, None);
    assert_eq!(
        unlocated.flash.map(|(_, delay)| delay),
        Some(Duration::ZERO)
    );
}

#[test]
fn a_hide_drops_the_guest_and_whatever_was_on_its_way() {
    let mut book = GuestBook::default();
    let start = Instant::now();
    let epoch = book.offer(origin(), "opencode", nodes(&[1])).unwrap();
    assert_eq!(book.hide(SESSION), None, "never shown, nothing to fade");

    let epoch_two = book.offer(origin(), "opencode", nodes(&[1])).unwrap();
    assert_ne!(epoch_two, epoch);
    book.next(SESSION, epoch_two, start);
    book.shown(
        SESSION,
        epoch_two,
        Look::Write,
        Some((1.0, 1.0)),
        &[1],
        start,
    );
    book.offer(origin(), "opencode", nodes(&[2]));
    assert_eq!(
        book.hide(SESSION),
        Some((PROJECT.to_string(), json!({ "id": SESSION })))
    );
    assert_eq!(
        book.next(SESSION, epoch_two, start + MOVE_EVERY),
        Step::Done
    );
    assert_eq!(
        book.shown(
            SESSION,
            epoch_two,
            Look::Write,
            Some((1.0, 1.0)),
            &[2],
            start
        ),
        None,
        "a lookup that finishes after the hide shows nothing"
    );
    assert_eq!(book.hide(SESSION), None);
}

#[test]
fn each_session_keeps_one_palette_colour() {
    let sessions: Vec<String> = (0..64).map(|n| format!("session-{n}")).collect();
    let colours: std::collections::BTreeSet<&str> =
        sessions.iter().map(|session| colour_of(session)).collect();
    assert!(colours.iter().all(|colour| PALETTE.contains(colour)));
    assert!(colours.len() >= 6, "spread over the palette: {colours:?}");
    assert_eq!(colour_of("abc"), colour_of("abc"));
}

// ---- the notices, through the router to a fake renderer ----

async fn next_frame(frames: &Receiver<CanvasCallFrame>) -> (CanvasCallFrame, Instant) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Ok(frame) = frames.try_recv() {
            return (frame, Instant::now());
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("no frame reached the renderer");
}

async fn frames_within(
    frames: &Receiver<CanvasCallFrame>,
    window: Duration,
) -> Vec<CanvasCallFrame> {
    tokio::time::sleep(window).await;
    frames.try_iter().collect()
}

fn params(frame: &CanvasCallFrame) -> Value {
    serde_json::from_str(&frame.params).expect("params are JSON text")
}

/// A mount whose editor answers `node.get` from `answer`.
fn editor(
    answer: impl Fn(&CanvasCallFrame) -> Option<Result<String, CanvasError>> + Send + 'static,
) -> (Arc<CanvasRouter>, Arc<Presence>, Receiver<CanvasCallFrame>) {
    let router = Arc::new(CanvasRouter::default());
    let frames = mount_renderer(&router, "conn-a", PROJECT, 1, answer);
    let presence = Presence::new(Arc::clone(router.mounts()));
    (router, presence, frames)
}

#[tokio::test]
async fn a_created_node_brings_the_named_guest_to_its_centre_and_rings_it() {
    let (_router, presence, frames) = editor(|frame| {
        (frame.method == "node.get")
            .then(|| Ok(node_with_bounds(u64::MAX, 100.0, 40.0).to_string()))
    });
    presence.name_agent("agent-1", " opencode ");
    presence.after_call(
        origin(),
        "create_node",
        EXECUTE,
        &json!({ "command": "node.create", "params": { "type": "rectangle" } }),
        r#"{"id":18446744073709551615}"#,
    );

    let (lookup, _) = next_frame(&frames).await;
    assert_eq!(lookup.method, "node.get");
    assert_eq!(params(&lookup), json!({ "id": u64::MAX, "depth": 0 }));
    let (cursor, _) = next_frame(&frames).await;
    assert_eq!(cursor.method, GUEST_CURSOR);
    assert_eq!(
        params(&cursor),
        json!({ "id": SESSION, "name": "opencode", "color": colour_of(SESSION), "x": 150.0, "y": 60.0 })
    );
    let (flash, _) = next_frame(&frames).await;
    assert_eq!(flash.method, GUEST_FLASH);
    assert!(
        flash.params.contains("18446744073709551615"),
        "u64 ids stay exact"
    );
    assert_eq!(
        params(&flash),
        json!({ "id": SESSION, "ids": [u64::MAX], "kind": "write" })
    );

    presence.hide(SESSION);
    let (hide, _) = next_frame(&frames).await;
    assert_eq!(
        (hide.method.as_str(), params(&hide)),
        (GUEST_HIDE, json!({ "id": SESSION }))
    );
    presence.hide(SESSION);
    assert!(frames_within(&frames, Duration::from_millis(50))
        .await
        .is_empty());
}

#[tokio::test]
async fn a_burst_moves_once_now_and_once_more_to_the_latest_target() {
    let (_router, presence, frames) = editor(|_| None);
    let read = |id: u64| {
        presence.after_call(
            origin(),
            "get_node",
            "node.get",
            &json!({ "id": id, "depth": 1 }),
            &node_with_bounds(id, 1000.0 * f64::from(u32::try_from(id).unwrap()), 0.0).to_string(),
        );
    };
    let first_offered = Instant::now();
    read(1);
    tokio::time::sleep(Duration::from_millis(20)).await;
    for id in 2..=5 {
        read(id);
    }
    let mut cursors = Vec::new();
    let mut flashes = Vec::new();
    while cursors.len() < 2 || flashes.len() < 2 {
        let (frame, at) = next_frame(&frames).await;
        match frame.method.as_str() {
            GUEST_CURSOR => cursors.push((params(&frame)["x"].as_f64().unwrap(), at)),
            GUEST_FLASH => flashes.push((params(&frame)["ids"].clone(), at)),
            other => panic!("no lookup is needed when the result has bounds: {other}"),
        }
    }
    assert_eq!(cursors[0].0, 1050.0);
    assert_eq!(cursors[1].0, 5050.0, "the latest target won");
    assert!(cursors[1].1 - first_offered >= MOVE_EVERY, "paced");
    assert_eq!(flashes[0].0, json!([1]));
    assert!(
        flashes[0].1 - cursors[0].1 < Duration::from_millis(100),
        "first ring at once"
    );
    assert_eq!(flashes[1].0, json!([5]));
    assert!(
        flashes[1].1 - cursors[1].1 >= Duration::from_millis(250),
        "an on-screen guest rings once its cursor arrived"
    );
    assert!(frames_within(&frames, Duration::from_millis(200))
        .await
        .is_empty());
}

#[tokio::test]
async fn a_failed_lookup_moves_no_cursor() {
    let (_router, presence, frames) = editor(|_| {
        Some(Err(CanvasError::new(
            CanvasErrorCode::EngineError,
            "no such layer",
        )))
    });
    presence.after_call(
        origin(),
        "set_properties",
        EXECUTE,
        &json!({ "command": "node.set", "params": { "ids": [3], "props": {} } }),
        "{}",
    );
    let (lookup, _) = next_frame(&frames).await;
    assert_eq!(lookup.method, "node.get");
    let rest = frames_within(&frames, Duration::from_millis(150)).await;
    assert!(
        rest.iter().all(|frame| frame.method != GUEST_CURSOR),
        "{rest:?}"
    );
}

#[tokio::test]
async fn a_call_answered_just_before_the_turn_ended_brings_no_guest_back() {
    let (_router, presence, frames) = editor(|frame| {
        (frame.method == "node.get").then(|| Ok(node_with_bounds(7, 0.0, 0.0).to_string()))
    });
    let create = json!({ "command": "node.create", "params": { "type": "rectangle" } });
    presence.after_call(origin(), "create_node", EXECUTE, &create, r#"{"id":7}"#);
    presence.hide(SESSION);
    let seen = frames_within(&frames, Duration::from_millis(100)).await;
    assert!(seen.is_empty(), "{seen:?}");
    assert!(
        presence.book.lock().guests.is_empty(),
        "no guest outlives the turn"
    );

    presence.after_call(origin(), "create_node", EXECUTE, &create, r#"{"id":7}"#);
    assert_eq!(next_frame(&frames).await.0.method, "node.get");
    assert_eq!(
        next_frame(&frames).await.0.method,
        GUEST_CURSOR,
        "the next turn shows again"
    );
}

#[tokio::test]
async fn nothing_mounted_means_no_presence_work() {
    let router = Arc::new(CanvasRouter::default());
    let presence = Presence::new(Arc::clone(router.mounts()));
    presence.after_call(
        origin(),
        "get_node",
        "node.get",
        &json!({ "id": 1 }),
        &node_with_bounds(1, 0.0, 0.0).to_string(),
    );
    assert!(presence.book.lock().guests.is_empty(), "no guest, no task");
    presence.hide(SESSION);
}

// ---- through the real parent: the agent never waits on presence ----

fn select_editor(
    lookup: Option<Result<String, CanvasError>>,
) -> impl Fn(&CanvasCallFrame) -> Option<Result<String, CanvasError>> + Send + 'static {
    move |frame| match frame.method.as_str() {
        "engine.execute" => Some(Ok("{}".to_string())),
        "document.inspect" => Some(Ok(r#"{"selection":[4]}"#.to_string())),
        "node.get" => lookup.clone(),
        _ => None,
    }
}

#[test]
fn the_agents_call_returns_while_its_presence_lookup_is_unanswered() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let frames = mount_renderer(
        &harness.router(),
        "conn-a",
        "proj-1",
        1,
        select_editor(None),
    );
    let mut bridge = Bridge::new(configs[0].clone()).with_tool("select");
    let started = std::time::Instant::now();
    let result = figcraft_mcp::call_tool(&mut bridge, "select", &json!({ "ids": [4] }));
    assert!(!result.is_error, "{:?}", result.content);
    assert!(
        started.elapsed() < LOOKUP_TIMEOUT,
        "the agent did not wait on presence"
    );
    let mut methods: Vec<String> = (0..3)
        .map(|_| frames.recv_timeout(Duration::from_secs(5)).unwrap().method)
        .collect();
    methods.sort();
    assert_eq!(
        methods,
        ["document.inspect", "engine.execute", "node.get"],
        "the presence node.get went out and stays unanswered"
    );
}

#[test]
fn a_failing_presence_lookup_never_reaches_the_agent() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let failing = Some(Err(CanvasError::new(CanvasErrorCode::EngineError, "boom")));
    let frames = mount_renderer(
        &harness.router(),
        "conn-a",
        "proj-1",
        1,
        select_editor(failing),
    );
    let mut bridge = Bridge::new(configs[0].clone()).with_tool("select");
    for _ in 0..3 {
        let result = figcraft_mcp::call_tool(&mut bridge, "select", &json!({ "ids": [4] }));
        assert!(!result.is_error, "{:?}", result.content);
        assert!(result.content[0]["text"].as_str().unwrap().contains('4'));
    }
    let seen: Vec<String> = frames.try_iter().map(|frame| frame.method).collect();
    assert!(seen.contains(&"engine.execute".to_string()), "{seen:?}");
}

#[test]
fn the_guest_fades_when_the_turn_ends_and_when_the_session_closes() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let frames = mount_renderer(&harness.router(), "conn-a", "proj-1", 1, |frame| {
        Some(Ok(match frame.method.as_str() {
            "engine.execute" => r#"{"result":{"id":7},"issues":[]}"#.to_string(),
            _ => node_with_bounds(7, 0.0, 0.0).to_string(),
        }))
    });
    let server = harness.server();
    server.name_agent("agent-0", "Claude");
    let mut bridge = Bridge::new(configs[0].clone()).with_tool("create_node");
    let draw = |bridge: &mut Bridge| {
        let result =
            figcraft_mcp::call_tool(bridge, "create_node", &json!({ "type": "rectangle" }));
        assert!(!result.is_error, "{:?}", result.content);
    };
    let until = |method: &str| loop {
        let frame = frames.recv_timeout(Duration::from_secs(5)).expect(method);
        if frame.method == method {
            return params(&frame);
        }
    };

    draw(&mut bridge);
    assert_eq!(until(GUEST_CURSOR)["name"], "Claude");
    server.end_turn("agent-0", "sess-1");
    assert_eq!(until(GUEST_HIDE), json!({ "id": "sess-1" }));

    server.begin_turn("agent-0", "sess-1");
    draw(&mut bridge);
    assert_eq!(until(GUEST_CURSOR)["id"], "sess-1");
    server.unregister_session("sess-1");
    assert_eq!(until(GUEST_HIDE), json!({ "id": "sess-1" }));
}

#[tokio::test]
async fn the_agents_reply_goes_back_before_presence_reads_the_result() {
    let (_router, presence, _frames) = editor(|_| None);
    presence.after_call(
        origin(),
        "create_node",
        EXECUTE,
        &json!({ "command": "node.create", "params": { "type": "rectangle" } }),
        r#"{"id":7}"#,
    );
    assert!(
        presence.book.lock().guests.is_empty(),
        "nothing is derived on the caller's path"
    );
    tokio::task::yield_now().await;
    assert!(
        presence.book.lock().guests.contains_key(SESSION),
        "the activity is derived once the reply has gone"
    );
}

#[tokio::test]
async fn a_result_past_the_parse_limit_is_not_read() {
    let (_router, presence, _frames) = editor(|_| None);
    let huge = format!(
        r#"{{"id":7,"pad":"{}"}}"#,
        "x".repeat(super::RESULT_PARSE_LIMIT)
    );
    presence.after_call(
        origin(),
        "create_node",
        EXECUTE,
        &json!({ "command": "node.create", "params": { "type": "rectangle" } }),
        &huge,
    );
    tokio::task::yield_now().await;
    assert!(
        presence.book.lock().guests.is_empty(),
        "the id lived only in the result, which was too large to read"
    );
}

#[test]
fn an_agent_that_exits_leaves_no_name_behind() {
    let presence = Presence::new(Arc::new(CanvasPersistence::default()));
    presence.name_agent("agent-1", "opencode");
    presence.name_agent("agent-2", "claude");
    presence.forget_agent("agent-1");
    let names = presence.names.lock();
    assert_eq!(names.len(), 1);
    assert!(names.contains_key("agent-2"));
}
