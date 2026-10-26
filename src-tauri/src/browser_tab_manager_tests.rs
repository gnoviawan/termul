use std::collections::HashMap;
use std::sync::Mutex;

use super::{record_document_title, BrowserTabInfo};

fn tabs_with(id: &str, title: &str) -> Mutex<HashMap<String, BrowserTabInfo>> {
    let info = BrowserTabInfo {
        id: id.to_string(),
        url: "https://example.com/".to_string(),
        title: title.to_string(),
        agent_controlled: false,
    };
    Mutex::new(HashMap::from([(id.to_string(), info)]))
}

#[test]
fn a_page_title_reaches_the_renderer_and_the_tab_list() {
    let tabs = tabs_with("browser-1", "");
    assert_eq!(
        record_document_title(&tabs, "browser-1", "Example Domain"),
        Some(serde_json::json!({ "browserTabId": "browser-1", "title": "Example Domain" }))
    );
    assert_eq!(tabs.lock().unwrap()["browser-1"].title, "Example Domain");
}

#[test]
fn an_unchanged_title_is_not_reported_again() {
    let tabs = tabs_with("browser-1", "Example Domain");
    assert_eq!(
        record_document_title(&tabs, "browser-1", "Example Domain"),
        None
    );
}

#[test]
fn a_title_that_arrives_before_the_tab_is_listed_is_still_reported() {
    let tabs = tabs_with("browser-1", "");
    assert_eq!(
        record_document_title(&tabs, "browser-2", "Docs"),
        Some(serde_json::json!({ "browserTabId": "browser-2", "title": "Docs" }))
    );
    assert_eq!(tabs.lock().unwrap().len(), 1);
}
