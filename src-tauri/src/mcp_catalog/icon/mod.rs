mod cache;
mod fetch;
mod pick;

#[cfg(test)]
mod cache_tests;
#[cfg(test)]
mod fetch_tests;
#[cfg(test)]
mod pick_tests;

use std::sync::Arc;

use url::Url;

#[cfg(test)]
pub(crate) use cache::FetchIcon;
pub(crate) use cache::IconCache;
pub(crate) use pick::pick;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconType {
    Png,
    Jpeg,
    Webp,
    Gif,
    Svg,
}

impl IconType {
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
            Self::Gif => "image/gif",
            Self::Svg => "image/svg+xml",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Icon {
    pub content_type: IconType,
    pub bytes: Arc<[u8]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IconSource(Url);

impl IconSource {
    pub(crate) fn url(&self) -> &Url {
        &self.0
    }

    pub(crate) fn host(&self) -> &str {
        self.0.host_str().unwrap_or("")
    }
}
