use super::*;

#[test]
fn looks_like_spawnable_detects_shebang_elf_macho() {
    assert!(looks_like_spawnable(b"#!/bin/bash\n"));
    assert!(looks_like_spawnable(b"\x7fELF\x02\x01"));
    assert!(looks_like_spawnable(&[0xcf, 0xfa, 0xed, 0xfe, 0, 0]));
    assert!(!looks_like_spawnable(b"{\"ok\":true}"));
    assert!(!looks_like_spawnable(b""));
}

#[cfg(unix)]
#[test]
fn mark_spawnables_makes_companion_node_executable() {
    use std::os::unix::fs::PermissionsExt;

    let dir = std::env::temp_dir().join(format!("termul-acp-exec-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let node = dir.join("node");
    let script = dir.join("cursor-agent");
    let text = dir.join("readme.txt");

    {
        let mut f = std::fs::File::create(&node).unwrap();
        f.write_all(&[0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]).unwrap();
    }
    {
        let mut f = std::fs::File::create(&script).unwrap();
        f.write_all(b"#!/usr/bin/env bash\necho hi\n").unwrap();
    }
    std::fs::write(&text, b"hello").unwrap();

    for p in [&node, &script, &text] {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    mark_spawnables_in_tree(&dir);

    let node_mode = std::fs::metadata(&node).unwrap().permissions().mode() & 0o111;
    let script_mode = std::fs::metadata(&script).unwrap().permissions().mode() & 0o111;
    let text_mode = std::fs::metadata(&text).unwrap().permissions().mode() & 0o111;
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(node_mode, 0o111);
    assert_eq!(script_mode, 0o111);
    assert_eq!(text_mode, 0);
}

#[test]
fn extract_archive_rejects_unknown_extension() {
    let dir = std::env::temp_dir().join(format!("termul-acp-rej-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let archive = dir.join("evil.7z");
    std::fs::write(&archive, b"").unwrap();
    let dest = dir.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let result = extract_archive(&archive, &dest);
    assert!(result.is_err());
    let _ = std::fs::remove_dir_all(&dir);
}
