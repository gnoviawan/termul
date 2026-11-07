//! Disk changes made outside Termul (AD-27): self-write suppression, the
//! silent reload of a clean editor, and the conflict of a dirty one with
//! each of its three resolutions.

use std::path::PathBuf;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

use super::{
    read_document, resolve_conflict, CanvasPersistence, ConflictChoice, DirtyOutcome, DiskOutcome,
    CODE_DOCUMENT_DELETED,
};
use crate::web::fs_api::sha256_hex;

const PROJECT: &str = "project-disk";

struct Doc {
    mounts: CanvasPersistence,
    seq: u64,
    path: PathBuf,
    _dir: tempfile::TempDir,
}

impl Doc {
    /// A ready mount of a document saved at version 1 with `bytes`, opened
    /// the way the renderer opens it (read, then loaded).
    async fn opened(bytes: &[u8]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("design.figcraft");
        std::fs::write(&path, bytes).unwrap();
        let mounts = CanvasPersistence::default();
        let seq = mounts.mount(PROJECT, path.clone(), Duration::from_millis(100));
        read_document(&mounts, PROJECT, seq).await.unwrap();
        mounts.document_loaded(PROJECT, seq, Some(1)).unwrap();
        Self {
            mounts,
            seq,
            path,
            _dir: dir,
        }
    }

    async fn edit(&self, version: u64) -> DirtyOutcome {
        self.mounts
            .dirty_changed(PROJECT, self.seq, true, version)
            .await
            .unwrap()
    }

    async fn disk_changed(&self) -> DiskOutcome {
        self.mounts.disk_changed(PROJECT, self.seq).await.unwrap()
    }

    async fn save(&self, version: u64, bytes: &[u8]) -> Option<String> {
        self.mounts
            .write_snapshot(PROJECT, self.seq, version, bytes.to_vec())
            .await
            .unwrap()
            .mark_saved
    }

    fn on_disk(&self) -> Vec<u8> {
        std::fs::read(&self.path).unwrap()
    }

    /// An edit at version 2, then another program writes `theirs`.
    async fn conflicted(theirs: &[u8]) -> Self {
        let doc = Self::opened(b"saved").await;
        assert!(matches!(doc.edit(2).await, DirtyOutcome::SaveDue { .. }));
        std::fs::write(&doc.path, theirs).unwrap();
        assert!(matches!(
            doc.disk_changed().await,
            DiskOutcome::Conflict { .. }
        ));
        doc
    }
}

#[tokio::test]
async fn termuls_own_write_is_not_a_change() {
    let doc = Doc::opened(b"saved").await;
    doc.edit(2).await;
    assert_eq!(doc.save(2, b"mine").await.as_deref(), Some("2"));
    assert_eq!(doc.on_disk(), b"mine");
    let DiskOutcome::Unchanged { view } = doc.disk_changed().await else {
        panic!("Termul's own atomic write must not look like an outside change");
    };
    assert_eq!(view.conflict, None);
}

#[tokio::test]
async fn an_untouched_file_is_unchanged() {
    let doc = Doc::opened(b"saved").await;
    assert!(matches!(
        doc.disk_changed().await,
        DiskOutcome::Unchanged { .. }
    ));
}

#[tokio::test]
async fn a_change_under_a_clean_editor_reloads_the_new_bytes() {
    let doc = Doc::opened(b"saved").await;
    std::fs::write(&doc.path, b"theirs").unwrap();
    let DiskOutcome::Reload { bytes, view } = doc.disk_changed().await else {
        panic!("a clean editor reloads");
    };
    assert_eq!(bytes, BASE64.encode(b"theirs"));
    assert_eq!(view.conflict, None);
    assert!(
        matches!(doc.disk_changed().await, DiskOutcome::Unchanged { .. }),
        "the reloaded file is the new baseline"
    );
    let reloaded = doc
        .mounts
        .document_loaded(PROJECT, doc.seq, Some(9))
        .unwrap();
    assert_eq!(reloaded.saved_version.as_deref(), Some("9"), "from the ack");
}

