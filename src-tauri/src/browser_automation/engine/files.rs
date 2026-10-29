//! OS file facts the core's uploads and downloads need: where an opened
//! file really is, and the OS's mark for a file downloaded from the web.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

/// The user's home folder, canonical.
pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    std::fs::canonicalize(home?).ok()
}

/// How many directory entries name the open file. More than one means
/// another name, maybe outside the folder the file was opened through,
/// reaches the same bytes.
#[cfg(windows)]
pub fn link_count(file: &File) -> io::Result<u64> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    // SAFETY: plain-data struct the call fills in; all-zero is valid.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle is open for the life of `file`, and `info` is a
    // valid out pointer.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(u64::from(info.nNumberOfLinks))
}

#[cfg(unix)]
pub fn link_count(file: &File) -> io::Result<u64> {
    use std::os::unix::fs::MetadataExt;
    Ok(file.metadata()?.nlink())
}

/// Where an open file really is, from its handle.
#[cfg(windows)]
pub fn opened_path(file: &File) -> io::Result<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED,
    };

    let mut buf = vec![0u16; 1024];
    loop {
        let capacity = u32::try_from(buf.len()).unwrap_or(u32::MAX);
        // SAFETY: the handle is open for the life of `file`, and the buffer
        // holds `capacity` u16s.
        let len = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buf.as_mut_ptr(),
                capacity,
                FILE_NAME_NORMALIZED,
            )
        } as usize;
        if len == 0 {
            return Err(io::Error::last_os_error());
        }
        if len < buf.len() {
            return Ok(PathBuf::from(OsString::from_wide(&buf[..len])));
        }
        buf.resize(len + 1, 0);
    }
}

#[cfg(target_os = "linux")]
pub fn opened_path(file: &File) -> io::Result<PathBuf> {
    use std::os::unix::io::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(target_os = "macos")]
pub fn opened_path(file: &File) -> io::Result<PathBuf> {
    use std::ffi::{CStr, OsStr};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::AsRawFd;

    let mut buf = vec![0u8; libc::PATH_MAX as usize];
    // SAFETY: F_GETPATH writes at most PATH_MAX bytes, NUL-terminated.
    let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) };
    if rc == -1 {
        return Err(io::Error::last_os_error());
    }
    let path = CStr::from_bytes_until_nul(&buf)
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
    Ok(PathBuf::from(OsStr::from_bytes(path.to_bytes())))
}

/// Mark `path` as downloaded from `origin`, the way the OS's own browsers
/// do, so opening it later goes through the OS's checks.
#[cfg(windows)]
pub fn mark_downloaded(path: &Path, origin: &str) -> io::Result<()> {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    std::fs::write(
        PathBuf::from(stream),
        format!("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl={origin}\r\n"),
    )
}

#[cfg(target_os = "macos")]
pub fn mark_downloaded(path: &Path, _origin: &str) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let since_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let value = format!("0081;{since_epoch:08x};Termul;");
    let c_path = CString::new(path.as_os_str().as_bytes())?;
    // SAFETY: both strings are NUL-terminated and live across the call;
    // `value` is passed with its exact length.
    let rc = unsafe {
        libc::setxattr(
            c_path.as_ptr(),
            c"com.apple.quarantine".as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
            0,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Linux has no OS quarantine. The freedesktop origin attribute is set
/// where the filesystem takes user attributes.
#[cfg(target_os = "linux")]
pub fn mark_downloaded(path: &Path, origin: &str) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes())?;
    // SAFETY: as for macOS; a filesystem without user attributes refuses
    // the call, which is not an error here.
    unsafe {
        libc::setxattr(
            c_path.as_ptr(),
            c"user.xdg.origin.url".as_ptr(),
            origin.as_ptr().cast(),
            origin.len(),
            0,
        );
    }
    Ok(())
}

/// Test fixtures: create a file symlink. False where the account may not.
#[cfg(all(test, unix))]
pub fn symlink_file(target: &Path, link: &Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

#[cfg(all(test, windows))]
pub fn symlink_file(target: &Path, link: &Path) -> bool {
    std::os::windows::fs::symlink_file(target, link).is_ok()
}

#[cfg(test)]
#[path = "files_tests.rs"]
mod tests;
