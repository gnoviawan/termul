use super::*;

use figcraft_mcp::Headless;

const SKILL_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/resources/canvas-skill");

#[test]
fn no_topic_returns_the_index() {
    assert_eq!(read_guide(None), Ok(INDEX));
    assert_eq!(read_guide(Some("  ")), Ok(INDEX));
    assert_eq!(read_guide(Some("SKILL.md")), Ok(INDEX));
    assert!(INDEX.starts_with("---\nname: termul-canvas\n"));
}

#[test]
fn topics_are_found_by_name_in_any_case_with_or_without_md() {
    let basics = read_guide(Some("canvas-basics")).expect("canvas-basics");
    assert!(basics.starts_with("# Canvas basics"));
    assert_eq!(read_guide(Some("Canvas-Basics.md")), Ok(basics));
}

#[test]
fn an_unknown_topic_is_an_error_that_lists_the_topics() {
    let error = read_guide(Some("tailwind")).expect_err("no such topic");
    assert!(error.contains("unknown canvas guide topic `tailwind`"), "{error}");
    for topic in TOPICS {
        assert!(error.contains(topic.name), "{error}");
    }
}

#[test]
fn every_skill_file_is_embedded_and_every_topic_is_in_the_index() {
    let mut on_disk: Vec<String> = std::fs::read_dir(SKILL_DIR)
        .expect("the skill directory")
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter_map(|name| name.strip_suffix(".md").map(str::to_string))
        .filter(|name| name != "SKILL")
        .collect();
    on_disk.sort();
    let mut embedded: Vec<String> = TOPICS.iter().map(|t| t.name.to_string()).collect();
    embedded.sort();
    assert_eq!(on_disk, embedded, "a .md file is not served, or a topic has no file");
    for topic in TOPICS {
        assert!(
            INDEX.contains(&format!("`{}`", topic.name)),
            "SKILL.md does not list `{}`",
            topic.name
        );
        let file = std::fs::read_to_string(format!("{SKILL_DIR}/{}.md", topic.name))
            .expect("topic file");
        assert_eq!(file, topic.text, "{} is embedded stale", topic.name);
    }
}

/// The guides' `canvas-batch` examples, as `batch` tool arguments.
fn guide_batches() -> Vec<(&'static str, Value)> {
    const FENCE: &str = "```json canvas-batch\n";
    let mut batches = Vec::new();
    for topic in TOPICS {
        let mut rest = topic.text;
        while let Some(start) = rest.find(FENCE) {
            let body = &rest[start + FENCE.len()..];
            let end = body.find("```").expect("closed fence");
            let args = serde_json::from_str(&body[..end])
                .unwrap_or_else(|e| panic!("{}: a canvas-batch block is not JSON: {e}", topic.name));
            batches.push((topic.name, args));
            rest = &body[end..];
        }
    }
    batches
}

fn run(backend: &mut Headless, tool: &str, args: &Value) -> Value {
    let result = figcraft_mcp::call_tool(backend, tool, args);
    assert!(!result.is_error, "{tool} {args}: {}", result.first_text());
    serde_json::from_str(result.first_text()).unwrap_or(Value::Null)
}

#[test]
fn every_guide_example_batch_runs_on_the_pinned_engine() {
    let batches = guide_batches();
    assert!(batches.len() >= 5, "{} examples", batches.len());
    for (topic, args) in batches {
        let mut backend = Headless::new();
        let result = figcraft_mcp::call_tool(&mut backend, "batch", &args);
        assert!(
            !result.is_error,
            "{topic} example `{}` fails: {}",
            args["label"],
            result.first_text()
        );
        let reply: Value = serde_json::from_str(result.first_text()).expect("JSON");
        assert_eq!(
            reply.get("issues"),
            None,
            "{topic} example `{}` leaves layout issues",
            args["label"]
        );
    }
}

#[test]
fn the_curated_styles_parse_and_number_eight_to_twelve() {
    assert!(
        (8..=12).contains(&STYLES.len()),
        "{} styles (styles.json may not parse)",
        STYLES.len()
    );
    let mut keys: Vec<String> = STYLES.iter().map(|s| style_key(&s.name)).collect();
    keys.sort();
    keys.dedup();
    assert_eq!(keys.len(), STYLES.len(), "style names are unique");
    for style in STYLES.iter() {
        assert!(!style.best_for.is_empty() && !style.composition.is_empty(), "{}", style.name);
        assert!(style.type_scale.iter().any(|step| step.name == "body"), "{}", style.name);
        assert!(
            style.spacing.windows(2).all(|pair| pair[0] < pair[1]),
            "{} spacing ascends",
            style.name
        );
    }
}

fn rgb(hex: &str) -> [f64; 3] {
    assert!(
        hex.len() == 7 && hex.starts_with('#') && hex[1..].chars().all(|c| c.is_ascii_hexdigit()),
        "{hex} is #RRGGBB"
    );
    [1, 3, 5].map(|i| f64::from(u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0)) / 255.0)
}

