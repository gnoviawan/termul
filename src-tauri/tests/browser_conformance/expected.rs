//! Per-OS record of the capabilities that fail today.
//!
//! The record is a ratchet. A failure it does not list fails the run, and so
//! does a listed capability that now passes (delete its entry), or one that
//! fails with a different wire code.

use serde_json::Value;

#[derive(Debug, PartialEq, Eq)]
pub struct Known {
    pub capability: String,
    pub code: String,
}

pub struct Observed<'a> {
    pub capability: &'a str,
    pub failure_code: Option<&'a str>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    KnownFailure,
    Unexpected(String),
}

pub fn parse(json: &str, valid_capabilities: &[&str]) -> Result<Vec<Known>, String> {
    let doc: Value = serde_json::from_str(json).map_err(|e| format!("not valid JSON: {e}"))?;
    let entries = doc["knownFailing"]
        .as_array()
        .ok_or("missing `knownFailing` array")?;
    let mut known: Vec<Known> = Vec::new();
    for entry in entries {
        let capability = entry["capability"].as_str().ok_or("entry without `capability`")?;
        let code = entry["code"].as_str().ok_or("entry without `code`")?;
        if !valid_capabilities.contains(&capability) {
            return Err(format!("unknown capability `{capability}`"));
        }
        if known.iter().any(|k| k.capability == capability) {
            return Err(format!("duplicate entry for `{capability}`"));
        }
        known.push(Known {
            capability: capability.to_string(),
            code: code.to_string(),
        });
    }
    Ok(known)
}

pub fn judge(observed: &Observed<'_>, known: &[Known]) -> Verdict {
    let listed = known.iter().find(|k| k.capability == observed.capability);
    match (observed.failure_code, listed) {
        (None, None) => Verdict::Pass,
        (None, Some(_)) => Verdict::Unexpected(format!(
            "{} passes but is listed as failing; remove it from the expected file",
            observed.capability
        )),
        (Some(code), None) => Verdict::Unexpected(format!(
            "{} failed with {code} and is not a known failure",
            observed.capability
        )),
        (Some(code), Some(k)) if k.code == code => Verdict::KnownFailure,
        (Some(code), Some(k)) => Verdict::Unexpected(format!(
            "{} failed with {code}, the expected file says {}",
            observed.capability, k.code
        )),
    }
}
