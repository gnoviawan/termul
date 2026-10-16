//! Process hygiene shared by every background spawn in the crate.
//!
//! - [`hide_console`] applies Windows `CREATE_NO_WINDOW` so short-lived helper
//!   processes (git, codex/claude status probes, npm, ACP terminal commands)
//!   never flash a console window from the GUI app. It is a no-op elsewhere.
//! - [`KillOnCloseJob`] (Windows only) wraps a Job Object configured with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: terminating the job, or closing its
//!   last handle (including when Termul itself exits), kills the assigned
//!   process and every descendant it spawned. Windows has no process-group
//!   kill, so this is the only reliable tree-kill for wrapper launchers and
//!   agents that spawn their own workers.
//!
//! Accepted trade-off of the job: on Windows *every* process the assigned
//! process starts is in the job and dies with it — including a browser or
//! editor an agent (or a terminal command) opens when that app was not
//! already running, and Node `detached: true` spawns, which do not leave the
//! job. This matches the unix process-group kill. Jobs created with
//! `allow_breakaway` set `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, so a descendant that
//! explicitly creates its child with `CREATE_BREAKAWAY_FROM_JOB` escapes
//! (without that limit such a `CreateProcess` call fails with
//! `ACCESS_DENIED`). ConPTY terminal jobs do not allow breakaway, so nothing
//! launched from a terminal can outlive it (#281).

/// Windows `CREATE_NO_WINDOW` process creation flag.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A command builder whose spawned process can be kept off-screen.
pub(crate) trait ConsoleCommand {
    /// Apply `CREATE_NO_WINDOW` on Windows; no-op elsewhere.
    fn hide_console_window(&mut self) -> &mut Self;
}

impl ConsoleCommand for std::process::Command {
    #[cfg(windows)]
    fn hide_console_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt as _;
        self.creation_flags(CREATE_NO_WINDOW)
    }

    #[cfg(not(windows))]
    fn hide_console_window(&mut self) -> &mut Self {
        self
    }
}

impl ConsoleCommand for tokio::process::Command {
    #[cfg(windows)]
    fn hide_console_window(&mut self) -> &mut Self {
        self.creation_flags(CREATE_NO_WINDOW)
    }

    #[cfg(not(windows))]
    fn hide_console_window(&mut self) -> &mut Self {
        self
    }
}

/// Keep a background process from opening a console window on Windows.
///
/// Sets the creation flags to `CREATE_NO_WINDOW` (replacing any flags set
/// earlier), so call it before any other `creation_flags` on the same command.
/// No-op on other platforms. Do not use for spawns that intentionally inherit
/// the caller's terminal (interactive logins).
pub(crate) fn hide_console<C: ConsoleCommand + ?Sized>(command: &mut C) -> &mut C {
    command.hide_console_window()
}

#[cfg(windows)]
pub(crate) use job::KillOnCloseJob;

#[cfg(windows)]
mod job {
    use std::os::windows::io::RawHandle;

