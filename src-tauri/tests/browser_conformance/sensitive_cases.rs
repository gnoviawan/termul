//! Sensitive-action cases: the host classifies each from the page, asks
//! for confirmation (answered as unattended here), honours pre-approvals
//! at the scope of the tab's profile, refuses secret or out-of-project
//! uploads, and lands downloads under app data with host-chosen names and
//! the OS's mark.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::json;
use termul_manager_lib::conformance_support::ActionClass;

use crate::adapter::{Scope, LINKED_FILE, SECRET_FILE, SWAPPED_FILE, UPLOAD_BODY, UPLOAD_FILE};
use crate::cases::{mismatch, CaseResult, Ctx, Failure};

const PASSWORD_READY: &str = "Password fixture";
const SHADOW_PASSWORD_READY: &str = "Shadow password fixture";
const UPLOAD_READY: &str = "Upload fixture";
const DOWNLOAD_READY: &str = "Download fixture";
const DOWNLOAD_WAIT: Duration = Duration::from_secs(15);
/// Long enough for a streamed body to pass the cap, far short of the
/// announced body's full trickle.
const BIG_DOWNLOAD_WAIT: Duration = Duration::from_secs(60);
const BIG_DOWNLOAD_SETTLE: Duration = Duration::from_secs(3);

fn origin(c: &Ctx<'_>) -> String {
    c.fixtures.url("").trim_end_matches('/').to_string()
}

/// The call failed with `code` and `reason`. A failure with another code
/// is the case's result as it is, so an engine without the verb reports
/// `capability_unavailable`.
pub(crate) fn expect_refusal(
    result: Result<serde_json::Value, Failure>,
    code: &str,
    reason: &str,
    what: &str,
) -> CaseResult {
    match result {
        Err(f) if f.code == code && f.reason.as_deref() == Some(reason) => Ok(()),
        Err(f) if f.code != code => Err(f),
        Err(f) => Err(mismatch(format!(
            "{what}: expected {code}/{reason}, got {}/{:?}",
            f.code, f.reason
        ))),
        Ok(_) => Err(mismatch(format!(
            "{what}: expected {code}/{reason}, call succeeded"
        ))),
    }
}

pub(crate) fn expect_tickets(c: &Ctx<'_>, expected: &[ActionClass], what: &str) -> CaseResult {
    let raised: Vec<ActionClass> = c
        .engine
        .tickets(&c.session)
        .iter()
        .map(|t| t.action)
        .collect();
    if raised == expected {
        Ok(())
    } else {
        Err(mismatch(format!(
            "{what}: tickets {raised:?}, expected {expected:?}"
        )))
    }
}

/// Open `path` on a tab of `profile` ("global" or "ephemeral").
async fn open_on(c: &Ctx<'_>, profile: &str, path: &str, ready: &str) -> CaseResult {
    if profile == "ephemeral" {
        c.engine.go_ephemeral(&c.session).await.map_err(mismatch)?;
    }
    let reply = c.navigate(path).await?;
    if reply["tab"]["profile"] != profile {
        return Err(mismatch(format!(
            "the tab runs on the {} profile, not {profile}",
            reply["tab"]["profile"]
        )));
    }
    c.call("wait", json!({ "text": ready })).await.map(|_| ())
}

/// Run `body` with the app asking before password submits, then turn the
/// switch off whatever `body` returned, so no later case inherits it.
pub(crate) async fn asking_before_passwords(
    c: &Ctx<'_>,
    body: impl std::future::Future<Output = CaseResult>,
) -> CaseResult {
    c.engine.ask_before_passwords(true).await.map_err(mismatch)?;
    let result = body.await;
    c.engine.ask_before_passwords(false).await.map_err(mismatch)?;
    result
}

async fn preapprove(c: &Ctx<'_>, scope: Scope, action: ActionClass) -> CaseResult {
    c.engine
        .preapprove(&c.session, scope, action, &origin(c))
        .await
        .map_err(mismatch)
}