#[tokio::test]
async fn a_change_under_unsaved_edits_is_a_conflict_and_stops_autosave() {
    let doc = Doc::conflicted(b"theirs").await;
    let view = doc.mounts.view(PROJECT, doc.seq).unwrap();
    let conflict = view.conflict.expect("a conflict");
    assert_eq!(conflict.disk_hash, Some(sha256_hex(b"theirs")));
    assert_eq!(conflict.version.as_deref(), Some("2"));

    assert!(
        matches!(doc.edit(3).await, DirtyOutcome::Idle { .. }),
        "autosave is suppressed"
    );
    assert_eq!(doc.save(3, b"mine").await, None, "nothing is written");
    assert_eq!(doc.on_disk(), b"theirs");
}

#[tokio::test]
async fn a_write_never_replaces_a_change_nobody_reported() {
    let doc = Doc::opened(b"saved").await;
    doc.edit(2).await;
    std::fs::write(&doc.path, b"theirs").unwrap();
    let outcome = doc
        .mounts
        .write_snapshot(PROJECT, doc.seq, 2, b"mine".to_vec())
        .await
        .unwrap();
    assert_eq!(outcome.mark_saved, None);
    assert_eq!(
        outcome
            .view
            .conflict
            .and_then(|conflict| conflict.disk_hash),
        Some(sha256_hex(b"theirs"))
    );
    assert_eq!(doc.on_disk(), b"theirs");
}

#[tokio::test]
async fn keep_mine_lets_the_next_save_overwrite_the_disk() {
    let doc = Doc::conflicted(b"theirs").await;
    let resolved = resolve_conflict(
        &doc.mounts,
        PROJECT,
        doc.seq,
        ConflictChoice::KeepMine,
        None,
    )
    .await
    .unwrap();
    assert_eq!(resolved.view.conflict, None);
    assert_eq!(resolved.reload, None);
    assert_eq!(resolved.copy_path, None);
    assert_eq!(doc.save(2, b"mine").await.as_deref(), Some("2"));
    assert_eq!(doc.on_disk(), b"mine");
    assert!(matches!(
        doc.disk_changed().await,
        DiskOutcome::Unchanged { .. }
    ));
}

#[tokio::test]
async fn take_disk_hands_back_the_disk_bytes() {
    let doc = Doc::conflicted(b"theirs").await;
    let resolved = resolve_conflict(
        &doc.mounts,
        PROJECT,
        doc.seq,
        ConflictChoice::TakeDisk,
        None,
    )
    .await
    .unwrap();
    assert_eq!(resolved.view.conflict, None);
    assert_eq!(resolved.reload, Some(BASE64.encode(b"theirs")));
    assert_eq!(doc.on_disk(), b"theirs");
    assert!(matches!(
        doc.disk_changed().await,
        DiskOutcome::Unchanged { .. }
    ));
}

#[tokio::test]
async fn save_a_copy_writes_the_editor_beside_the_document_then_reloads_disk() {
    let doc = Doc::conflicted(b"theirs").await;
    let snapshot = format!(
        r#"{{"contentVersion":2,"bytes":"{}"}}"#,
        BASE64.encode(b"mine")
    );
    let resolved = resolve_conflict(
        &doc.mounts,
        PROJECT,
        doc.seq,
        ConflictChoice::SaveCopy,
        Some(&snapshot),
    )
    .await
    .unwrap();
    let copy = PathBuf::from(resolved.copy_path.expect("a copy"));
    assert_eq!(copy.parent(), doc.path.parent(), "beside the document");
    let name = copy.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        name.starts_with("design.conflict-") && name.ends_with(".figcraft"),
        "{name}"
    );
    assert_eq!(std::fs::read(&copy).unwrap(), b"mine");
    assert_eq!(resolved.reload, Some(BASE64.encode(b"theirs")));
    assert_eq!(doc.on_disk(), b"theirs");

    doc.edit(3).await;
    std::fs::write(&doc.path, b"later").unwrap();
    doc.disk_changed().await;
    let second = resolve_conflict(
        &doc.mounts,
        PROJECT,
        doc.seq,
        ConflictChoice::SaveCopy,
        Some(&snapshot),
    )
    .await
    .unwrap();
    assert_ne!(
        second.copy_path.map(PathBuf::from),
        Some(copy),
        "a second copy never replaces the first"
    );
}

