//! Cases for content the main document does not hold itself: same- and
//! cross-origin frames, open and closed shadow roots, and a page whose
//! Content-Security-Policy forbids every script. Sensitive actions and file
//! choosers inside a cross-origin frame meet the same gates as on the page.

use std::time::{Duration, Instant};

use serde_json::json;
use termul_manager_lib::conformance_support::ActionClass;

use super::{expect_code, find_ref, mismatch, CaseResult, Ctx, Failure};
use crate::adapter::{Scope, UPLOAD_BODY, UPLOAD_FILE};
use crate::sensitive_cases::{asking_before_passwords, expect_refusal, expect_tickets};

const FRAMES_READY: &str = "Frames ready";
const SHADOW_READY: &str = "Shadow fixture ready";
const CSP_READY: &str = "CSP fixture ready";
/// The outline marker for a frame the engine cannot read.
const UNREACHABLE: &str = "(cross-origin frame, not readable on this engine)";
const FRAME_WAIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(250);

impl Ctx<'_> {
    /// Snapshot until `line` shows (frames load after their parent), or
    /// the wait runs out. Returns the last outline.
    async fn outline_with(&self, line: &str) -> Result<String, Failure> {
        let until = Instant::now() + FRAME_WAIT;
        loop {
            let text = self.snapshot().await?.text;
            if text.contains(line) || Instant::now() > until {
                return Ok(text);
            }
            tokio::time::sleep(POLL).await;
        }
    }

    /// Fill the inner field, press the inner button, and expect the frame
    /// to report both.
    async fn act_inside(&self, field: (&str, &str), button: (&str, &str), done: &str) -> CaseResult {
        let outline = self.outline_with(&format!("- {} \"{}\" @e", button.0, button.1)).await?;
        let field_ref = find_ref(&outline, field.0, field.1)
            .ok_or_else(|| mismatch(format!("no {} \"{}\" ref in {outline}", field.0, field.1)))?;
        self.call("fill", json!({ "ref": field_ref, "value": "Ada" })).await?;
        self.click(button.0, button.1).await?;
        let after = self.outline_with(done).await?;
        if after.contains(done) {
            Ok(())
        } else {
            Err(mismatch(format!("after fill and click the outline lacks `{done}`: {after}")))
        }
    }

    /// Reload the frame from its parent, then expect a ref minted before
    /// the reload to be stale.
    async fn stale_after_frame_reload(&self, button: &str) -> CaseResult {
        let outline = self.snapshot().await?.text;
        let old = find_ref(&outline, "button", button).ok_or_else(|| mismatch(format!("no {button} ref")))?;
        self.click("button", "Reload frame").await?;
        let until = Instant::now() + FRAME_WAIT;
        loop {
            let attempt = self.call("click", json!({ "ref": old })).await;
            match attempt {
                Err(f) if f.code == "stale_ref" => return Ok(()),
                _ if Instant::now() > until => {
                    return expect_code(attempt, "stale_ref", "click on a ref from before the frame reloaded");
                }
                _ => tokio::time::sleep(POLL).await,
            }
        }
    }
}

pub async fn iframe_same_origin(c: &Ctx<'_>) -> CaseResult {
    c.open("/frames-same.html", FRAMES_READY).await?;
    c.act_inside(("textbox", "Inner field"), ("button", "Inner button"), "Inner result: clicked [Ada]")
        .await?;
    let outline = c.snapshot().await?.text;
    if !outline.contains("- iframe \"Same frame\"") {
        return Err(mismatch(format!("the outline does not show the frame: {outline}")));
    }
    c.stale_after_frame_reload("Inner button").await
}

/// Open fixture `page` in a cross-origin frame and wait for `line` in the
/// outline. Engines that cannot reach the frame must say so in the outline
/// and mint no ref inside it; that is reported as unavailable.
async fn cross_frame(c: &Ctx<'_>, page: &str, line: &str) -> Result<String, Failure> {
    let path = format!("/frames-cross.html?xo={}&page={page}", c.cross.port());
    c.open(&path, FRAMES_READY).await?;
    let outline = c.outline_with(line).await?;
    if outline.contains(UNREACHABLE) && !outline.contains(line) {
        return Err(Failure {
            code: "capability_unavailable".into(),
            reason: Some("cross_origin_frame".into()),
            message: "this engine cannot read cross-origin frames".into(),
        });
    }
    Ok(outline)
}

fn ref_in(outline: &str, role: &str, name: &str) -> Result<String, Failure> {
    find_ref(outline, role, name).ok_or_else(|| mismatch(format!("no {role} \"{name}\" ref in {outline}")))
}

pub async fn iframe_cross_origin(c: &Ctx<'_>) -> CaseResult {
    cross_frame(c, "frame-inner.html", "Inner button").await?;
    c.act_inside(("textbox", "Inner field"), ("button", "Inner button"), "Inner result: clicked [Ada]")
        .await?;
    c.stale_after_frame_reload("Inner button").await
}

/// A password submit inside a cross-origin frame is classified from the
/// frame's own form.
pub async fn frame_password_submit(c: &Ctx<'_>) -> CaseResult {
    asking_before_passwords(c, frame_password_submit_asked(c)).await
}

async fn frame_password_submit_asked(c: &Ctx<'_>) -> CaseResult {
    let outline = cross_frame(c, "password.html", "Sign in").await?;
    let submit = ref_in(&outline, "button", "Sign in")?;
    expect_refusal(
        c.call("click", json!({ "ref": submit })).await,
        "confirmation_required",
        "unattended",
        "password submit in a cross-origin frame",
    )?;
    expect_tickets(c, &[ActionClass::PasswordSubmit], "frame password submit")
}