async fn click_sign_in(c: &Ctx<'_>) -> Result<serde_json::Value, Failure> {
    let submit = c.ref_of("button", "Sign in").await?;
    c.call("click", json!({ "ref": submit })).await
}

/// Signing in is the agent's to do by default, on either profile.
pub async fn password_submit(c: &Ctx<'_>) -> CaseResult {
    open_on(c, "ephemeral", "/password.html", PASSWORD_READY).await?;
    click_sign_in(c).await?;
    c.call("wait", json!({ "text": "Form done" })).await?;
    expect_tickets(c, &[], "password submit")
}

pub async fn password_submit_global(c: &Ctx<'_>) -> CaseResult {
    open_on(c, "global", "/password.html", PASSWORD_READY).await?;
    click_sign_in(c).await?;
    c.call("wait", json!({ "text": "Form done" })).await?;
    expect_tickets(c, &[], "global password submit")
}

/// With the app asking before password submits, one prompts, and a
/// project pre-approval covers it on an ephemeral tab only.
pub async fn password_submit_asked(c: &Ctx<'_>) -> CaseResult {
    asking_before_passwords(c, asked_password_submit(c)).await
}

async fn asked_password_submit(c: &Ctx<'_>) -> CaseResult {
    open_on(c, "global", "/password.html", PASSWORD_READY).await?;
    preapprove(c, Scope::Project, ActionClass::PasswordSubmit).await?;
    expect_refusal(
        click_sign_in(c).await,
        "confirmation_required",
        "unattended",
        "asked password submit on the global profile",
    )?;
    expect_tickets(c, &[ActionClass::PasswordSubmit], "asked password submit")?;
    c.expect_url("/password.html", "the refused submit").await
}

pub async fn tainted_navigation(c: &Ctx<'_>) -> CaseResult {
    c.open("/form.html", "Conformance form").await?;
    c.snapshot().await?;
    let away = format!(
        "http://localhost:{}/index.html?d=page-data",
        c.fixtures.port()
    );
    let reply = c.call("navigate", json!({ "url": away })).await;
    expect_refusal(
        reply,
        "confirmation_required",
        "unattended",
        "tainted cross-origin navigation",
    )?;
    expect_tickets(c, &[ActionClass::TaintedExfil], "tainted navigation")?;
    c.call(
        "navigate",
        json!({ "url": c.fixtures.url("/index.html?q=1") }),
    )
    .await
    .map(|_| ())
}

pub async fn upload(c: &Ctx<'_>) -> CaseResult {
    open_on(c, "ephemeral", "/upload.html", UPLOAD_READY).await?;
    let input = c.ref_of("textbox", "Attachment").await?;
    let reply = c
        .call("upload", json!({ "ref": input, "path": UPLOAD_FILE }))
        .await;
    expect_refusal(reply, "confirmation_required", "unattended", "upload")?;
    expect_tickets(c, &[ActionClass::Upload], "upload")?;

    preapprove(c, Scope::Project, ActionClass::Upload).await?;
    let input = c.ref_of("textbox", "Attachment").await?;
    let reply = c
        .call("upload", json!({ "ref": input, "path": UPLOAD_FILE }))
        .await?;
    if reply["fidelity"] != "trusted" {
        return Err(mismatch(format!(
            "upload fidelity is {}",
            reply["fidelity"]
        )));
    }
    expect_tickets(c, &[ActionClass::Upload], "pre-approved upload")?;
    c.expect_text(&format!(
        "Picked: {UPLOAD_FILE} ({} bytes)",
        UPLOAD_BODY.len()
    ))
    .await
}

