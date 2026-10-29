//! Engine-neutral CDP logic over a [`CdpTransport`]. WebView2's
//! `CallDevToolsProtocolMethod` is the only transport today; a future
//! CDP-speaking runtime reuses this module unchanged.
//!
//! Helpers run in an isolated world of the main frame: the page shares
//! its DOM with that world but none of its globals, prototypes or
//! wrappers, and their value comes back as the call's own return value.

use serde_json::{json, Value};

use super::assets::{self, Script, WORLD_NAME};
use super::{EngineError, EngineErrorKind, EngineFuture, Point};

pub mod observe;
pub mod input;

/// Closed CDP method allow-list: a transport can issue nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CdpMethod {
    PageGetFrameTree,
    PageCreateIsolatedWorld,
    RuntimeCallFunctionOn,
    InputDispatchMouseEvent,
    InputDispatchKeyEvent,
    InputInsertText,
    PageCaptureScreenshot,
    DomGetFrameOwner,
    DomResolveNode,
    RuntimeEnable,
    LogEnable,
    NetworkEnable,
    TargetSetAutoAttach,
    DomSetFileInputFiles,
    PageEnable,
    PageSetInterceptFileChooserDialog,
}

impl CdpMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            CdpMethod::PageGetFrameTree => "Page.getFrameTree",
            CdpMethod::PageCreateIsolatedWorld => "Page.createIsolatedWorld",
            CdpMethod::RuntimeCallFunctionOn => "Runtime.callFunctionOn",
            CdpMethod::InputDispatchMouseEvent => "Input.dispatchMouseEvent",
            CdpMethod::InputDispatchKeyEvent => "Input.dispatchKeyEvent",
            CdpMethod::InputInsertText => "Input.insertText",
            CdpMethod::PageCaptureScreenshot => "Page.captureScreenshot",
            CdpMethod::DomGetFrameOwner => "DOM.getFrameOwner",
            CdpMethod::DomResolveNode => "DOM.resolveNode",
            CdpMethod::RuntimeEnable => "Runtime.enable",
            CdpMethod::LogEnable => "Log.enable",
            CdpMethod::NetworkEnable => "Network.enable",
            CdpMethod::TargetSetAutoAttach => "Target.setAutoAttach",
            CdpMethod::DomSetFileInputFiles => "DOM.setFileInputFiles",
            CdpMethod::PageEnable => "Page.enable",
            CdpMethod::PageSetInterceptFileChooserDialog => "Page.setInterceptFileChooserDialog",
        }
    }
}

/// Issues one CDP command against a tab and resolves with the raw JSON
/// result object.
pub trait CdpTransport: Send + Sync {
    fn call<'a>(&'a self, tab: &'a str, method: CdpMethod, params: Value)
        -> EngineFuture<'a, Value>;
    /// The same command on a child frame's own session (`frame` is its
    /// frame id); `None` is the page itself.
    fn call_in<'a>(
        &'a self,
        tab: &'a str,
        frame: Option<&'a str>,
        method: CdpMethod,
        params: Value,
    ) -> EngineFuture<'a, Value> {
        match frame {
            None => self.call(tab, method, params),
            Some(_) => Box::pin(async { Err(EngineError::new(EngineErrorKind::Unsupported)) }),
        }
    }
}

/// `Runtime.callFunctionOn` params: the helper as a function of one
/// argument, called in the isolated context with its parameters passed by
/// value. `returnByValue` ships the result back as JSON.
pub fn call_params(script: &Script, context_id: i64) -> Value {
    json!({
        "functionDeclaration": format!("function (p) {{\n{}\n}}", script.helper.body),
        "executionContextId": context_id,
        "arguments": [{ "value": script.params }],
        "returnByValue": true,
        "awaitPromise": true,
    })
}

/// [`call_params`] with the helper bound to a remote object (`this`)
/// instead of run in a context.
pub fn bound_call_params(script: &Script, object_id: &str) -> Value {
    let mut params = call_params(script, 0);
    if let Some(map) = params.as_object_mut() {
        map.remove("executionContextId");
        map.insert("objectId".into(), json!(object_id));
    }
    params
}

