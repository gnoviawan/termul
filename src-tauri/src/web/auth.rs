//! Fail-closed web auth gate (QA remediation Story 1 — CAP-1 interim, NOT the
//! Epic-2 identity/authz model).
//!
//! One shared semantic for the single-token gate, consumed by `/ws`
//! (`ws.rs` `authenticate` handling), `/terminal/ws` (`terminal_ws.rs`
//! connection gate), and the HTTP API middleware (`router.rs`):
//!
//! - **Engagement rule:** the gate is active ⇔ an explicit token is
//!   configured (`--web-auth-token` / `$TERMUL_WEB_AUTH_TOKEN`) OR the bind is
//!   non-loopback (`--host 0.0.0.0`). Auto-generation fires ONLY on public
//!   binds, so loopback dev servers never gain a gate and never even read the
//!   token file (leftover state cannot change loopback behavior).
//! - **Public bind + no configured token:** a token is generated from the OS
//!   CSPRNG, persisted to `<state dir>/web-auth-token` with mode 0600, and
//!   NEVER printed to stdout or logs — the operator reads it from the
//!   owner-protected file. On the next boot the same token is loaded
//!   silently.
//! - **Fail closed:** a public bind whose token can be neither resolved nor
//!   persisted (unreadable/empty token file, unwritable state dir, CSPRNG
//!   failure) is a startup error — the binary aborts BEFORE binding.
//! - The token is never printed or logged. [`WebAuthToken`]'s `Debug` impl
//!   redacts; the only plaintext copies are the operator-provided input and
//!   the owner-protected token file.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use subtle::ConstantTimeEq;

use crate::web::config::BindMode;

/// Token file name under the service-account state dir
/// (`ServerConfig::service_account_state_dir()`).
pub const WEB_AUTH_TOKEN_FILE: &str = "web-auth-token";

/// A web auth bearer token. `Debug` redacts the secret; use
/// [`WebAuthToken::as_str`] only at the compare site and when persisting to
/// the owner-protected token file.
///
/// Equality is constant-time (see the `PartialEq` impl below): comparing
/// tokens MUST NOT short-circuit on the first differing byte, so a derived
/// (byte-wise early-exit) `PartialEq` is deliberately not used.
#[derive(Clone)]
pub struct WebAuthToken(String);

impl WebAuthToken {
    /// Build a token from raw input (CLI flag, env var, or persisted file
    /// contents). Surrounding whitespace is trimmed; an empty result is NOT a
    /// token (`None`) — callers decide whether empty is a parse error (CLI
    /// flag), ignored (env var), or a startup failure (persisted file).
    #[must_use]
    pub fn new(raw: impl AsRef<str>) -> Option<Self> {
        let trimmed = raw.as_ref().trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(Self(trimmed.to_string()))
        }
    }

    /// The raw token. Never log this.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for WebAuthToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WebAuthToken(***)")
    }
}

/// Constant-time token equality via `subtle` (the same primitive
/// [`WebAuth::accepts`] uses). `Eq` is retained so `ServerConfig`'s derived
/// equality keeps compiling and behaving correctly.
impl PartialEq for WebAuthToken {
    fn eq(&self, other: &Self) -> bool {
        self.0.as_bytes().ct_eq(other.0.as_bytes()).into()
    }
}
impl Eq for WebAuthToken {}

/// The active gate: one bearer token, compared in constant time.
pub struct WebAuth {
    token: WebAuthToken,
}

impl WebAuth {
    #[must_use]
    pub fn new(token: WebAuthToken) -> Self {
        Self { token }
    }

    /// Constant-time acceptance check. A missing/empty presented token never
    /// matches (the configured token is non-empty by construction).
    #[must_use]
    pub fn accepts(&self, presented: &str) -> bool {
        self.token.0.as_bytes().ct_eq(presented.as_bytes()).into()
    }
}

impl std::fmt::Debug for WebAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WebAuth(***)")
    }
}

