//! Termul's design harness for the canvas (issue #1430): the `termul-canvas`
//! skill and the curated style archetypes, embedded in the binary and served
//! by the `read_canvas_guide` and `get_canvas_style` host tools.
//!
//! The Markdown and the style data live in `resources/canvas-skill/` and are
//! versioned with Termul, not with the canvas engine. Both binaries embed
//! them through this module, so desktop and `termul-server` serve the same
//! text.

use std::sync::LazyLock;

use rmcp::schemars;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// One guide topic: the name `read_canvas_guide` takes and its Markdown.
pub struct Topic {
    pub name: &'static str,
    pub text: &'static str,
}

macro_rules! topic {
    ($name:literal) => {
        Topic {
            name: $name,
            text: include_str!(concat!("../../../resources/canvas-skill/", $name, ".md")),
        }
    };
}

/// The skill's index, returned when no topic is given.
pub const INDEX: &str = include_str!("../../../resources/canvas-skill/SKILL.md");

/// The topic name that also returns [`INDEX`].
const INDEX_TOPIC: &str = "skill";

pub static TOPICS: &[Topic] = &[
    topic!("canvas-basics"),
    topic!("working-protocol"),
    topic!("vague-prompts"),
    topic!("landing-page"),
    topic!("web-app"),
    topic!("mobile-app"),
    topic!("dashboard"),
    topic!("slides"),
    topic!("social-post"),
    topic!("design-system"),
];

/// Arguments of `read_canvas_guide`.
#[derive(Debug, Clone, Default, Deserialize, Serialize, schemars::JsonSchema)]
pub struct ReadCanvasGuideInput {
    /// The topic to read, for example "canvas-basics" or "landing-page".
    /// Leave it out to get the index (SKILL.md), which lists every topic.
    #[serde(default)]
    pub topic: Option<String>,
}

/// Arguments of `get_canvas_style`.
#[derive(Debug, Clone, Default, Deserialize, Serialize, schemars::JsonSchema)]
pub struct GetCanvasStyleInput {
    /// The style to return, for example "Warm Editorial". Leave it out to
    /// list every style with its mood and what it suits.
    #[serde(default)]
    pub name: Option<String>,
}

/// The guide for `topic`, or the index when there is none. Accepts a
/// trailing `.md` and any letter case.
pub fn read_guide(topic: Option<&str>) -> Result<&'static str, String> {
    let Some(raw) = topic.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(INDEX);
    };
    let key = raw.strip_suffix(".md").unwrap_or(raw).to_ascii_lowercase();
    if key == INDEX_TOPIC {
        return Ok(INDEX);
    }
    TOPICS
        .iter()
        .find(|t| t.name == key)
        .map(|t| t.text)
        .ok_or_else(|| {
            let names: Vec<&str> = TOPICS.iter().map(|t| t.name).collect();
            format!(
                "unknown canvas guide topic `{raw}`; topics: {}",
                names.join(", ")
            )
        })
}

/// The only family the canvas renders today (#1421, #1422).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum FontFamily {
    Inter,
}

/// The Inter faces the canvas embeds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum InterFace {
    Regular,
    Italic,
    #[serde(rename = "Semi Bold")]
    SemiBold,
    Bold,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fonts {
    pub family: FontFamily,
    pub heading: InterFace,
    pub body: InterFace,
    /// A pairing for when the canvas renders more families. Never applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_pairing: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypeStep {
    pub name: String,
    pub size: f64,
    pub face: InterFace,
    pub line_height: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letter_spacing: Option<String>,
}

/// One mode's colour tokens. Every style defines all of them in both modes.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Palette {
    pub bg: String,
    pub surface: String,
    pub text: String,
    pub muted: String,
    pub primary: String,
    pub on_primary: String,
    pub accent: String,
    pub border: String,
}