/// WCAG 2 contrast ratio.
fn contrast(a: &str, b: &str) -> f64 {
    let luminance = |hex: &str| {
        let [r, g, b] = rgb(hex).map(|c| {
            if c <= 0.039_28 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        });
        0.2126 * r + 0.7152 * g + 0.0722 * b
    };
    let (x, y) = (luminance(a), luminance(b));
    (x.max(y) + 0.05) / (x.min(y) + 0.05)
}

#[test]
fn every_style_keeps_text_readable_in_both_modes() {
    for style in STYLES.iter() {
        for (mode, p) in [("light", &style.colors.light), ("dark", &style.colors.dark)] {
            let checks = [
                ("text on bg", &p.text, &p.bg, 4.5),
                ("text on surface", &p.text, &p.surface, 4.5),
                ("muted on bg", &p.muted, &p.bg, 4.5),
                ("muted on surface", &p.muted, &p.surface, 4.5),
                ("onPrimary on primary", &p.on_primary, &p.primary, 4.5),
                ("primary on bg", &p.primary, &p.bg, 3.0),
                ("accent on bg", &p.accent, &p.bg, 3.0),
            ];
            for (pair, fg, bg, min) in checks {
                let ratio = contrast(fg, bg);
                assert!(ratio >= min, "{} {mode}: {pair} is {ratio:.2}:1, under {min}:1", style.name);
            }
            rgb(&p.border);
        }
    }
}

#[test]
fn listing_styles_names_every_style() {
    let list: Value = serde_json::from_str(&get_style(None).expect("list")).expect("JSON");
    let names: Vec<&str> = list["styles"]
        .as_array()
        .expect("styles")
        .iter()
        .filter_map(|s| s["name"].as_str())
        .collect();
    let expected: Vec<&str> = STYLES.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, expected);
}

#[test]
fn an_unknown_style_is_an_error_that_lists_the_styles() {
    let error = get_style(Some("Neon Swamp")).expect_err("no such style");
    assert!(error.contains("unknown canvas style `Neon Swamp`"), "{error}");
    for style in STYLES.iter() {
        assert!(error.contains(&style.name), "{error}");
    }
}

#[test]
fn a_style_is_found_by_its_slug() {
    let reply: Value = serde_json::from_str(&get_style(Some("night-tech")).expect("style"))
        .expect("JSON");
    assert_eq!(reply["style"]["name"], "Night Tech");
    assert_eq!(reply["style"]["fonts"]["family"], "Inter");
    let night_tech = STYLES.iter().find(|s| s.name == "Night Tech").expect("Night Tech");
    assert_eq!(reply["apply"], apply_batch(night_tech));
}

/// The reply's `apply` field runs as-is through the canvas `batch` tool, and
/// the variables it makes switch with the frame's mode.
#[test]
fn every_style_applies_on_the_pinned_engine() {
    for style in STYLES.iter() {
        let reply: Value =
            serde_json::from_str(&get_style(Some(&style.name)).expect("style")).expect("JSON");
        let mut backend = Headless::new();
        run(&mut backend, "batch", &reply["apply"]);

        let variables = run(
            &mut backend,
            "run_command",
            &json!({"command": "variable.list"}),
        );
        let collection = &variables["collections"][0];
        assert_eq!(collection["name"], style.name.as_str());
        let modes: Vec<&str> = collection["modes"]
            .as_array()
            .expect("modes")
            .iter()
            .filter_map(|m| m["name"].as_str())
            .collect();
        assert_eq!(modes, ["Light", "Dark"]);
        let count = variables["variables"].as_array().map_or(0, Vec::len);
        assert_eq!(count, 8 + style.spacing.len() + 3, "{}", style.name);

        let frame = run(
            &mut backend,
            "create_node",
            &json!({"type": "frame", "name": "Root"}),
        )["id"]
            .clone();
        let bind = json!({"ids": [frame], "field": "fill", "variable": "color/bg"});
        run(&mut backend, "run_command", &json!({"command": "variable.bind", "params": bind}));
        let fill = |backend: &mut Headless| {
            run(backend, "get_node", &json!({"id": frame}))["fills"][0]["color"]
                .as_str()
                .map(str::to_ascii_uppercase)
        };
        assert_eq!(fill(&mut backend).as_deref(), Some(style.colors.light.bg.as_str()));
        let dark = json!({"ids": [frame], "collection": style.name, "mode": "Dark"});
        run(&mut backend, "run_command", &json!({"command": "variable.setMode", "params": dark}));
        assert_eq!(fill(&mut backend).as_deref(), Some(style.colors.dark.bg.as_str()));

        let again = figcraft_mcp::call_tool(&mut backend, "batch", &reply["apply"]);
        assert!(again.is_error, "{}: a second apply is refused", style.name);
    }
}