/// Where a gated server's token came from (drives the startup log in
/// `server_main`; the secret itself is never printed).
#[derive(Debug)]
pub enum WebAuthOrigin {
    /// Operator-supplied (`--web-auth-token` / `$TERMUL_WEB_AUTH_TOKEN`).
    Configured,
    /// Loaded from the persisted token file (path recorded for the log line).
    Loaded(PathBuf),
    /// Freshly generated + persisted this boot (path recorded for the
    /// startup note — the token itself is never printed).
    Generated(PathBuf),
}

/// The startup resolution of the web auth gate.
pub enum WebAuthResolution {
    /// No gate: loopback bind with no configured token. Behavior is
    /// byte-identical to the pre-gate server.
    Ungated,
    /// Gate active: require the token on `/ws` authenticate, `/terminal/ws`
    /// operations, and every gated HTTP API route.
    Gated { auth: Arc<WebAuth>, origin: WebAuthOrigin },
}
// Debug for test assertions (`unwrap_err`); the token itself stays redacted.
impl std::fmt::Debug for WebAuthResolution {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ungated => f.write_str("WebAuthResolution::Ungated"),
            Self::Gated { origin, .. } => write!(f, "WebAuthResolution::Gated({origin:?})"),
        }
    }
}

/// Resolve the web auth posture for this boot.
///
/// - `configured: Some` → gated, regardless of bind mode (explicit opt-in,
///   honored on loopback too).
/// - Loopback bind (or unparseable host — already rejected at CLI parse) with
///   no configured token → ungated; the token file is NOT touched.
/// - Public bind with no configured token → load the persisted token
///   (symlink-safe open + regular-file/owner-protection validation, see
///   [`load_token_file`]), or generate + persist one. Any failure to
///   resolve/persist is `Err` — the caller aborts startup before binding
///   (fail closed).
pub fn resolve(
    bind_mode: Option<BindMode>,
    configured: Option<WebAuthToken>,
    state_dir: &Path,
) -> Result<WebAuthResolution, String> {
    if let Some(token) = configured {
        return Ok(WebAuthResolution::Gated {
            auth: Arc::new(WebAuth::new(token)),
            origin: WebAuthOrigin::Configured,
        });
    }
    if bind_mode != Some(BindMode::All) {
        return Ok(WebAuthResolution::Ungated);
    }

    let path = state_dir.join(WEB_AUTH_TOKEN_FILE);
    match load_token_file(&path) {
        Ok(contents) => {
            let token = WebAuthToken::new(&contents).ok_or_else(|| {
                format!(
                    "web auth token file '{}' is empty. Refusing to start a public-bind \
                     server without a token. Fix: write a non-empty token into the file, \
                     pass --web-auth-token, or delete the file to generate a fresh one.",
                    path.display()
                )
            })?;
            Ok(WebAuthResolution::Gated {
                auth: Arc::new(WebAuth::new(token)),
                origin: WebAuthOrigin::Loaded(path),
            })
        }
        // NotFound: no token file yet → generate. NotADirectory: the state
        // dir path is occupied by a regular file — ALSO route to generation
        // so the failure surfaces at `persist_token` with the explicit
        // state-dir remediation (fail closed).
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            let token = generate_token()?;
            match persist_token(&path, &token) {
                Ok(()) => Ok(WebAuthResolution::Gated {
                    auth: Arc::new(WebAuth::new(token)),
                    origin: WebAuthOrigin::Generated(path),
                }),
                // Lost a first-boot race with another termul-server instance:
                // adopt the winner's persisted token instead of failing or
                // clobbering it.
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let contents = load_token_file(&path).map_err(|e| {
                        format!(
                            "web auth token file '{}' appeared concurrently but is \
                             unreadable or unsafe to adopt: {e}",
                            path.display()
                        )
                    })?;
                    let token = WebAuthToken::new(&contents).ok_or_else(|| {
                        format!(
                            "web auth token file '{}' appeared concurrently but is empty",
                            path.display()
                        )
                    })?;
                    Ok(WebAuthResolution::Gated {
                        auth: Arc::new(WebAuth::new(token)),
                        origin: WebAuthOrigin::Loaded(path),
                    })
                }
                Err(e) => Err(format!(
                    "failed to persist the generated web auth token: {e}. Refusing to \
                     start a public-bind server without a persistable token. Fix the \
                     state dir permissions, or pass --web-auth-token.",
                )),
            }
        }
        Err(e) => Err(format!(
            "failed to read web auth token file '{}': {e}. Refusing to start a \
             public-bind server without a token. Fix the file's permissions/contents, \
             or delete it to generate a fresh token.",
            path.display()
        )),
    }
}