    use winapi::um::handleapi::CloseHandle;
    use winapi::um::jobapi2::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
    };
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::winnt::{
        JobObjectExtendedLimitInformation, HANDLE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, PROCESS_SET_QUOTA,
        PROCESS_TERMINATE,
    };

    fn set_limit_flags(job: HANDLE, flags: u32) -> std::io::Result<()> {
        // SAFETY: `info` outlives the call and `job` is a live job handle owned
        // by the caller.
        let ok = unsafe {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = flags;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of_mut!(info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0
        };
        if ok {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    /// An owned kill-on-close Job Object with one process assigned to it.
    ///
    /// Dropping it closes the handle, which makes the OS terminate every
    /// process still in the job (the assigned process and its descendants).
    #[derive(Debug)]
    pub(crate) struct KillOnCloseJob {
        handle: HANDLE,
    }

    // SAFETY: a job object handle is a kernel handle with no thread affinity;
    // the Win32 job APIs used here are thread-safe.
    unsafe impl Send for KillOnCloseJob {}
    // SAFETY: see `Send` — `terminate` only calls the thread-safe
    // `TerminateJobObject` on the immutable handle.
    unsafe impl Sync for KillOnCloseJob {}

    impl KillOnCloseJob {
        /// Create a kill-on-close job and assign `process` to it. `label`
        /// names the owner in logs (e.g. `"ConPTY"`, `"ACP agent"`).
        ///
        /// `allow_breakaway` sets `JOB_OBJECT_LIMIT_BREAKAWAY_OK`: a descendant
        /// that explicitly asks for `CREATE_BREAKAWAY_FROM_JOB` escapes instead
        /// of failing to start. ACP agents allow it; ConPTY terminals do not,
        /// so a terminal descendant can never outlive the terminal (#281).
        ///
        /// Returns `None` (after one `warn` log naming the failing step) when
        /// the job cannot be created, configured, or assigned; the caller keeps
        /// the process running without tree-kill protection. Nested jobs are
        /// supported on Windows 8+, so assignment works even when the process
        /// already inherited a job (e.g. a CI runner or terminal job).
        pub(crate) fn new_assigned(
            process: RawHandle,
            label: &str,
            allow_breakaway: bool,
        ) -> Option<Self> {
            // SAFETY: plain Win32 calls on handles we own (`job`) or that the
            // caller guarantees refer to a live process (`process`). An invalid
            // process handle makes `AssignProcessToJobObject` fail, which is
            // handled below.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if job.is_null() {
                    log::warn!(
                        "[{label}] CreateJobObject failed, process tree-kill disabled: {}",
                        std::io::Error::last_os_error()
                    );
                    return None;
                }
                // Own the handle immediately so every early return closes it.
                let job = Self { handle: job };

                let flags = if allow_breakaway {
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK
                } else {
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                };
                if let Err(error) = set_limit_flags(job.handle, flags) {
                    log::warn!(
                        "[{label}] SetInformationJobObject failed, process tree-kill disabled: {error}"
                    );
                    return None;
                }

                if AssignProcessToJobObject(job.handle, process as HANDLE) == 0 {
                    log::warn!(
                        "[{label}] AssignProcessToJobObject failed, process tree-kill disabled: {}",
                        std::io::Error::last_os_error()
                    );
                    return None;
                }

                Some(job)
            }
        }

        /// The caller must still own the unreaped child, so the PID cannot
        /// have been reused.
        pub(crate) fn new_assigned_pid(
            pid: u32,
            label: &str,
            allow_breakaway: bool,
        ) -> Option<Self> {
            // SAFETY: `OpenProcess` returns an owned handle or null; a non-null
            // handle is closed below once the job holds the process.
            let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
            if process.is_null() {
                log::warn!(
                    "[{label}] OpenProcess({pid}) failed, process tree-kill disabled: {}",
                    std::io::Error::last_os_error()
                );
                return None;
            }
            let job = Self::new_assigned(process.cast(), label, allow_breakaway);
            // SAFETY: we own `process` and close it exactly once.
            unsafe {
                CloseHandle(process);
            }
            job
        }

        /// Leaks the handle when kill-on-close cannot be cleared.
        pub(crate) fn close_without_killing(self) {
            if let Err(error) = set_limit_flags(self.handle, 0) {
                log::warn!(
                    "[process_util] clearing kill-on-close failed, leaking the job handle: {error}"
                );
                std::mem::forget(self);
            }
        }

        /// Terminate every process in the job (the whole tree). Safe to call
        /// repeatedly and after the processes already exited.
        pub(crate) fn terminate(&self) -> std::io::Result<()> {
            // SAFETY: `self.handle` is a valid job handle until `Drop`.
            if unsafe { TerminateJobObject(self.handle, 1) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }

        /// Give up ownership of the raw job handle. The caller becomes
        /// responsible for closing it (closing it kills the job's processes).
        pub(crate) fn into_raw(self) -> HANDLE {
            let handle = self.handle;
            std::mem::forget(self);
            handle
        }
    }

    impl Drop for KillOnCloseJob {
        fn drop(&mut self) {
            // SAFETY: we own the handle and close it exactly once.
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(all(test, windows))]
pub(crate) mod test_support;
#[cfg(all(test, windows))]
mod tests;
