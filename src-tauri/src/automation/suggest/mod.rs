//! Automation suggestions: notice an ask the user keeps repeating across
//! chats and offer to schedule it. Deterministic and local: prompts are
//! reduced to token sets, grouped by overlap, and a group asked on enough
//! distinct days becomes a suggestion with a cadence hint.

mod cadence;
pub mod history;
mod normalize;

use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, NaiveDate, TimeZone};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub use cadence::Cadence;
pub use history::{PromptHistory, SessionHistory};
use normalize::{jaccard, tokens, TokenSet};

/// Only asks this recent count.
pub const WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Prompts with fewer meaningful words are too vague to compare.
const MIN_TOKENS: usize = 3;
/// Two prompts with at least this token overlap ask the same thing.
const SIMILARITY: f64 = 0.6;
const MIN_OCCURRENCES: usize = 3;
const MIN_DAYS: usize = 3;
const REPRESENTATIVE_CHARS: usize = 300;
const FINGERPRINT_TOKENS: usize = 8;
const FINGERPRINT_HEX: usize = 16;

/// One user prompt from chat history.
#[derive(Debug, Clone, PartialEq)]
pub struct Prompt {
    pub at_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Suggestion {
    /// Stable id of the repeated ask; dismissals and acceptances key on it.
    pub fingerprint: String,
    /// The latest ask, whitespace collapsed, at most 300 characters.
    pub representative: String,
    pub occurrences: usize,
    /// Distinct local days the ask was made on.
    pub days: usize,
    pub last_at: i64,
    pub cadence: Cadence,
}

/// A suggestion plus the tokens a new prompt is compared against.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub suggestion: Suggestion,
    seed: TokenSet,
}

struct Group<'a> {
    seed: TokenSet,
    members: Vec<(&'a Prompt, TokenSet)>,
}

/// Repeated asks among `prompts` made in the 30 days before `now_ms`, most
/// days first. Greedy: each prompt, oldest first, joins the first group whose
/// first prompt it overlaps by Jaccard >= 0.6. A group of at least 3 prompts
/// on at least 3 distinct days (local to `tz`) is a candidate.
pub fn detect(prompts: &[Prompt], now_ms: i64, tz: Tz) -> Vec<Candidate> {
    let mut recent: Vec<&Prompt> = prompts
        .iter()
        .filter(|p| p.at_ms >= now_ms - WINDOW_MS && p.at_ms <= now_ms)
        .collect();
    recent.sort_by_key(|p| p.at_ms);

    let mut groups: Vec<Group> = Vec::new();
    for prompt in recent {
        let set = tokens(&prompt.text);
        if set.len() < MIN_TOKENS {
            continue;
        }
        match groups
            .iter_mut()
            .find(|g| jaccard(&g.seed, &set) >= SIMILARITY)
        {
            Some(group) => group.members.push((prompt, set)),
            None => groups.push(Group {
                seed: set.clone(),
                members: vec![(prompt, set)],
            }),
        }
    }

    let mut candidates: Vec<Candidate> = groups
        .into_iter()
        .filter_map(|group| candidate(group, tz))
        .collect();
    candidates.sort_by(|a, b| {
        (b.suggestion.days, b.suggestion.last_at).cmp(&(a.suggestion.days, a.suggestion.last_at))
    });
    candidates
}

fn candidate(group: Group, tz: Tz) -> Option<Candidate> {
    if group.members.len() < MIN_OCCURRENCES {
        return None;
    }
    let times: Vec<DateTime<Tz>> = group
        .members
        .iter()
        .filter_map(|(p, _)| tz.timestamp_millis_opt(p.at_ms).single())
        .collect();
    let days: HashSet<NaiveDate> = times.iter().map(DateTime::date_naive).collect();
    if days.len() < MIN_DAYS {
        return None;
    }
    let (latest, _) = group.members.last()?;
    Some(Candidate {
        suggestion: Suggestion {
            fingerprint: fingerprint(&group.members.iter().map(|(_, set)| set).collect::<Vec<_>>()),
            representative: representative(&latest.text),
            occurrences: group.members.len(),
            days: days.len(),
            last_at: latest.at_ms,
            cadence: cadence::cadence(&times, tz),
        },
        seed: group.seed,
    })
}

/// The candidate `text` asks again, if any: the one whose first prompt it
/// overlaps most, at Jaccard >= 0.6.
pub fn match_prompt<'a>(candidates: &'a [Candidate], text: &str) -> Option<&'a Suggestion> {
    let set = tokens(text);
    if set.len() < MIN_TOKENS {
        return None;
    }
    candidates
        .iter()
        .map(|c| (jaccard(&c.seed, &set), c))
        .filter(|(score, _)| *score >= SIMILARITY)
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, c)| &c.suggestion)
}

/// Hash of the group's 8 most frequent tokens (ties alphabetical) among
/// those in at least half its prompts. A word only one ask used never counts,
/// so the id survives the details of each ask and a later ask joining.
fn fingerprint(sets: &[&TokenSet]) -> String {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for token in sets.iter().copied().flatten() {
        *counts.entry(token.as_str()).or_default() += 1;
    }
    let mut ranked: Vec<(&str, usize)> = counts
        .into_iter()
        .filter(|(_, count)| count * 2 >= sets.len())
        .collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    let mut top: Vec<&str> = ranked
        .into_iter()
        .take(FINGERPRINT_TOKENS)
        .map(|(token, _)| token)
        .collect();
    top.sort_unstable();
    let digest = Sha256::digest(top.join(" ").as_bytes());
    digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()[..FINGERPRINT_HEX]
        .to_string()
}

fn representative(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(REPRESENTATIVE_CHARS)
        .collect()
}

/// The host's IANA zone: `$TZ`, else the `/etc/localtime` link, else UTC.
pub fn host_timezone() -> Tz {
    let from_env = std::env::var("TZ")
        .ok()
        .and_then(|name| name.trim_start_matches(':').parse::<Tz>().ok());
    from_env
        .or_else(|| {
            let link = std::fs::read_link("/etc/localtime").ok()?;
            let link = link.to_string_lossy();
            let (_, name) = link.split_once("zoneinfo/")?;
            name.parse::<Tz>().ok()
        })
        .unwrap_or(Tz::UTC)
}

#[cfg(test)]
mod tests;