/// chars, URL-safe so the `#token=` bootstrap fragment needs no encoding).
fn generate_token() -> Result<WebAuthToken, String> {
    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw)
        .map_err(|e| format!("failed to generate a web auth token (CSPRNG error): {e}"))?;
    let mut hex = String::with_capacity(raw.len() * 2);
    for byte in raw {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    // 64 hex chars is never empty — `expect` would be fine, but stay total.
    WebAuthToken::new(&hex)
        .ok_or_else(|| "generated web auth token was empty (internal error)".to_string())
}

/// Persist `token` to `path` with owner-only permissions, creating the parent
/// state dir if needed. Unix: `create_new` with mode 0600. Windows: no
/// create-time mode bits exist and a new file INHERITS the parent
/// directory's ACL (often readable by other local principals), so the file
/// is created via `CreateFileW` with an explicit owner-only
/// `SECURITY_ATTRIBUTES` — the restrictive DACL exists BEFORE any token
/// bytes are written (no post-write restriction window). Fails closed: any
/// I/O or security-descriptor error is surfaced so the caller aborts
/// startup rather than running a public-bind server with an unpersisted or
/// world-readable token. `AlreadyExists` is returned verbatim so the caller
/// can adopt the winner of a first-boot race.
fn persist_token(path: &Path, token: &WebAuthToken) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        // A failure here is a state-dir problem (permissions / not a
        // directory) — never a first-boot race. Force a non-`AlreadyExists`
        // kind so `resolve` doesn't misread it as "token file appeared".
        std::fs::create_dir_all(parent).map_err(|e| {
            std::io::Error::other(format!(
                "cannot create state dir '{}': {e}",
                parent.display()
            ))
        })?;
    }
    // Unix: owner-only from the first byte via create-time mode 0600.
    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::OpenOptionsExt as _;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?
    };
    // Windows: owner-only DACL supplied at creation (see the helper's doc).
    #[cfg(windows)]
    let mut file = create_owner_only_file(path)?;
    #[cfg(not(any(unix, windows)))]
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(token.as_str().as_bytes())
        .and_then(|()| file.write_all(b"\n"))?;
    Ok(())
}