/// Enter without a ref goes to whatever has focus, here a field of a
/// cross-origin frame the page's own helpers cannot read: it is
/// confirmed as a credential submit.
pub async fn frame_focused_password_submit(c: &Ctx<'_>) -> CaseResult {
    asking_before_passwords(c, frame_focused_password_submit_asked(c)).await
}

async fn frame_focused_password_submit_asked(c: &Ctx<'_>) -> CaseResult {
    let outline = cross_frame(c, "password.html", "Sign in").await?;
    let user = ref_in(&outline, "textbox", "User")?;
    c.call("fill", json!({ "ref": user, "value": "ada" })).await?;
    expect_refusal(
        c.call("press", json!({ "key": "Enter" })).await,
        "confirmation_required",
        "unattended",
        "Enter on a field focused in a cross-origin frame",
    )?;
    expect_tickets(c, &[ActionClass::PasswordSubmit], "focused password submit in a cross-origin frame")
}

/// A key without a ref goes to the field focused inside a cross-origin
/// frame, once the host authorized the frame's origin.
pub async fn frame_focused_key(c: &Ctx<'_>) -> CaseResult {
    let outline = cross_frame(c, "frame-inner.html", "Inner button").await?;
    let field = ref_in(&outline, "textbox", "Inner field")?;
    c.call("fill", json!({ "ref": field, "value": "Ada" })).await?;
    c.call("press", json!({ "key": "x" })).await?;
    c.click("button", "Inner button").await?;
    let done = "Inner result: clicked [Adax]";
    let after = c.outline_with(done).await?;
    if after.contains(done) {
        Ok(())
    } else {
        Err(mismatch(format!("the key did not reach the focused frame: {after}")))
    }
}

/// An upload pre-approved for the frame's origin runs without a prompt and
/// lands on the frame's own file input.
pub async fn frame_upload(c: &Ctx<'_>) -> CaseResult {
    c.engine.go_ephemeral(&c.session).await.map_err(mismatch)?;
    let outline = cross_frame(c, "upload.html", "Attachment").await?;
    let frame_origin = format!("http://localhost:{}", c.cross.port());
    c.engine
        .preapprove(&c.session, Scope::Project, ActionClass::Upload, &frame_origin)
        .await
        .map_err(mismatch)?;
    let input = ref_in(&outline, "textbox", "Attachment")?;
    c.call("upload", json!({ "ref": input, "path": UPLOAD_FILE })).await?;
    let picked = format!("Picked: {UPLOAD_FILE} ({} bytes)", UPLOAD_BODY.len());
    let after = c.outline_with(&picked).await?;
    if !after.contains(&picked) {
        return Err(mismatch(format!("the frame's input did not get the file: {after}")));
    }
    expect_tickets(c, &[], "an upload pre-approved for the frame's origin")
}

/// A chooser a cross-origin frame opens is cancelled like the page's own.
pub async fn frame_file_chooser(c: &Ctx<'_>) -> CaseResult {
    let outline = cross_frame(c, "upload.html", "Open the file chooser").await?;
    let open = ref_in(&outline, "button", "Open the file chooser")?;
    c.call("click", json!({ "ref": open })).await?;
    let after = c.outline_with("Chooser: cancelled").await?;
    if !after.contains("Chooser: cancelled") {
        return Err(mismatch(format!("the frame's chooser was not cancelled: {after}")));
    }
    expect_tickets(c, &[], "a frame-opened file chooser")
}

/// A frame on an origin the perimeter denies (here a `data:` document,
/// whose origin is opaque) is never read, on engines that reach
/// cross-origin frames as on those that do not.
pub async fn frame_denied_origin(c: &Ctx<'_>) -> CaseResult {
    c.open("/frames-data.html", "Data frame ready").await?;
    let outline = c.outline_with("- iframe \"Data frame\"").await?;
    if !outline.contains("- iframe \"Data frame\"") {
        return Err(mismatch(format!("the outline does not show the frame: {outline}")));
    }
    if outline.contains("Data button") {
        return Err(mismatch(format!("a frame on a denied origin was read: {outline}")));
    }
    expect_tickets(c, &[], "reading a page with a denied frame")
}

pub async fn shadow_dom(c: &Ctx<'_>) -> CaseResult {
    c.open("/shadow.html", SHADOW_READY).await?;
    let outline = c.snapshot().await?.text;
    for line in ["- button \"Slotted button\" @e", "- textbox \"Shadow field\" @e"] {
        if !outline.contains(line) {
            return Err(mismatch(format!("the outline lacks `{line}`: {outline}")));
        }
    }
    if outline.contains("Closed button") {
        return Err(mismatch(format!("a closed shadow root was read: {outline}")));
    }
    c.act_inside(("textbox", "Shadow field"), ("button", "Shadow button"), "Shadow result: clicked [Ada]")
        .await
}

pub async fn csp_snapshot(c: &Ctx<'_>) -> CaseResult {
    c.open("/csp.html", CSP_READY).await?;
    let snap = c.snapshot().await?;
    if snap.title != "CSP fixture" {
        return Err(mismatch(format!("the page policy let a script run (title {})", snap.title)));
    }
    c.click("button", "CSP submit").await?;
    c.call("wait", json!({ "text": "Form done" })).await?;
    Ok(())
}
