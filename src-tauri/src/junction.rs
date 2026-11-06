//! NTFS directory junctions, used by the worktree symlink fallback and by the
//! Claude account linker (a junction needs no privilege, unlike `symlink_dir`).
//!
//! Created through `FSCTL_SET_REPARSE_POINT` instead of `cmd /C mklink /J`, so a
//! path containing `&`, `;`, `=` or other cmd metacharacters is never parsed by
//! a shell.

use std::fs::OpenOptions;
use std::os::windows::ffi::OsStrExt as _;
use std::os::windows::fs::OpenOptionsExt as _;
use std::os::windows::io::AsRawHandle as _;
use std::path::Path;
use std::ptr::null_mut;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, MAXIMUM_REPARSE_DATA_BUFFER_SIZE,
};
use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;
use windows_sys::Win32::System::SystemServices::IO_REPARSE_TAG_MOUNT_POINT;
use windows_sys::Win32::System::IO::DeviceIoControl;

/// Bytes of the mount-point header that follow the tag, data length and
/// reserved fields: four `u16` name offsets and lengths.
const MOUNT_POINT_HEADER_LEN: usize = 8;
/// Tag, data length and reserved fields that precede the mount-point header.
const REPARSE_HEADER_LEN: usize = 8;

/// Create a junction at `target` that points to the directory `source`.
///
/// `target` must not exist. On failure no directory is left at `target`.
pub(crate) fn create_junction(source: &Path, target: &Path) -> Result<(), String> {
    let resolved = std::fs::canonicalize(source)
        .map_err(|e| format!("Failed to resolve {}: {}", source.display(), e))?;
    if !resolved.is_dir() {
        return Err(format!("{} is not a directory", source.display()));
    }
    let buffer = mount_point_buffer(&nt_path(&resolved)?)?;

    std::fs::create_dir(target)
        .map_err(|e| format!("Failed to create {}: {}", target.display(), e))?;
    if let Err(e) = set_reparse_point(target, &buffer) {
        let _ = std::fs::remove_dir(target);
        return Err(format!(
            "Failed to turn {} into a junction: {}",
            target.display(),
            e
        ));
    }
    Ok(())
}

/// The NT object-manager form of a canonical local path: `\\?\C:\dir` becomes
/// `\??\C:\dir`. A junction cannot point at a network path, so a UNC path,
/// which is also what a mapped network drive canonicalizes to, is refused.
pub(crate) fn nt_path(canonical: &Path) -> Result<Vec<u16>, String> {
    let wide: Vec<u16> = canonical.as_os_str().encode_wide().collect();
    let unc: Vec<u16> = r"\\?\UNC\".encode_utf16().collect();
    if wide.starts_with(&unc) {
        return Err(format!(
            "{} is on a network share, and a junction can only point to a local volume",
            canonical.display()
        ));
    }
    let verbatim: Vec<u16> = r"\\?\".encode_utf16().collect();
    let rest = wide
        .strip_prefix(verbatim.as_slice())
        .ok_or_else(|| format!("{} is not a canonical Windows path", canonical.display()))?;
    let mut nt: Vec<u16> = r"\??\".encode_utf16().collect();
    nt.extend_from_slice(rest);
    Ok(nt)
}

/// A `REPARSE_DATA_BUFFER` holding a mount-point (junction) reparse point whose
/// substitute name is `substitute`. The print name is empty.
fn mount_point_buffer(substitute: &[u16]) -> Result<Vec<u8>, String> {
    let substitute_len = substitute.len() * 2;
    // Path buffer: substitute name, NUL, print name (empty), NUL.
    let data_len = MOUNT_POINT_HEADER_LEN + substitute_len + 4;
    let total_len = REPARSE_HEADER_LEN + data_len;
    if total_len > MAXIMUM_REPARSE_DATA_BUFFER_SIZE as usize {
        return Err("Junction target path is too long".to_string());
    }

    let mut buffer = Vec::with_capacity(total_len);
    buffer.extend_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer.extend_from_slice(&(data_len as u16).to_le_bytes());
    buffer.extend_from_slice(&0u16.to_le_bytes());
    buffer.extend_from_slice(&0u16.to_le_bytes());
    buffer.extend_from_slice(&(substitute_len as u16).to_le_bytes());
    buffer.extend_from_slice(&((substitute_len + 2) as u16).to_le_bytes());
    buffer.extend_from_slice(&0u16.to_le_bytes());
    for unit in substitute {
        buffer.extend_from_slice(&unit.to_le_bytes());
    }
    buffer.extend_from_slice(&[0; 4]);
    Ok(buffer)
}

fn set_reparse_point(dir: &Path, buffer: &[u8]) -> std::io::Result<()> {
    let handle = OpenOptions::new()
        .write(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(dir)?;
    let mut returned = 0u32;
    // SAFETY: `handle` stays open for the call, `buffer` is a valid readable
    // slice of the length passed, and no output buffer or overlapped I/O is used.
    let ok = unsafe {
        DeviceIoControl(
            handle.as_raw_handle(),
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr().cast(),
            buffer.len() as u32,
            null_mut(),
            0,
            &mut returned,
            null_mut(),
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
#[path = "junction_tests.rs"]
mod tests;
