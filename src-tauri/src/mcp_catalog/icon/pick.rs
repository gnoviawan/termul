//! Picks the one logo a catalog row shows from a server's `icons` list.

use crate::acp::safe_url::{check_safe_url, Opener};

use super::super::convert::RegistryIcon;
use super::IconSource;

/// Sizes in this range draw crisply at 32px on a 2x or 3x screen.
const IDEAL_SIZES: std::ops::RangeInclusive<u32> = 64..=128;
const IDEAL_SIZE: u32 = 96;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Format {
    IdealRaster,
    Svg,
    OtherRaster,
    Unknown,
}

/// `None` when the declared type is one no logo is served as.
fn format(icon: &RegistryIcon, path: &str) -> Option<Format> {
    let mime = icon.mime_type.as_deref().map(str::to_ascii_lowercase);
    let extension = path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase());
    let svg = match (mime.as_deref(), extension.as_deref()) {
        (Some("image/svg+xml"), _) | (None, Some("svg")) => true,
        (Some("image/png" | "image/jpeg" | "image/jpg" | "image/webp" | "image/gif"), _)
        | (None, Some("png" | "jpg" | "jpeg" | "webp" | "gif")) => false,
        (None, _) => return Some(Format::Unknown),
        (Some(_), _) => return None,
    };
    Some(if svg {
        Format::Svg
    } else if sizes(icon).any(|size| IDEAL_SIZES.contains(&size)) {
        Format::IdealRaster
    } else {
        Format::OtherRaster
    })
}

/// Square sizes declared as `WxH`; `any` and malformed entries are skipped.
fn sizes(icon: &RegistryIcon) -> impl Iterator<Item = u32> + '_ {
    icon.sizes.iter().filter_map(|size| {
        let (width, height) = size.split_once(['x', 'X'])?;
        let width: u32 = width.parse().ok()?;
        (height.parse::<u32>().ok()? == width).then_some(width)
    })
}

fn distance_from_ideal(icon: &RegistryIcon) -> u32 {
    sizes(icon)
        .map(|size| size.abs_diff(IDEAL_SIZE))
        .min()
        .unwrap_or(u32::MAX)
}

/// Light (or unthemed) beats dark, then a 64-128px raster, then SVG, then any
/// other raster closest to 96px. `None` when no icon is a safe `https` URL.
pub(crate) fn pick(icons: &[RegistryIcon]) -> Option<IconSource> {
    icons
        .iter()
        .filter_map(|icon| {
            let url = check_safe_url(&icon.src, Opener::Remote).ok()?;
            if url.scheme() != "https" || url.host_str().is_none() {
                return None;
            }
            let rank = (
                icon.theme.as_deref() == Some("dark"),
                format(icon, url.path())?,
                distance_from_ideal(icon),
            );
            Some((rank, url))
        })
        .min_by_key(|(rank, _)| *rank)
        .map(|(_, url)| IconSource(url))
}