/// Windows: create the token file with an owner-only DACL AT CREATION TIME
/// (`CreateFileW` + `SECURITY_ATTRIBUTES` carrying `D:P(A;;FA;;;OW)` —
/// inheritance blocked, Full Control to the Owner Rights SID, which resolves
/// to the file's owner at access check time, i.e. the service identity), so
/// the file never exists with the parent directory's inherited ACL while
/// holding token bytes. `CREATE_NEW` preserves the `create_new` first-boot
/// race semantics (`ERROR_FILE_EXISTS` maps to `ErrorKind::AlreadyExists`,
/// so `resolve` can adopt the winner's token).
#[cfg(windows)]
fn create_owner_only_file(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::io::FromRawHandle as _;

    use windows_sys::Win32::Foundation::{GENERIC_WRITE, INVALID_HANDLE_VALUE, LocalFree};
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Storage::FileSystem::{
        CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };

    // Owner-only DACL, inheritance blocked (SDDL revision 1).
    let sddl: Vec<u16> = "D:P(A;;FA;;;OW)\0".encode_utf16().collect();
    let mut sd: *mut core::ffi::c_void = std::ptr::null_mut();
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut sd,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 || sd.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    // Every path below returns through this closure so the LocalAlloc'd
    // descriptor is freed exactly once.
    let result = (|sd: *mut core::ffi::c_void| -> std::io::Result<std::fs::File> {
        let security_attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd,
            bInheritHandle: 0,
        };
        let path_wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: `path_wide` and `security_attributes` outlive the call;
        // the descriptor is freed only after this closure returns.
        let handle = unsafe {
            CreateFileW(
                path_wide.as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                &security_attributes,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: `handle` is a valid owned file handle from CreateFileW;
        // ownership moves into the `File` exactly once.
        Ok(unsafe { std::fs::File::from_raw_handle(handle) })
    })(sd);
    unsafe {
        LocalFree(sd);
    }
    result.map_err(|e| {
        std::io::Error::new(
            e.kind(),
            format!(
                "cannot create web auth token file '{}' with an owner-only DACL: {e}",
                path.display()
            ),
        )
    })
}

/// Read the persisted token file with symlink-safe, owner-protected
/// validation (consumed by BOTH the normal load and the first-boot race
/// adoption in `resolve`). The file is opened WITHOUT following symlinks
/// (Unix `O_NOFOLLOW`; Windows `FILE_FLAG_OPEN_REPARSE_POINT`), then
/// validated from the OPEN HANDLE — so the checks cannot be raced by
/// swapping the path after the open. It must be a regular file whose
/// permissions restrict it to the owner (Unix: no group/other mode bits;
/// Windows: every DACL allow-ACE resolves to the file owner, SYSTEM, or
/// Administrators). Anything else — symlink, device/FIFO, loose permissions
/// — is rejected: a public-bind server must never adopt a bearer token that
/// another local principal can read or steer.
fn load_token_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read as _;
    let mut file = open_token_file(path)?;
    validate_token_file(path, &file)?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    Ok(contents)
}

/// Unix: open read-only with `O_NOFOLLOW` — a symlink at the token path
/// fails with ELOOP instead of redirecting the read to an attacker-chosen
/// file. The ELOOP error is reworded so the fail-closed startup message
/// names the actual cause.
#[cfg(unix)]
fn open_token_file(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt as _;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| {
            if e.raw_os_error() == Some(libc::ELOOP) {
                std::io::Error::new(
                    e.kind(),
                    format!(
                        "web auth token file '{}' is a symlink — refusing to follow it",
                        path.display()
                    ),
                )
            } else {
                e
            }
        })
}

/// Windows: open with `FILE_FLAG_OPEN_REPARSE_POINT` so a symlink/reparse
/// point at the token path is opened AS the reparse point (never followed);
/// `validate_token_file` then rejects it as a non-regular file.
#[cfg(windows)]
fn open_token_file(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt as _;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
fn open_token_file(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::open(path)
}

/// Validate the OPEN token file (handle-based metadata, immune to a path
/// swap after the open): it must be a regular file — the no-follow open
/// makes a symlink surface as non-regular — and owner-protected per the
/// platform rules.
fn validate_token_file(path: &Path, file: &std::fs::File) -> std::io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "web auth token file '{}' is not a regular file (symlinks and special \
                 files are refused)",
                path.display()
            ),
        ));
    }
    validate_owner_protected(path, file, &metadata)
}

/// Unix owner-protection: no group/other permission bits. The file is
/// created 0600; anything looser means another local principal can read the
/// bearer token.
#[cfg(unix)]
fn validate_owner_protected(
    path: &Path,
    _file: &std::fs::File,
    metadata: &std::fs::Metadata,
) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "web auth token file '{}' is not owner-protected (mode {mode:04o} grants \
                 group/other access). Fix: chmod 600 '{}', or delete it to generate a \
                 fresh token.",
                path.display(),
                path.display()
            ),
        ));
    }
    Ok(())
}