/// Parse a `Runtime.callFunctionOn` reply: the return value (an absent
/// `value` key means `undefined`, read as null), or a
/// terminal failure. Protocol errors, page exceptions and malformed
/// replies all mean the command was processed, so the script may have run.
pub fn parse_evaluate_result(out: &Value) -> Result<Value, EngineError> {
    if out.get("error").is_some_and(Value::is_object) {
        return Err(EngineError::new(EngineErrorKind::Protocol));
    }
    // A JSON `null` exceptionDetails must not enter the exception branch.
    if out.get("exceptionDetails").is_some_and(Value::is_object) {
        return Err(EngineError::new(EngineErrorKind::PageException));
    }
    match out.get("result") {
        Some(r) if r.is_object() => Ok(r.get("value").cloned().unwrap_or(Value::Null)),
        _ => Err(EngineError::new(EngineErrorKind::Malformed)),
    }
}

/// The main frame's id from a `Page.getFrameTree` reply.
pub fn main_frame_id(tree: &Value) -> Option<&str> {
    tree.pointer("/frameTree/frame/id").and_then(Value::as_str)
}

/// The isolated world's context id from a `Page.createIsolatedWorld` reply.
pub fn world_context_id(world: &Value) -> Option<i64> {
    world.get("executionContextId").and_then(Value::as_i64)
}

/// Run `script` in the main frame's isolated world. The world is looked
/// up per call: each new document gets a new context, and asking for the
/// named world again returns the current document's one.
pub async fn evaluate(
    transport: &dyn CdpTransport,
    tab: &str,
    script: &Script,
) -> Result<Value, EngineError> {
    evaluate_in(transport, tab, None, script).await
}

/// [`evaluate`] in `frame`'s own isolated world. The transport routes a
/// frame's calls to the session that hosts it: the frame's own session
/// for an out-of-process frame, else the page's.
pub async fn evaluate_in(
    transport: &dyn CdpTransport,
    tab: &str,
    frame: Option<&str>,
    script: &Script,
) -> Result<Value, EngineError> {
    let context = isolated_context(transport, tab, frame).await?;
    let out = transport
        .call_in(tab, frame, CdpMethod::RuntimeCallFunctionOn, call_params(script, context))
        .await?;
    parse_evaluate_result(&out)
}

async fn isolated_context(transport: &dyn CdpTransport, tab: &str, frame: Option<&str>) -> Result<i64, EngineError> {
    let malformed = EngineError::new(EngineErrorKind::Malformed);
    let id = match frame {
        Some(id) => id.to_string(),
        None => {
            let tree = transport.call(tab, CdpMethod::PageGetFrameTree, json!({})).await?;
            main_frame_id(&tree).ok_or(malformed)?.to_string()
        }
    };
    let world = transport
        .call_in(
            tab,
            frame,
            CdpMethod::PageCreateIsolatedWorld,
            json!({ "frameId": id, "worldName": WORLD_NAME }),
        )
        .await
        // The engine refuses a world for a frame it no longer has.
        .map_err(|e| match (frame, e.kind) {
            (Some(_), EngineErrorKind::Protocol) => EngineError::new(EngineErrorKind::FrameGone),
            _ => e,
        })?;
    world_context_id(&world).ok_or(malformed)
}

/// Every in-process frame below the page's main frame in a
/// `Page.getFrameTree` reply, with its parent (`None`: the main frame).
pub fn child_frames(tree: &Value) -> Vec<(String, Option<String>)> {
    fn walk(node: &Value, parent: Option<&str>, out: &mut Vec<(String, Option<String>)>) {
        let Some(id) = node.pointer("/frame/id").and_then(Value::as_str) else {
            return;
        };
        if let Some(children) = node.get("childFrames").and_then(Value::as_array) {
            for child in children {
                if let Some(child_id) = child.pointer("/frame/id").and_then(Value::as_str) {
                    out.push((child_id.to_string(), parent.map(|_| id.to_string())));
                }
                walk(child, Some(id), out);
            }
        }
    }
    let mut out = Vec::new();
    if let Some(root) = tree.get("frameTree") {
        walk(root, None, &mut out);
    }
    out
}

