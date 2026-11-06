//! Host-side paged search (AD-1). Only one page of rows crosses a transport;
//! states are computed per request because runner availability can change.

use serde::{Deserialize, Serialize};

use super::convert::{CatalogOption, Launch, McpCatalogReason, OptionKind, Runner};
use super::snapshot::{CatalogItem, LoadedCatalog, McpCatalogSource, RegistryStatus};

pub const DEFAULT_PAGE_SIZE: usize = 50;
pub const MAX_PAGE_SIZE: usize = 100;
pub const MAX_QUERY_CHARS: usize = 200;
/// Each term rescans every item, so the term count bounds a request's cost.
pub const MAX_QUERY_TERMS: usize = 8;

/// Which runner executables the host can start (AD-4 `needs-runtime`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RunnerAvailability {
    pub npx: bool,
    pub uvx: bool,
    pub docker: bool,
    /// `dotnet` with SDK 10 or newer (`dotnet dnx`).
    pub dotnet: bool,
}

impl RunnerAvailability {
    pub(crate) fn has(self, runner: Runner) -> bool {
        match runner {
            Runner::Npx => self.npx,
            Runner::Uvx => self.uvx,
            Runner::Docker => self.docker,
            Runner::Dotnet => self.dotnet,
        }
    }
}

/// Ranked best first: an item's state is its best option's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum McpCatalogState {
    Installable,
    NeedsRuntime,
    Unsupported,
    SourceOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, schemars::JsonSchema)]
pub struct McpCatalogDefaultOption {
    pub kind: OptionKind,
    pub index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpCatalogRow {
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub version: String,
    pub status: RegistryStatus,
    pub state: McpCatalogState,
    pub reason: Option<McpCatalogReason>,
    pub default_option: Option<McpCatalogDefaultOption>,
    pub repository_url: Option<String>,
    pub has_icon: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpCatalogPage {
    pub items: Vec<McpCatalogRow>,
    pub next_cursor: Option<String>,
    pub total: usize,
    #[serde(flatten)]
    pub source: McpCatalogSource,
}

#[derive(Debug, Clone, Default, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct McpCatalogSearchRequest {
    pub query: Option<String>,
    /// Opaque; pass back the `nextCursor` of the previous page.
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchError {
    QueryTooLong,
    TooManyTerms,
    InvalidLimit,
    InvalidCursor,
}

impl std::fmt::Display for SearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::QueryTooLong => write!(f, "query exceeds {MAX_QUERY_CHARS} characters"),
            Self::TooManyTerms => write!(f, "query has more than {MAX_QUERY_TERMS} terms"),
            Self::InvalidLimit => write!(f, "limit must be between 1 and {MAX_PAGE_SIZE}"),
            Self::InvalidCursor => f.write_str("cursor is not a cursor this search returned"),
        }
    }
}

fn option_status(
    option: &CatalogOption,
    runners: RunnerAvailability,
) -> (McpCatalogState, Option<McpCatalogReason>) {
    match &option.outcome {
        Err(reason) => (McpCatalogState::Unsupported, Some(reason.clone())),
        Ok(Launch::Remote { .. }) => (McpCatalogState::Installable, None),
        Ok(Launch::Stdio { runner, .. }) if runners.has(*runner) => {
            (McpCatalogState::Installable, None)
        }
        Ok(Launch::Stdio { runner, .. }) => (
            McpCatalogState::NeedsRuntime,
            Some(McpCatalogReason::NeedsRuntime { runtime: *runner }),
        ),
    }
}

/// The item's state and reason are those of its default option: the first
/// option, in preference order, holding the best state.
pub(crate) fn item_status(
    item: &CatalogItem,
    runners: RunnerAvailability,
) -> (
    McpCatalogState,
    Option<McpCatalogReason>,
    Option<McpCatalogDefaultOption>,
) {
    let Some(options) = item.parsed.as_ref().map(|parsed| &parsed.options) else {
        return (
            McpCatalogState::Unsupported,
            Some(McpCatalogReason::Unparseable),
            None,
        );
    };
    let best = options
        .iter()
        .map(|option| (option_status(option, runners), option))
        .min_by_key(|((state, _), _)| *state);
    match best {
        None => (
            McpCatalogState::SourceOnly,
            Some(McpCatalogReason::NoInstallOptions),
            None,
        ),
        Some(((state, reason), option)) => (
            state,
            reason,
            Some(McpCatalogDefaultOption {
                kind: option.kind,
                index: option.index,
            }),
        ),
    }
}

/// How well a term matched one field, worst first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Hit {
    Substring,
    WholeWord,
    Prefix,
    Exact,
}