/// Windows owner-protection: read the DACL from the OPEN handle
/// (`GetSecurityInfo`, so the check cannot be raced by a path swap) and walk
/// its ACEs — every allow-ACE must resolve to the file's owner, SYSTEM, or
/// the Administrators group (the principals a Windows host cannot function
/// without; an attacker who already IS an administrator needs no token
/// file). Any other grantee means another local principal can read the
/// bearer token. Deny/audit ACEs never GRANT access, so they cannot widen
/// exposure and are skipped.
#[cfg(windows)]
fn validate_owner_protected(
    path: &Path,
    file: &std::fs::File,
    _metadata: &std::fs::Metadata,
) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle as _;

    use windows_sys::Win32::Foundation::{LocalFree, ERROR_SUCCESS};
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        AclSizeInformation, EqualSid, GetAce, GetAclInformation, WinBuiltinAdministratorsSid,
        WinLocalSystemSid, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION,
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    };

    // ACCESS_ALLOWED_ACE_TYPE (0) — windows-sys exposes the constant under
    // Win32::System::SystemServices, a feature this crate does not enable;
    // ACE_HEADER.AceType is a u8.
    const ACCESS_ALLOWED_ACE_TYPE_VALUE: u8 = 0;

    let mut owner: PSID = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: all out-pointers are valid stack slots and `file` is a live
    // open handle for the duration of the call.
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(status as i32));
    }
    // Every path below returns through this closure so the LocalAlloc'd
    // security descriptor is freed exactly once.
    let result = (|| -> std::io::Result<()> {
        // A NULL DACL grants everyone full control; a missing owner is
        // unverifiable. Both fail closed.
        if owner.is_null() || dacl.is_null() {
            return Err(std::io::Error::other(format!(
                "web auth token file '{}' has no owner or no DACL — refusing to trust it",
                path.display()
            )));
        }
        let mut system = well_known_sid(WinLocalSystemSid)?;
        let mut administrators = well_known_sid(WinBuiltinAdministratorsSid)?;
        let mut info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: `dacl` is a live ACL inside the security descriptor above;
        // `info` is a valid ACL_SIZE_INFORMATION out-buffer.
        if unsafe {
            GetAclInformation(
                dacl,
                &mut info as *mut ACL_SIZE_INFORMATION as *mut core::ffi::c_void,
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        for index in 0..info.AceCount {
            let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
            // SAFETY: `index < AceCount`, so the ACE exists within `dacl`.
            if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: every ACE begins with an ACE_HEADER (all ACE structs
            // share that leading layout).
            let ace_type = unsafe { (*(ace as *const ACE_HEADER)).AceType };
            if ace_type != ACCESS_ALLOWED_ACE_TYPE_VALUE {
                continue;
            }
            // SAFETY: the type check above pins the ACCESS_ALLOWED_ACE
            // layout; SidStart is the first DWORD of the trustee SID inside
            // the ACE, which lives in `dacl` for the whole loop.
            let sid =
                unsafe { &(*(ace as *const ACCESS_ALLOWED_ACE)).SidStart } as *const u32 as PSID;
            // SAFETY: every SID pointer references a live structure that
            // outlives the call (the descriptor's owner SID and the two
            // well-known SID buffers).
            let trusted = unsafe {
                EqualSid(sid, owner) != 0
                    || EqualSid(sid, system.as_mut_ptr() as PSID) != 0
                    || EqualSid(sid, administrators.as_mut_ptr() as PSID) != 0
            };
            if !trusted {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!(
                        "web auth token file '{}' grants access to a principal other than \
                         the owner, SYSTEM, or Administrators — another local account can \
                         read the bearer token. Fix: delete the file so a fresh \
                         owner-only token is generated, or pass --web-auth-token.",
                        path.display()
                    ),
                ));
            }
        }
        Ok(())
    })();
    // SAFETY: `sd` was allocated by GetSecurityInfo via LocalAlloc.
    unsafe {
        LocalFree(sd);
    }
    result
}

