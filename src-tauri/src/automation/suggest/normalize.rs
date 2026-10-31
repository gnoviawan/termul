//! Prompt text to the token set the detector compares: the words that say
//! what was asked, without the values that change from one ask to the next.

use std::collections::BTreeSet;

pub type TokenSet = BTreeSet<String>;

const STOPWORDS: &[&str] = &[
    "a",
    "about",
    "after",
    "again",
    "all",
    "also",
    "am",
    "an",
    "and",
    "any",
    "are",
    "as",
    "at",
    "be",
    "been",
    "before",
    "being",
    "but",
    "by",
    "can",
    "could",
    "did",
    "do",
    "does",
    "for",
    "from",
    "had",
    "has",
    "have",
    "he",
    "her",
    "here",
    "him",
    "his",
    "how",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "just",
    "let",
    "lets",
    "me",
    "my",
    "no",
    "not",
    "now",
    "of",
    "on",
    "onto",
    "or",
    "our",
    "out",
    "please",
    "pls",
    "she",
    "should",
    "so",
    "some",
    "than",
    "that",
    "the",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "this",
    "those",
    "to",
    "today",
    "tomorrow",
    "too",
    "up",
    "us",
    "very",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "will",
    "with",
    "would",
    "yesterday",
    "you",
    "your",
];

/// Day and month names are dates in words.
const DATE_WORDS: &[&str] = &[
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "mon",
    "tue",
    "tues",
    "wed",
    "thu",
    "thur",
    "thurs",
    "fri",
    "sat",
    "sun",
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "jan",
    "feb",
    "mar",
    "apr",
    "jun",
    "jul",
    "aug",
    "sep",
    "sept",
    "oct",
    "nov",
    "dec",
];

/// A bare word this long made only of hex digits is an id, not a word.
const HEX_ID_MIN_LEN: usize = 7;

/// Lowercased words of `text`: a URL becomes its host, file paths, numbers,
/// dates, hex and uuid ids, punctuation and stopwords are dropped.
pub fn tokens(text: &str) -> TokenSet {
    let mut set = TokenSet::new();
    for word in text.split_whitespace() {
        let word = word.to_lowercase();
        if let Some(rest) = word
            .strip_prefix("https://")
            .or_else(|| word.strip_prefix("http://"))
        {
            if let Some(host) = url_host(rest) {
                set.insert(host);
            }
            continue;
        }
        let word = word.trim_end_matches(|c: char| !c.is_alphanumeric());
        if is_path(word) {
            continue;
        }
        set.extend(
            word.split(|c: char| !c.is_alphanumeric())
                .filter(|piece| keeps(piece))
                .map(str::to_string),
        );
    }
    set
}

fn url_host(rest: &str) -> Option<String> {
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?.split(':').next()?;
    let host = host.strip_prefix("www.").unwrap_or(host);
    (!host.is_empty()).then(|| host.to_string())
}

/// `src/main.rs`, `~/notes`, `.env`, `main.rs`.
fn is_path(word: &str) -> bool {
    word.contains(['/', '\\']) || word.starts_with(['~', '.']) || word.contains('.')
}

fn keeps(piece: &str) -> bool {
    piece.chars().count() >= 2
        && !piece.chars().any(|c| c.is_ascii_digit())
        && !(piece.len() >= HEX_ID_MIN_LEN && piece.chars().all(|c| c.is_ascii_hexdigit()))
        && !STOPWORDS.contains(&piece)
        && !DATE_WORDS.contains(&piece)
}

/// |a ∩ b| / |a ∪ b|; 0 for two empty sets.
pub fn jaccard(a: &TokenSet, b: &TokenSet) -> f64 {
    let union = a.union(b).count();
    if union == 0 {
        return 0.0;
    }
    a.intersection(b).count() as f64 / union as f64
}