pub async fn upload_refusals(c: &Ctx<'_>) -> CaseResult {
    c.open("/upload.html", UPLOAD_READY).await?;
    let input = c.ref_of("textbox", "Attachment").await?;
    let secret = c
        .call("upload", json!({ "ref": input, "path": SECRET_FILE }))
        .await;
    expect_refusal(secret, "invalid_params", "secret_file", "secret upload")?;
    if !c.engine.has_symlink() {
        println!(
            "upload_refusals: symlinks cannot be created here; the symlink checks are unit-tested"
        );
        return expect_tickets(c, &[], "refused uploads");
    }
    let linked = c
        .call("upload", json!({ "ref": input, "path": LINKED_FILE }))
        .await;
    expect_refusal(
        linked,
        "invalid_params",
        "outside_project_root",
        "symlinked upload",
    )?;
    expect_tickets(c, &[], "refused uploads")?;

    c.engine.swap_upload_while_asking(&c.session);
    let swapped = c
        .call("upload", json!({ "ref": input, "path": SWAPPED_FILE }))
        .await;
    expect_refusal(
        swapped,
        "invalid_params",
        "outside_project_root",
        "upload swapped for a symlink while awaiting consent",
    )?;
    expect_tickets(c, &[ActionClass::Upload], "swapped upload")?;
    c.expect_text("Picked: none").await
}

/// Enter on a submit button focused inside a shadow root submits its
/// password form, so it is classified from that button, not the shadow
/// host the document reports as focused.
pub async fn focused_password_submit(c: &Ctx<'_>) -> CaseResult {
    asking_before_passwords(c, focused_password_submit_asked(c)).await
}

async fn focused_password_submit_asked(c: &Ctx<'_>) -> CaseResult {
    c.open("/password-shadow.html", SHADOW_PASSWORD_READY).await?;
    expect_refusal(
        c.call("press", json!({ "key": "Enter" })).await,
        "confirmation_required",
        "unattended",
        "Enter on a focused shadow-root submit",
    )?;
    expect_tickets(c, &[ActionClass::PasswordSubmit], "focused password submit")?;
    c.expect_url("/password-shadow.html", "the refused submit").await
}

/// `check` on a submit styled as a switch clicks it, so it submits the
/// password form like any click. The form also holds fields named
/// `elements` and `nodeType`, which shadow those properties of the form for
/// every script.
pub async fn check_password_submit(c: &Ctx<'_>) -> CaseResult {
    asking_before_passwords(c, check_password_submit_asked(c)).await
}

async fn check_password_submit_asked(c: &Ctx<'_>) -> CaseResult {
    c.open("/password-switch.html", "Password switch fixture").await?;
    let switch = c.ref_of("switch", "Remember me and sign in").await?;
    expect_refusal(
        c.call("check", json!({ "ref": switch })).await,
        "confirmation_required",
        "unattended",
        "check on a switch-styled password submit",
    )?;
    expect_tickets(c, &[ActionClass::PasswordSubmit], "check password submit")?;
    c.expect_url("/password-switch.html", "the refused submit").await
}

/// A login without a form, submitted by its page script, is a password
/// submit all the same.
pub async fn formless_password_submit(c: &Ctx<'_>) -> CaseResult {
    asking_before_passwords(c, formless_password_submit_asked(c)).await
}

async fn formless_password_submit_asked(c: &Ctx<'_>) -> CaseResult {
    c.open("/login-formless.html", "Formless login fixture").await?;
    let sign_in = c.ref_of("button", "Sign in").await?;
    expect_refusal(
        c.call("click", json!({ "ref": sign_in })).await,
        "confirmation_required",
        "unattended",
        "formless login",
    )?;
    expect_tickets(c, &[ActionClass::PasswordSubmit], "formless password submit")?;
    c.expect_url("/login-formless.html", "the refused submit").await
}