/// No permission model beyond the regular-file check on other platforms.
#[cfg(not(any(unix, windows)))]
fn validate_owner_protected(
    _path: &Path,
    _file: &std::fs::File,
    _metadata: &std::fs::Metadata,
) -> std::io::Result<()> {
    Ok(())
}

/// Windows: build a well-known SID (SYSTEM / Administrators) into an owned
/// buffer for `EqualSid` comparisons.
#[cfg(windows)]
fn well_known_sid(
    kind: windows_sys::Win32::Security::WELL_KNOWN_SID_TYPE,
) -> std::io::Result<Vec<u8>> {
    use windows_sys::Win32::Security::{CreateWellKnownSid, PSID};

    // First call sizes the buffer (expected to fail with
    // ERROR_INSUFFICIENT_BUFFER).
    let mut size: u32 = 0;
    // SAFETY: null SID pointer with a size query — the documented sizing
    // pattern for CreateWellKnownSid.
    unsafe {
        CreateWellKnownSid(kind, std::ptr::null_mut(), std::ptr::null_mut(), &mut size);
    }
    let mut buffer = vec![0u8; size as usize];
    // SAFETY: `buffer` is exactly `size` bytes, as the sizing call required.
    if unsafe {
        CreateWellKnownSid(
            kind,
            std::ptr::null_mut(),
            buffer.as_mut_ptr() as PSID,
            &mut size,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique temp dir per test (removed on Drop, including panic paths).
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "termul-web-auth-{label}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn token_debug_redacts_secret() {
        let token = WebAuthToken::new("super-secret-value").expect("non-empty");
        let dbg = format!("{token:?}");
        assert!(!dbg.contains("super-secret-value"), "debug must redact: {dbg}");
        let auth = WebAuth::new(token);
        let dbg = format!("{auth:?}");
        assert!(!dbg.contains("super-secret-value"), "debug must redact: {dbg}");
    }

    #[test]
    fn token_new_trims_and_rejects_empty() {
        assert!(WebAuthToken::new("").is_none());
        assert!(WebAuthToken::new("   \n").is_none());
        assert_eq!(
            WebAuthToken::new("  abc \n").expect("non-empty").as_str(),
            "abc"
        );
    }

    #[test]
    fn token_equality_is_exact_and_total() {
        // `PartialEq` is implemented with `subtle::ConstantTimeEq` (no
        // early-exit byte compare). Behaviorally: exact match only, across
        // length mismatches and near misses, and `Eq` holds (ServerConfig
        // derives `Eq`-compatible equality over `Option<WebAuthToken>`).
        let a = WebAuthToken::new("t0ken").expect("non-empty");
        assert!(a == a.clone());
        assert_eq!(a, WebAuthToken::new("t0ken").expect("non-empty"));
        assert_ne!(a, WebAuthToken::new("t0keN").expect("non-empty"));
        assert_ne!(a, WebAuthToken::new("t0ken0").expect("non-empty"));
        assert_ne!(a, WebAuthToken::new("t0ke").expect("non-empty"));
    }

    #[test]
    fn accepts_exact_match_only() {
        let auth = WebAuth::new(WebAuthToken::new("t0ken").expect("non-empty"));
        assert!(auth.accepts("t0ken"));
        assert!(!auth.accepts("WRONG"));
        assert!(!auth.accepts(""));
        // Length-mismatched and prefix probes must not match.
        assert!(!auth.accepts("t0ken-plus-extra"));
        assert!(!auth.accepts("t0k"));
    }

    #[test]
    fn resolve_configured_token_gates_even_on_loopback() {
        let dir = TempDir::new("configured");
        let resolution = resolve(
            Some(BindMode::Localhost),
            WebAuthToken::new("explicit"),
            &dir.0,
        )
        .expect("resolve");
        match resolution {
            WebAuthResolution::Gated { auth, origin } => {
                assert!(matches!(origin, WebAuthOrigin::Configured));
                assert!(auth.accepts("explicit"));
                assert!(!auth.accepts("other"));
            }
            WebAuthResolution::Ungated => panic!("configured token must gate"),
        }
        // The token file is never touched for a configured token.
        assert!(!dir.0.join(WEB_AUTH_TOKEN_FILE).exists());
    }

    #[test]
    fn resolve_loopback_without_token_is_ungated_and_file_free() {
        let dir = TempDir::new("loopback");
        let resolution = resolve(Some(BindMode::Localhost), None, &dir.0).expect("resolve");
        assert!(
            matches!(resolution, WebAuthResolution::Ungated),
            "loopback without a configured token must stay ungated"
        );
        // Frozen contract: the token file is not even read/created.
        assert!(!dir.0.join(WEB_AUTH_TOKEN_FILE).exists());
    }

    #[test]
    fn resolve_public_bind_generates_then_loads_same_token() {
        let dir = TempDir::new("generated");
        let first = resolve(Some(BindMode::All), None, &dir.0).expect("resolve");
        let WebAuthResolution::Gated {
            auth: first_auth,
            origin: WebAuthOrigin::Generated(path),
        } = first
        else {
            panic!("first public boot must generate")
        };
        assert_eq!(path, dir.0.join(WEB_AUTH_TOKEN_FILE));
        // Persisted contents match the live token.
        let on_disk = std::fs::read_to_string(&path).expect("token file exists");
        assert!(
            first_auth.accepts(on_disk.trim()),
            "persisted token must match the live one"
        );
        // Unix: owner-only permissions.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "token file must be 0600, got {mode:o}");
        }
        // Second boot loads the SAME token (no regeneration).
        let second = resolve(Some(BindMode::All), None, &dir.0).expect("resolve");
        let WebAuthResolution::Gated {
            auth: second_auth,
            origin: WebAuthOrigin::Loaded(_),
        } = second
        else {
            panic!("second public boot must load")
        };
        assert!(second_auth.accepts(on_disk.trim()));
    }

    #[test]
    fn resolve_public_bind_rejects_empty_token_file() {
        let dir = TempDir::new("empty-file");
        std::fs::write(dir.0.join(WEB_AUTH_TOKEN_FILE), "  \n").expect("write empty file");
        let err = resolve(Some(BindMode::All), None, &dir.0).unwrap_err();
        assert!(err.contains("empty"), "error must name the cause: {err}");
        assert!(
            err.contains(WEB_AUTH_TOKEN_FILE),
            "error must name the file: {err}"
        );
    }

    #[test]
    fn resolve_public_bind_rejects_unreadable_token_file() {
        // A directory at the token-file path fails `read_to_string` on every
        // platform, regardless of the test user's privileges (root bypasses
        // permission bits, so chmod-based unreadable fixtures are unreliable).
        let dir = TempDir::new("unreadable-file");
        std::fs::create_dir(dir.0.join(WEB_AUTH_TOKEN_FILE)).expect("mkdir at token path");
        let err = resolve(Some(BindMode::All), None, &dir.0).unwrap_err();
        assert!(
            err.contains("failed to read"),
            "error must name the cause: {err}"
        );
    }

    /// A symlink at the token path must NEVER be followed — even when it
    /// points at a perfectly valid token file. The no-follow open fails the
    /// resolution (fail closed) with a message naming the symlink.
    #[cfg(unix)]
    #[test]
    fn resolve_public_bind_rejects_symlink_token_file() {
        let dir = TempDir::new("symlink");
        let target = dir.0.join("real-token");
        std::fs::write(&target, "real-token").expect("write target");
        std::os::unix::fs::symlink(&target, dir.0.join(WEB_AUTH_TOKEN_FILE))
            .expect("create symlink");
        let err = resolve(Some(BindMode::All), None, &dir.0).unwrap_err();
        assert!(
            err.contains("symlink"),
            "error must name the symlink refusal: {err}"
        );
    }

    /// A token file readable by group/other principals exposes the bearer
    /// token to other local accounts — the loader must refuse it (fail
    /// closed) and name the remediation.
    #[cfg(unix)]
    #[test]
    fn resolve_public_bind_rejects_group_or_world_readable_token_file() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = TempDir::new("loose-mode");
        let path = dir.0.join(WEB_AUTH_TOKEN_FILE);
        std::fs::write(&path, "t0ken").expect("write token file");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("chmod 0644");
        let err = resolve(Some(BindMode::All), None, &dir.0).unwrap_err();
        assert!(
            err.contains("owner-protected"),
            "error must name the owner-protection failure: {err}"
        );
        assert!(
            err.contains("chmod 600"),
            "error must name the remediation: {err}"
        );
        // Owner-only mode is accepted (the persist path creates 0600).
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .expect("chmod 0600");
        let resolution = resolve(Some(BindMode::All), None, &dir.0).expect("resolve");
        assert!(
            matches!(
                resolution,
                WebAuthResolution::Gated {
                    origin: WebAuthOrigin::Loaded(_),
                    ..
                }
            ),
            "0600 token file must load"
        );
    }

    /// The race-adoption path (`AlreadyExists` from persist) goes through the
    /// SAME secure loader: a symlink swapped in between the failed persist
    /// and the adoption read is still refused.
    #[cfg(unix)]
    #[test]
    fn load_token_file_refuses_symlink_directly() {
        let dir = TempDir::new("loader-symlink");
        let target = dir.0.join("real-token");
        std::fs::write(&target, "real-token").expect("write target");
        let link = dir.0.join(WEB_AUTH_TOKEN_FILE);
        std::os::unix::fs::symlink(&target, &link).expect("create symlink");
        let err = load_token_file(&link).unwrap_err();
        assert!(
            err.to_string().contains("symlink"),
            "loader must name the symlink refusal: {err}"
        );
    }

    #[test]
    fn resolve_public_bind_fails_closed_when_state_dir_unwritable() {
        // A regular FILE at the state-dir path makes `create_dir_all` fail on
        // every platform, regardless of privileges (root bypasses permission
        // bits, so a chmod-based read-only dir is unreliable).
        let dir = TempDir::new("fail-closed");
        let state_dir = dir.0.join("state-is-a-file");
        std::fs::write(&state_dir, "not a directory").expect("write file");
        let err = resolve(Some(BindMode::All), None, &state_dir).unwrap_err();
        assert!(
            err.contains("cannot create state dir"),
            "error must name the cause: {err}"
        );
        assert!(
            err.contains("--web-auth-token"),
            "error must name the remediation: {err}"
        );
    }

    #[test]
    fn generated_tokens_are_unique_and_url_safe() {
        let a = generate_token().expect("generate");
        let b = generate_token().expect("generate");
        assert_ne!(a.as_str(), b.as_str(), "CSPRNG tokens must differ");
        assert_eq!(a.as_str().len(), 64);
        assert!(
            a.as_str().chars().all(|c| c.is_ascii_hexdigit()),
            "hex tokens need no URL encoding for the #token= fragment"
        );
    }

    /// Windows: the token file must be created with its owner-only DACL in
    /// place from the first byte (CreateFileW + SECURITY_ATTRIBUTES), and a
    /// second create must report `AlreadyExists` so `resolve` can adopt the
    /// winner of a first-boot race.
    #[cfg(windows)]
    #[test]
    fn create_owner_only_file_applies_dacl_at_creation() {
        let dir = TempDir::new("create-owner-only");
        let path = dir.0.join(WEB_AUTH_TOKEN_FILE);
        let token = WebAuthToken::new("t0ken").expect("non-empty");
        persist_token(&path, &token).expect("first create");
        let on_disk = std::fs::read_to_string(&path).expect("token file exists");
        assert_eq!(on_disk.trim(), "t0ken");
        let err = persist_token(&path, &token).expect_err("second create must fail");
        assert_eq!(
            err.kind(),
            std::io::ErrorKind::AlreadyExists,
            "CREATE_NEW must map an existing file to AlreadyExists: {err}"
        );
    }
}
