use crate::acp::safe_url::{check_safe_url, Opener};

use super::super::convert::RegistryIcon;
use super::IconSource;

const ROW_ICON_PX: u32 = 32;
const IDEAL_SIZES: std::ops::RangeInclusive<u32> = ROW_ICON_PX * 2..=ROW_ICON_PX * 4;
const IDEAL_SIZE: u32 = ROW_ICON_PX * 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Format {
    IdealRaster,
    Svg,
    OtherRaster,
    Unknown,
}

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
    } else if square_sizes(icon).any(|size| IDEAL_SIZES.contains(&size)) {
        Format::IdealRaster
    } else {
        Format::OtherRaster
    })
}

fn square_sizes(icon: &RegistryIcon) -> impl Iterator<Item = u32> + '_ {
    icon.sizes.iter().filter_map(|size| {
        let (width, height) = size.split_once(['x', 'X'])?;
        let width: u32 = width.parse().ok()?;
        (height.parse::<u32>().ok()? == width).then_some(width)
    })
}

fn distance_from_ideal(icon: &RegistryIcon) -> u32 {
    square_sizes(icon)
        .map(|size| size.abs_diff(IDEAL_SIZE))
        .min()
        .unwrap_or(u32::MAX)
}

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