impl Palette {
    /// The tokens as (variable name suffix, colour), in a fixed order.
    pub fn tokens(&self) -> [(&'static str, &str); 8] {
        [
            ("bg", &self.bg),
            ("surface", &self.surface),
            ("text", &self.text),
            ("muted", &self.muted),
            ("primary", &self.primary),
            ("onPrimary", &self.on_primary),
            ("accent", &self.accent),
            ("border", &self.border),
        ]
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Modes {
    pub light: Palette,
    pub dark: Palette,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Radius {
    pub small: u32,
    pub medium: u32,
    pub large: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Style {
    pub name: String,
    pub mood: String,
    pub best_for: Vec<String>,
    pub fonts: Fonts,
    pub type_scale: Vec<TypeStep>,
    pub colors: Modes,
    pub spacing: Vec<u32>,
    pub radius: Radius,
    pub composition: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StyleFile {
    styles: Vec<Style>,
}

const STYLES_JSON: &str = include_str!("../../../resources/canvas-skill/styles.json");

/// The curated styles. The file is build-time data, and a test parses it, so
/// a parse failure here is a broken build rather than bad input.
pub static STYLES: LazyLock<Vec<Style>> = LazyLock::new(|| {
    serde_json::from_str::<StyleFile>(STYLES_JSON)
        .map(|file| file.styles)
        .unwrap_or_else(|error| {
            eprintln!("[host-mcp-child] canvas styles.json is unreadable: {error}");
            Vec::new()
        })
});

/// "warm-editorial", "Warm Editorial" and "warm_editorial" name the same style.
fn style_key(name: &str) -> String {
    name.trim()
        .chars()
        .map(|c| if c == '-' || c == '_' { ' ' } else { c.to_ascii_lowercase() })
        .collect()
}

/// The `batch` arguments that create `style`'s variables: one collection
/// named after the style with `Light` and `Dark` modes, colour variables
/// `color/<token>`, and number variables `space/<n>` and `radius/<size>`.
pub fn apply_batch(style: &Style) -> Value {
    let collection = style.name.as_str();
    let mut commands = vec![json!({
        "command": "variable.createCollection",
        "params": {"name": collection, "modes": ["Light", "Dark"]},
    })];
    for ((token, light), (_, dark)) in style
        .colors
        .light
        .tokens()
        .into_iter()
        .zip(style.colors.dark.tokens())
    {
        commands.push(json!({
            "command": "variable.create",
            "params": {
                "collection": collection,
                "name": format!("color/{token}"),
                "type": "color",
                "values": {"Light": light, "Dark": dark},
            },
        }));
    }
    let numbers = style
        .spacing
        .iter()
        .enumerate()
        .map(|(i, value)| (format!("space/{}", i + 1), *value))
        .chain([
            ("radius/small".to_string(), style.radius.small),
            ("radius/medium".to_string(), style.radius.medium),
            ("radius/large".to_string(), style.radius.large),
        ]);
    for (name, value) in numbers {
        commands.push(json!({
            "command": "variable.create",
            "params": {"collection": collection, "name": name, "type": "number", "value": value},
        }));
    }
    json!({"label": format!("Style: {collection}"), "commands": commands})
}

const APPLY_NOTE: &str = "To apply this style, call the batch tool with `apply` as its \
arguments: it creates one variable collection named after the style, with Light and Dark modes. \
Bind fills and strokes with run_command variable.bind {\"ids\": [...], \"field\": \"fill\", \
\"variable\": \"color/bg\"}, and switch a root frame to dark with variable.setMode {\"ids\": \
[root], \"collection\": \"<style name>\", \"mode\": \"Dark\"}. Set text with fontFamily Inter and \
the faces and sizes in typeScale. Applying the same style twice fails without changing anything.";

/// `get_canvas_style`'s reply: the list of styles, or one style with its
/// `apply` batch.
pub fn get_style(name: Option<&str>) -> Result<String, String> {
    let styles = STYLES.as_slice();
    let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) else {
        let list: Vec<Value> = styles
            .iter()
            .map(|s| json!({"name": s.name, "mood": s.mood, "bestFor": s.best_for}))
            .collect();
        return Ok(pretty(&json!({
            "styles": list,
            "next": "Call get_canvas_style with one name to get its fonts, type scale, colour tokens, spacing, radii, composition notes and the batch that applies it.",
        })));
    };
    let key = style_key(name);
    let style = styles
        .iter()
        .find(|s| style_key(&s.name) == key)
        .ok_or_else(|| {
            let names: Vec<&str> = styles.iter().map(|s| s.name.as_str()).collect();
            format!(
                "unknown canvas style `{name}`; styles: {}",
                names.join(", ")
            )
        })?;
    Ok(pretty(&json!({
        "style": style,
        "apply": apply_batch(style),
        "howToApply": APPLY_NOTE,
    })))
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

#[cfg(test)]
mod tests;