/// The helper locator of `child`'s frame element, read in the isolated
/// world of `parent` (`None`: the page).
pub async fn owner_path(
    transport: &dyn CdpTransport,
    tab: &str,
    parent: Option<&str>,
    child: &str,
) -> Result<String, EngineError> {
    let malformed = EngineError::new(EngineErrorKind::Malformed);
    let owner = transport
        .call_in(tab, parent, CdpMethod::DomGetFrameOwner, json!({ "frameId": child }))
        .await?;
    let node = owner.get("backendNodeId").and_then(Value::as_i64).ok_or(malformed)?;
    let context = isolated_context(transport, tab, parent).await?;
    let resolved = transport
        .call_in(
            tab,
            parent,
            CdpMethod::DomResolveNode,
            json!({ "backendNodeId": node, "executionContextId": context }),
        )
        .await?;
    let object = resolved.pointer("/object/objectId").and_then(Value::as_str).ok_or(malformed)?;
    let script = assets::owner_path();
    let out = transport
        .call_in(
            tab,
            parent,
            CdpMethod::RuntimeCallFunctionOn,
            bound_call_params(&script, object),
        )
        .await?;
    match parse_evaluate_result(&out)? {
        Value::String(path) if !path.is_empty() => Ok(path),
        _ => Err(malformed),
    }
}

/// The calls that cancel every file chooser a session's documents open,
/// so the native dialog never shows and the page sees a cancel. Each
/// out-of-process frame's session needs its own: the engine asks the
/// session hosting the frame. The interception is consulted only while
/// the Page domain is enabled on that session.
pub fn file_chooser_calls() -> [(CdpMethod, Value); 2] {
    [
        (CdpMethod::PageEnable, json!({})),
        (
            CdpMethod::PageSetInterceptFileChooserDialog,
            json!({ "enabled": true, "cancel": true }),
        ),
    ]
}

/// Set `files` on the file input at `path` in `frame`'s isolated world
/// (`None`: the main frame's) through `DOM.setFileInputFiles`: the helper
/// hands back the element itself, by reference.
pub async fn set_input_files(
    transport: &dyn CdpTransport,
    tab: &str,
    frame: Option<&str>,
    path: &str,
    files: &[std::path::PathBuf],
) -> Result<(), EngineError> {
    let context = isolated_context(transport, tab, frame).await?;
    let mut params = call_params(&assets::file_input(path), context);
    params["returnByValue"] = Value::Bool(false);
    let out = transport
        .call_in(tab, frame, CdpMethod::RuntimeCallFunctionOn, params)
        .await?;
    let element = file_input_object(&out)?;
    let files: Vec<String> = files.iter().map(|f| f.to_string_lossy().into_owned()).collect();
    transport
        .call_in(
            tab,
            frame,
            CdpMethod::DomSetFileInputFiles,
            json!({ "files": files, "objectId": element }),
        )
        .await?;
    Ok(())
}

/// The element handle a by-reference helper call returned. Anything but a
/// DOM node means the path named no file input.
pub fn file_input_object(out: &Value) -> Result<String, EngineError> {
    if out.get("exceptionDetails").is_some_and(Value::is_object) {
        return Err(EngineError::new(EngineErrorKind::PageException));
    }
    let result = out.get("result");
    match (
        result.and_then(|r| r.get("subtype")).and_then(Value::as_str),
        result.and_then(|r| r.get("objectId")).and_then(Value::as_str),
    ) {
        (Some("node"), Some(id)) => Ok(id.to_string()),
        _ => Err(EngineError::new(EngineErrorKind::PageException)),
    }
}

/// Trusted left click at `at` via `Input.dispatchMouseEvent`.
pub async fn click_at(
    transport: &dyn CdpTransport,
    tab: &str,
    at: Point,
) -> Result<(), EngineError> {
    for kind in ["mousePressed", "mouseReleased"] {
        transport
            .call(
                tab,
                CdpMethod::InputDispatchMouseEvent,
                json!({
                    "type": kind,
                    "x": at.x,
                    "y": at.y,
                    "button": "left",
                    "clickCount": 1,
                }),
            )
            .await?;
    }
    Ok(())
}

/// `Page.captureScreenshot` → PNG bytes.
pub async fn capture_screenshot(
    transport: &dyn CdpTransport,
    tab: &str,
) -> Result<Vec<u8>, EngineError> {
    let out = transport
        .call(tab, CdpMethod::PageCaptureScreenshot, json!({ "format": "png" }))
        .await?;
    decode_screenshot(&out)
}

/// Decode a `Page.captureScreenshot` reply's base64 `data`.
pub fn decode_screenshot(out: &Value) -> Result<Vec<u8>, EngineError> {
    use base64::Engine;
    let b64 = out
        .get("data")
        .and_then(Value::as_str)
        .ok_or(EngineError::new(EngineErrorKind::Malformed))?;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| EngineError::new(EngineErrorKind::Malformed))
}

#[cfg(test)]
mod tests;