/// A pay button outside the card form, wired up by page script, submits
/// the card all the same. Changing a control that sits outside every form
/// asks nothing. Fields and images on the page shadow properties of the
/// card form (`getBoundingClientRect`) and of the document (`nodeType`,
/// `elementFromPoint`, `host`) that the host's helpers read.
pub async fn payment_outside_form(c: &Ctx<'_>) -> CaseResult {
    c.open("/checkout-outside-form.html", "Checkout outside form fixture").await?;
    let quantity = c.ref_of("combobox", "Quantity").await?;
    c.call("select_option", json!({ "ref": quantity, "value": "2" })).await?;
    let gift = c.ref_of("checkbox", "Gift wrap").await?;
    c.call("check", json!({ "ref": gift })).await?;
    expect_tickets(c, &[], "changing controls outside the card form")?;
    let pay = c.ref_of("button", "Pay now").await?;
    expect_refusal(
        c.call("click", json!({ "ref": pay })).await,
        "confirmation_required",
        "unattended",
        "a pay button outside the card form",
    )?;
    expect_tickets(c, &[ActionClass::PaymentSubmit], "payment outside the card form")?;
    c.expect_url("/checkout-outside-form.html", "the refused payment").await
}

/// "Place order" submits a form with no card field while the card fields
/// sit in another form: the order's script charges the card, so the
/// submit, by click or by Enter, is a payment. Filling the order form is
/// not.
pub async fn payment_split_forms(c: &Ctx<'_>) -> CaseResult {
    c.open("/checkout-split-forms.html", "Checkout split forms fixture").await?;
    let coupon = c.ref_of("textbox", "Coupon").await?;
    c.call("fill", json!({ "ref": coupon, "value": "SPRING" })).await?;
    expect_tickets(c, &[], "filling the order form")?;
    expect_refusal(
        c.call("press", json!({ "ref": coupon, "key": "Enter" })).await,
        "confirmation_required",
        "unattended",
        "Enter in the order form",
    )?;
    let place = c.ref_of("button", "Place order").await?;
    expect_refusal(
        c.call("click", json!({ "ref": place })).await,
        "confirmation_required",
        "unattended",
        "the order form's submit beside the card form",
    )?;
    expect_tickets(
        c,
        &[ActionClass::PaymentSubmit, ActionClass::PaymentSubmit],
        "order submits beside the card form",
    )?;
    c.expect_url("/checkout-split-forms.html", "the refused order").await
}

/// Once the agent read the page, Enter on a link that carries data to
/// another origin is confirmed like a click on it.
pub async fn tainted_link_enter(c: &Ctx<'_>) -> CaseResult {
    c.open("/link-away.html", "Link away fixture").await?;
    let link = c.ref_of("link", "Send the data").await?;
    expect_refusal(
        c.call("press", json!({ "ref": link, "key": "Enter" })).await,
        "confirmation_required",
        "unattended",
        "Enter on a data-carrying link after a snapshot",
    )?;
    expect_tickets(c, &[ActionClass::TaintedExfil], "tainted link Enter")?;
    c.expect_url("/link-away.html", "the refused link").await
}

/// A chooser the page opens on an agent tab never shows the native
/// dialog: the host cancels it, and the page sees the cancel.
pub async fn file_chooser(c: &Ctx<'_>) -> CaseResult {
    c.open("/upload.html", UPLOAD_READY).await?;
    c.click("button", "Open the file chooser").await?;
    c.call("wait", json!({ "text": "Chooser: cancelled" }))
        .await?;
    c.expect_text("Picked: none").await?;
    expect_tickets(c, &[], "a page-opened file chooser")
}

fn files_in(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.path()).collect())
        .unwrap_or_default()
}

async fn until(what: &str, done: impl FnMut() -> bool) -> CaseResult {
    until_within(what, DOWNLOAD_WAIT, done).await
}

