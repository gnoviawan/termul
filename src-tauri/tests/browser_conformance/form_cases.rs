//! A form whose fields are named only by the page's labels: `label[for]`, a
//! wrapping label, `aria-labelledby` and a placeholder, beside two fields
//! with no name at all. Every field is filled through its ref, one twice,
//! and the server must receive every value in the real form post. And rows
//! of same-named buttons, where a ref whose row moved goes stale instead of
//! acting on the row that took its place.

use std::time::{Duration, Instant};

use serde_json::json;

use super::{expect_code, find_ref, find_refs, mismatch, CaseResult, Ctx, Failure};
use crate::fixture_server::FORM_POST_PATH;

const LABELLED_READY: &str = "Labelled form";
const POST_WAIT: Duration = Duration::from_secs(10);

pub async fn labelled_form(c: &Ctx<'_>) -> CaseResult {
    let mark = c.fixtures.reports().len();
    c.open("/labelled-form.html", LABELLED_READY).await?;
    let snap = c.snapshot().await?;
    let named = |name: &str| {
        find_ref(&snap.text, "textbox", name)
            .ok_or_else(|| mismatch(format!("snapshot has no textbox \"{name}\": {}", snap.text)))
    };
    let fields = [
        (named("First name")?, "Ada"),
        (named("Last name")?, "Lovelace"),
        (named("City")?, "London"),
        (named("Email address")?, "ada"),
    ];
    let unnamed = find_refs(&snap.text, "textbox", "");
    let [note1, note2] = unnamed.as_slice() else {
        return Err(mismatch(format!(
            "expected two unnamed textboxes: {}",
            snap.text
        )));
    };
    let send = find_ref(&snap.text, "button", "Send")
        .ok_or_else(|| mismatch(format!("snapshot has no button \"Send\": {}", snap.text)))?;

    let refill = [(note1, "draft"), (note2, "Engine"), (note1, "Analytical")];
    for (field, value) in fields.iter().map(|(f, v)| (f, *v)).chain(refill) {
        c.call("fill", json!({ "ref": field, "value": value }))
            .await?;
    }
    c.call("click", json!({ "ref": send })).await?;
    c.call("wait", json!({ "text": "Form done" })).await?;

    let posted = await_post(c, mark).await?;
    let want = "first=Ada&last=Lovelace&city=London&email=ada&note1=Analytical&note2=Engine";
    if posted == want {
        Ok(())
    } else {
        Err(mismatch(format!(
            "{FORM_POST_PATH} received `{posted}`, expected `{want}`"
        )))
    }
}

/// Rows each with a "Delete" button. Deleting the first moves the others
/// up; the second row's ref must not then delete the third row.
pub async fn shifted_rows(c: &Ctx<'_>) -> CaseResult {
    c.open("/rows.html", "Left: Ada Bob Carol").await?;
    let snap = c.snapshot().await?;
    let deletes = find_refs(&snap.text, "button", "Delete");
    let [ada, bob, _carol] = deletes.as_slice() else {
        return Err(mismatch(format!("expected three Delete buttons: {}", snap.text)));
    };
    c.call("click", json!({ "ref": ada })).await?;
    c.call("wait", json!({ "text": "Left: Bob Carol" })).await?;
    expect_code(
        c.call("click", json!({ "ref": bob })).await,
        "stale_ref",
        "a ref whose row moved up",
    )?;
    c.expect_text("Left: Bob Carol").await
}

async fn await_post(c: &Ctx<'_>, mark: usize) -> Result<String, Failure> {
    let deadline = Instant::now() + POST_WAIT;
    loop {
        let reports = c.fixtures.reports();
        let posted = reports
            .iter()
            .skip(mark)
            .find_map(|r| r["formPost"].as_str());
        if let Some(body) = posted {
            return Ok(body.to_string());
        }
        if Instant::now() > deadline {
            return Err(mismatch(format!(
                "{FORM_POST_PATH} never received the form"
            )));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
