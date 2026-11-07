use serde_json::{json, Value};

use super::super::convert::RegistryIcon;
use super::pick;

fn picked(icons: Value) -> Option<String> {
    let icons: Vec<RegistryIcon> = serde_json::from_value(icons).unwrap();
    pick(&icons).map(|source| source.url().to_string())
}

#[test]
fn a_raster_near_the_row_size_beats_svg_and_svg_beats_a_large_raster() {
    assert_eq!(
        picked(json!([
            { "src": "https://a.example/logo.svg", "mimeType": "image/svg+xml", "sizes": ["any"] },
            { "src": "https://a.example/512.png", "mimeType": "image/png", "sizes": ["512x512"] },
            { "src": "https://a.example/96.png", "mimeType": "image/png", "sizes": ["96x96"] }
        ])),
        Some("https://a.example/96.png".to_string())
    );
    assert_eq!(
        picked(json!([
            { "src": "https://a.example/512.png", "mimeType": "image/png", "sizes": ["512x512"] },
            { "src": "https://a.example/logo.svg", "mimeType": "image/svg+xml", "sizes": ["any"] }
        ])),
        Some("https://a.example/logo.svg".to_string())
    );
}

#[test]
fn among_other_rasters_the_size_closest_to_96_wins() {
    assert_eq!(
        picked(json!([
            { "src": "https://a.example/512.png", "mimeType": "image/png", "sizes": ["512x512"] },
            { "src": "https://a.example/180.png", "mimeType": "image/png", "sizes": ["180x180"] },
            { "src": "https://a.example/none.png", "mimeType": "image/png" }
        ])),
        Some("https://a.example/180.png".to_string())
    );
}

#[test]
fn a_light_or_unthemed_icon_beats_a_dark_one() {
    assert_eq!(
        picked(json!([
            { "src": "https://a.example/dark.png", "sizes": ["64x64"], "theme": "dark" },
            { "src": "https://a.example/light.svg", "theme": "light" }
        ])),
        Some("https://a.example/light.svg".to_string())
    );
    assert_eq!(
        picked(json!([{ "src": "https://a.example/dark.png", "theme": "dark" }])),
        Some("https://a.example/dark.png".to_string())
    );
}

#[test]
fn the_type_comes_from_the_extension_when_mime_type_is_missing() {
    assert_eq!(
        picked(json!([
            { "src": "https://a.example/icon" },
            { "src": "https://a.example/icon.png", "sizes": ["96x96"] }
        ])),
        Some("https://a.example/icon.png".to_string())
    );
    assert_eq!(
        picked(json!([{ "src": "https://a.example/icon" }])),
        Some("https://a.example/icon".to_string())
    );
}

#[test]
fn only_https_icons_of_an_allowed_type_are_picked() {
    for icon in [
        json!({ "src": "http://a.example/icon.png" }),
        json!({ "src": "javascript:alert(1)" }),
        json!({ "src": "data:image/png;base64,AAAA" }),
        json!({ "src": "file:///etc/passwd" }),
        json!({ "src": "https://a.example/icon.png\n" }),
        json!({ "src": "" }),
        json!({ "src": "https://a.example/favicon.ico", "mimeType": "image/x-icon" }),
    ] {
        assert_eq!(picked(json!([icon])), None, "{icon}");
    }
}

#[test]
fn a_malformed_icons_list_costs_the_logo_not_the_server() {
    let server: super::super::convert::RegistryServer = serde_json::from_value(json!({
        "name": "io.example/a",
        "version": "1.0.0",
        "icons": "https://a.example/icon.png",
        "remotes": [{ "type": "streamable-http", "url": "https://mcp.example.com/mcp" }]
    }))
    .unwrap();
    assert!(server.icons.is_empty());
    assert_eq!(server.remotes.len(), 1);

    let server: super::super::convert::RegistryServer = serde_json::from_value(json!({
        "name": "io.example/a",
        "version": "1.0.0",
        "icons": [{ "src": 7 }, { "src": "https://a.example/icon.png", "sizes": "64x64" }, { "src": "https://a.example/ok.png" }]
    }))
    .unwrap();
    assert_eq!(
        pick(&server.icons).map(|source| source.url().to_string()),
        Some("https://a.example/ok.png".to_string())
    );
}