async fn until_within(what: &str, wait: Duration, mut done: impl FnMut() -> bool) -> CaseResult {
    let deadline = Instant::now() + wait;
    while !done() {
        if Instant::now() > deadline {
            return Err(mismatch(format!(
                "{what} did not happen within {}s",
                wait.as_secs()
            )));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Ok(())
}

async fn start_download(c: &Ctx<'_>) -> CaseResult {
    c.open("/download.html", DOWNLOAD_READY).await?;
    let link = c.ref_of("link", "Get the file").await?;
    c.call("click", json!({ "ref": link })).await.map(|_| ())
}

pub async fn download(c: &Ctx<'_>) -> CaseResult {
    start_download(c).await?;
    until("a download consent ticket", || {
        c.engine
            .tickets(&c.session)
            .iter()
            .any(|t| t.action == ActionClass::Download)
    })
    .await?;
    let dir = c.engine.downloads_dir(&c.session);
    until("deleting the unconfirmed download", || {
        files_in(&dir).is_empty()
    })
    .await
}

#[cfg(windows)]
fn has_mark(file: &Path) -> bool {
    let mut stream = file.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    std::fs::read_to_string(PathBuf::from(stream)).is_ok_and(|zone| zone.contains("ZoneId=3"))
}

#[cfg(target_os = "macos")]
fn has_mark(file: &Path) -> bool {
    std::process::Command::new("xattr")
        .args(["-p", "com.apple.quarantine"])
        .arg(file)
        .output()
        .is_ok_and(|out| out.status.success())
}

/// Linux has no OS quarantine to check.
#[cfg(target_os = "linux")]
fn has_mark(_file: &Path) -> bool {
    true
}

pub async fn download_preapproved(c: &Ctx<'_>) -> CaseResult {
    preapprove(c, Scope::App, ActionClass::Download).await?;
    start_download(c).await?;
    let dir = c.engine.downloads_dir(&c.session);
    until("the download landing under app data", || {
        files_in(&dir).iter().any(|f| has_mark(f))
    })
    .await?;
    let files = files_in(&dir);
    let [file] = files.as_slice() else {
        return Err(mismatch(format!("downloads dir holds {files:?}")));
    };
    let name = file.file_name().unwrap_or_default().to_string_lossy();
    let host_named = name
        .strip_suffix(".bin")
        .is_some_and(|stem| uuid::Uuid::parse_str(stem).is_ok());
    if !host_named {
        return Err(mismatch(format!("download named {name}, not <uuid>.bin")));
    }
    let body = std::fs::read_to_string(file).unwrap_or_default();
    if body != crate::fixture_server::DOWNLOAD_BODY {
        return Err(mismatch("downloaded bytes differ from the served file"));
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    if !file.exists() {
        return Err(mismatch("the pre-approved download was deleted"));
    }
    expect_tickets(c, &[], "pre-approved download")
}

/// A download past the host's size cap is cancelled while it streams:
/// one announcing its length before any byte lands, one sent without a
/// length once it grows past the cap. Pre-approved, so only the cap stops
/// them, and nothing is left under app data.
pub async fn download_size_cap(c: &Ctx<'_>) -> CaseResult {
    preapprove(c, Scope::App, ActionClass::Download).await?;
    c.open("/download-big.html", "Big download fixture").await?;
    let dir = c.engine.downloads_dir(&c.session);
    for (link, kind) in [("Get the announced file", "announced"), ("Get the streamed file", "streamed")] {
        let target = c.ref_of("link", link).await?;
        c.call("click", json!({ "ref": target })).await?;
        let ended = || {
            let all = c.fixtures.reports();
            all.into_iter().filter(|r| r["bigDownload"] == kind).collect::<Vec<_>>()
        };
        until_within(&format!("the {kind} download ending"), BIG_DOWNLOAD_WAIT, || !ended().is_empty()).await?;
        // WebKitGTK cancels the page's own request and asks again: give the
        // second request time to start before judging what is on disk.
        tokio::time::sleep(BIG_DOWNLOAD_SETTLE).await;
        until(&format!("deleting the cancelled {kind} download"), || files_in(&dir).is_empty()).await?;
        if let Some(whole) = ended().into_iter().find(|r| r["complete"] != false) {
            return Err(mismatch(format!("the {kind} download ran to the end: {whole}")));
        }
    }
    expect_tickets(c, &[], "downloads past the size cap")
}
