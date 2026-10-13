use super::*;

fn entry(name: &str, entry_type: &str) -> SFTPEntry {
    SFTPEntry {
        name: name.into(),
        path: format!("/{name}"),
        entry_type: entry_type.into(),
        size: 0,
        permissions: 0,
        modified_at: String::new(),
        owner: None,
    }
}

#[test]
fn join_avoids_double_slashes() {
    assert_eq!(join("/", "etc"), "/etc");
    assert_eq!(join("/home/u", "file.txt"), "/home/u/file.txt");
    assert_eq!(join("/home/u/", "file.txt"), "/home/u/file.txt");
}

#[test]
fn entries_sort_directories_first_then_by_name() {
    let mut entries = vec![
        entry("b.txt", "file"),
        entry("Zeta", "directory"),
        entry("a.txt", "file"),
        entry("alpha", "directory"),
        entry("link", "symlink"),
    ];
    sort_entries(&mut entries);
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["alpha", "Zeta", "a.txt", "b.txt", "link"]);
}

#[test]
fn mtime_formats_as_rfc3339_with_epoch_fallback() {
    assert_eq!(mtime_to_iso(Some(0)), "1970-01-01T00:00:00+00:00");
    assert!(mtime_to_iso(Some(1_700_000_000)).starts_with("2023-11-14T"));
    assert_eq!(mtime_to_iso(None), "1970-01-01T00:00:00Z");
}

#[test]
fn entry_type_reads_permission_bits() {
    let meta = |mode: u32| Metadata {
        permissions: Some(mode),
        ..Default::default()
    };
    assert_eq!(entry_type(&meta(0o040755)), "directory");
    assert_eq!(entry_type(&meta(0o120777)), "symlink");
    assert_eq!(entry_type(&meta(0o100644)), "file");
}