/// Points per [`Hit`], indexed by its rank. A term in a server's own name or
/// title outranks one in its description, and both outrank a hit only in the
/// registry namespace (`io.github.*` alone matches most of the catalog).
const NAME_OR_TITLE_POINTS: [u32; 4] = [40, 70, 80, 100];
const DESCRIPTION_POINTS: [u32; 4] = [10, 30, 30, 30];
const NAMESPACE_POINTS: u32 = 5;
const FULL_NAME_POINTS: u32 = 100;

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
}

/// The best place `term` occurs in `field`, ignoring ASCII case.
fn hit(field: &str, term: &str) -> Option<Hit> {
    let (field, term) = (field.as_bytes(), term.as_bytes());
    if term.is_empty() || term.len() > field.len() {
        return None;
    }
    if field.eq_ignore_ascii_case(term) {
        return Some(Hit::Exact);
    }
    (0..=field.len() - term.len())
        .filter(|&start| field[start..start + term.len()].eq_ignore_ascii_case(term))
        .map(|start| {
            let end = start + term.len();
            if start == 0 {
                Hit::Prefix
            } else if !is_word_byte(field[start - 1])
                && field.get(end).is_none_or(|byte| !is_word_byte(*byte))
            {
                Hit::WholeWord
            } else {
                Hit::Substring
            }
        })
        .max()
}

fn term_points(item: &CatalogItem, short_name: &str, title: &str, term: &str) -> Option<u32> {
    let points = |field: &str, table: &[u32; 4]| hit(field, term).map(|hit| table[hit as usize]);
    [
        item.name
            .eq_ignore_ascii_case(term)
            .then_some(FULL_NAME_POINTS),
        points(short_name, &NAME_OR_TITLE_POINTS),
        points(title, &NAME_OR_TITLE_POINTS),
        points(&item.description, &DESCRIPTION_POINTS),
        hit(&item.name, term).map(|_| NAMESPACE_POINTS),
    ]
    .into_iter()
    .flatten()
    .max()
}

/// Every term must match the name, title or description; the item scores the
/// sum of each term's best hit.
fn score(item: &CatalogItem, terms: &[String]) -> Option<u32> {
    let short_name = item.name.rsplit('/').next().unwrap_or(&item.name);
    let title = item.title.as_deref().unwrap_or("");
    terms.iter().try_fold(0, |total, term| {
        Some(total + term_points(item, short_name, title, term)?)
    })
}

/// A request that passed every check that needs no catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SearchQuery {
    terms: Vec<String>,
    limit: usize,
    offset: usize,
}

pub(crate) fn validate(request: &McpCatalogSearchRequest) -> Result<SearchQuery, SearchError> {
    let query = request.query.as_deref().unwrap_or("").trim();
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(SearchError::QueryTooLong);
    }
    let terms: Vec<String> = query.split_whitespace().map(str::to_string).collect();
    if terms.len() > MAX_QUERY_TERMS {
        return Err(SearchError::TooManyTerms);
    }
    let limit = request.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    if !(1..=MAX_PAGE_SIZE).contains(&limit) {
        return Err(SearchError::InvalidLimit);
    }
    let offset = match request.cursor.as_deref() {
        None => 0,
        Some(cursor) => cursor
            .parse::<usize>()
            .map_err(|_| SearchError::InvalidCursor)?,
    };
    Ok(SearchQuery {
        terms,
        limit,
        offset,
    })
}

/// The scan is linear in the catalog and the term count. Blocking.
pub(crate) fn search(
    catalog: &LoadedCatalog,
    runners: RunnerAvailability,
    query: &SearchQuery,
) -> Result<McpCatalogPage, SearchError> {
    let mut matches: Vec<(u32, &CatalogItem)> = catalog
        .items
        .iter()
        .filter_map(|item| score(item, &query.terms).map(|score| (score, item)))
        .collect();
    // Items are sorted by name, and the sort is stable, so ties stay in name
    // order and every page of one query is deterministic.
    matches.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
    let total = matches.len();
    let offset = query.offset;
    if offset > total {
        return Err(SearchError::InvalidCursor);
    }
    let end = (offset + query.limit).min(total);
    let items = matches[offset..end]
        .iter()
        .map(|(_, item)| {
            let (state, reason, default_option) = item_status(item, runners);
            McpCatalogRow {
                name: item.name.clone(),
                title: item.title.clone(),
                description: item.description.clone(),
                version: item.version.clone(),
                status: item.status,
                state,
                reason,
                default_option,
                repository_url: item.repository_url.clone(),
                has_icon: item.icon.is_some(),
            }
        })
        .collect();
    Ok(McpCatalogPage {
        items,
        next_cursor: (end < total).then(|| end.to_string()),
        total,
        source: catalog.source.clone(),
    })
}