#[tokio::test]
async fn a_deleted_document_is_a_conflict_only_keep_mine_resolves() {
    let doc = Doc::opened(b"saved").await;
    std::fs::remove_file(&doc.path).unwrap();
    let DiskOutcome::Conflict { view } = doc.disk_changed().await else {
        panic!("a deletion is a conflict even for a clean editor");
    };
    assert_eq!(view.conflict.unwrap().disk_hash, None);
    for choice in [ConflictChoice::TakeDisk, ConflictChoice::SaveCopy] {
        let snapshot = format!(
            r#"{{"contentVersion":1,"bytes":"{}"}}"#,
            BASE64.encode(b"mine")
        );
        let refused = resolve_conflict(&doc.mounts, PROJECT, doc.seq, choice, Some(&snapshot))
            .await
            .unwrap_err();
        assert_eq!(refused.code, CODE_DOCUMENT_DELETED, "{choice:?}");
    }
    resolve_conflict(
        &doc.mounts,
        PROJECT,
        doc.seq,
        ConflictChoice::KeepMine,
        None,
    )
    .await
    .unwrap();
    assert_eq!(doc.save(1, b"recreated").await.as_deref(), Some("1"));
    assert_eq!(doc.on_disk(), b"recreated");
}

#[tokio::test]
async fn a_save_while_a_reload_is_pending_is_refused_until_the_editor_loaded_it() {
    let doc = Doc::opened(b"saved").await;
    std::fs::write(&doc.path, b"theirs").unwrap();
    assert!(matches!(
        doc.disk_changed().await,
        DiskOutcome::Reload { .. }
    ));
    let refused = doc
        .mounts
        .write_snapshot(PROJECT, doc.seq, 1, b"old editor content".to_vec())
        .await
        .unwrap_err();
    assert_eq!(refused.code, super::CODE_CANVAS_NOT_READY);
    assert_eq!(doc.on_disk(), b"theirs", "the outside version stands");

    doc.mounts
        .document_loaded(PROJECT, doc.seq, Some(5))
        .unwrap();
    doc.edit(6).await;
    assert_eq!(doc.save(6, b"edited theirs").await.as_deref(), Some("6"));
    assert_eq!(doc.on_disk(), b"edited theirs");
}

#[tokio::test]
async fn a_reload_the_editor_did_not_take_becomes_a_conflict() {
    let doc = Doc::opened(b"saved").await;
    std::fs::write(&doc.path, b"theirs").unwrap();
    assert!(matches!(
        doc.disk_changed().await,
        DiskOutcome::Reload { .. }
    ));
    let DiskOutcome::Conflict { view } = doc.mounts.reload_failed(PROJECT, doc.seq).unwrap() else {
        panic!("the editor still holds the old version, so the change is a conflict");
    };
    assert_eq!(
        view.conflict.and_then(|conflict| conflict.disk_hash),
        Some(sha256_hex(b"theirs"))
    );
    doc.edit(2).await;
    assert_eq!(doc.save(2, b"mine").await, None, "nothing is written");
    assert_eq!(doc.on_disk(), b"theirs");
}

#[tokio::test]
async fn take_disk_refuses_saves_until_the_editor_loaded_the_disk_version() {
    let doc = Doc::conflicted(b"theirs").await;
    resolve_conflict(
        &doc.mounts,
        PROJECT,
        doc.seq,
        ConflictChoice::TakeDisk,
        None,
    )
    .await
    .unwrap();
    let refused = doc
        .mounts
        .write_snapshot(PROJECT, doc.seq, 2, b"mine".to_vec())
        .await
        .unwrap_err();
    assert_eq!(refused.code, super::CODE_CANVAS_NOT_READY);
    assert_eq!(doc.on_disk(), b"theirs");
}
