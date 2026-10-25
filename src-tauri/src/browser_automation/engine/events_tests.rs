use tokio::sync::mpsc::unbounded_channel;

use super::*;

struct DenyHost(&'static str);

impl NavPolicy for DenyHost {
    fn decide(&self, _tab: &str, url: &Url) -> NavVerdict {
        if url.host_str() == Some(self.0) {
            NavVerdict::Deny
        } else {
            NavVerdict::Allow
        }
    }
}

#[test]
fn hooks_publish_one_ordered_stream_with_hop_ids_and_the_policy_verdict() {
    let (tx, mut rx) = unbounded_channel();
    let events = TabEvents::new("agent-x", tx, Arc::new(DenyHost("blocked.test")));
    assert!(events.nav_starting(&"https://a.test/".parse().unwrap()));
    assert!(
        !events.nav_starting(&"https://blocked.test/".parse().unwrap()),
        "the hook cancels a denied hop"
    );
    events.committed("https://a.test/");
    events.same_document("https://a.test/#b");
    events.publish(TabEvent::Closed);
    drop(events);

    let mut seen = Vec::new();
    while let Ok(event) = rx.try_recv() {
        seen.push(event);
    }
    let label = "agent-x".to_string();
    assert_eq!(
        seen,
        [
            (
                label.clone(),
                TabEvent::NavStarting {
                    nav_id: 1,
                    url: "https://a.test/".to_string(),
                    verdict: NavVerdict::Allow
                }
            ),
            (
                label.clone(),
                TabEvent::NavStarting {
                    nav_id: 2,
                    url: "https://blocked.test/".to_string(),
                    verdict: NavVerdict::Deny
                }
            ),
            (
                label.clone(),
                TabEvent::NavCommitted {
                    nav_id: Some(2),
                    kind: CommitKind::NewDocument,
                    url: "https://a.test/".to_string()
                }
            ),
            (
                label.clone(),
                TabEvent::NavCommitted {
                    nav_id: None,
                    kind: CommitKind::SameDocument,
                    url: "https://a.test/#b".to_string()
                }
            ),
            (label, TabEvent::Closed),
        ]
    );
}

#[test]
fn a_commit_before_any_start_hop_carries_no_hop_id() {
    let (tx, mut rx) = unbounded_channel();
    let events = TabEvents::new("tab-x", tx, Arc::new(DenyHost("blocked.test")));
    events.committed("https://a.test/");
    assert_eq!(
        rx.try_recv().unwrap().1,
        TabEvent::NavCommitted {
            nav_id: None,
            kind: CommitKind::NewDocument,
            url: "https://a.test/".to_string()
        }
    );
}
