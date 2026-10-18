//! The mount registry's connection half: which renderer runs a mount.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use super::CanvasPersistence;
use crate::acp::host_mcp::canvas::{CanvasErrorCode, CanvasHolder};

fn holder(id: &'static str) -> CanvasHolder {
    CanvasHolder::new(id, Arc::new(|_| true))
}

#[tokio::test]
async fn only_the_live_mount_seq_can_be_attached() {
    let mounts = CanvasPersistence::default();
    assert!(!mounts.attach("p", 1, holder("a")), "no mount");
    let seq = mounts.mount("p", PathBuf::from("p.figcraft"), Duration::from_secs(1));
    assert!(
        !mounts.attach("p", seq + 1, holder("a")),
        "unknown mountSeq"
    );
    assert!(mounts.attach("p", seq, holder("a")));
    assert_eq!(mounts.holder_of("p"), Some((seq, "a".to_string())));
}

#[tokio::test]
async fn detaching_keeps_the_mount_but_routes_nothing() {
    let mounts = CanvasPersistence::default();
    let seq = mounts.mount("p", PathBuf::from("p.figcraft"), Duration::from_secs(1));
    assert!(mounts.attach("p", seq, holder("a")));
    assert!(!mounts.detach("p", "b", seq), "another connection");
    assert!(mounts.detach("p", "a", seq));
    assert_eq!(mounts.mounted_projects(), vec!["p".to_string()]);
    assert_eq!(mounts.holder_of("p"), None);
    let outcome = mounts
        .call("p", "node.get", "{}".into(), Duration::from_secs(1))
        .await;
    assert_eq!(outcome.unwrap_err().code, CanvasErrorCode::CanvasClosed);
    assert!(
        mounts.attach("p", seq, holder("b")),
        "a reconnect re-attaches"
    );
}

#[tokio::test]
async fn a_new_mount_seq_drops_the_old_connection() {
    let mounts = CanvasPersistence::default();
    let first = mounts.mount("p", PathBuf::from("p.figcraft"), Duration::from_secs(1));
    assert!(mounts.attach("p", first, holder("a")));
    let second = mounts.mount("p", PathBuf::from("p.figcraft"), Duration::from_secs(1));
    assert_eq!(mounts.holder_of("p"), None);
    assert!(
        !mounts.attach("p", first, holder("a")),
        "the old mountSeq is gone"
    );
    assert!(mounts.attach("p", second, holder("a")));
}
