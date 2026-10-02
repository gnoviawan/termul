/// Windows ConPTY child process wrapper.
#[cfg(target_os = "windows")]
#[derive(Debug)]
pub(super) struct WindowsConPtyChild {
    pub(super) pid: u32,
    pub(super) process_handle: *mut winapi::ctypes::c_void,
    // Job Object handle (KILL_ON_JOB_CLOSE) owning the child process tree, or
    // null if it could not be created. Closing it (on Drop) reaps the whole
    // tree; TerminateJobObject kills it on demand. See spawn_conpty / #281.
    pub(super) job_handle: *mut winapi::ctypes::c_void,
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
struct WindowsPidKiller {
    pid: u32,
}

// SAFETY: process_handle is only accessed by one thread at a time via the
// AsyncMutex<Option<Box<dyn Child>>> wrapper in TerminalInstance.
#[cfg(target_os = "windows")]
unsafe impl Send for WindowsConPtyChild {}

// SAFETY: process_handle is only accessed by one thread at a time via the
// AsyncMutex<Option<Box<dyn Child>>> wrapper in TerminalInstance.
#[cfg(target_os = "windows")]
unsafe impl Sync for WindowsConPtyChild {}

#[cfg(target_os = "windows")]
impl Drop for WindowsConPtyChild {
    fn drop(&mut self) {
        unsafe {
            // Close the job handle first: with KILL_ON_JOB_CLOSE this reaps the
            // entire child process tree once the last handle is gone.
            if !self.job_handle.is_null() {
                let _ = winapi::um::handleapi::CloseHandle(self.job_handle);
                self.job_handle = std::ptr::null_mut();
            }
            if !self.process_handle.is_null() {
                let _ = winapi::um::handleapi::CloseHandle(self.process_handle);
                self.process_handle = std::ptr::null_mut();
            }
        }
    }
}

#[cfg(target_os = "windows")]
impl portable_pty::ChildKiller for WindowsPidKiller {
    fn kill(&mut self) -> std::io::Result<()> {
        unsafe {
            let handle = winapi::um::processthreadsapi::OpenProcess(
                winapi::um::winnt::PROCESS_TERMINATE,
                0,
                self.pid,
            );
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let terminate_ok = winapi::um::processthreadsapi::TerminateProcess(handle, 1);
            let close_ok = winapi::um::handleapi::CloseHandle(handle);
            if terminate_ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            if close_ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }
    }

    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync + 'static> {
        Box::new(WindowsPidKiller { pid: self.pid })
    }
}

#[cfg(target_os = "windows")]
impl portable_pty::ChildKiller for WindowsConPtyChild {
    fn kill(&mut self) -> std::io::Result<()> {
        unsafe {
            // Prefer terminating the Job Object: this kills the entire child
            // process tree (cmd → powershell → node …), which single-PID
            // TerminateProcess cannot do. See #281.
            if !self.job_handle.is_null() {
                if winapi::um::jobapi2::TerminateJobObject(self.job_handle, 1) != 0 {
                    return Ok(());
                }
                // Job termination failed: if the process already exited the job
                // is effectively empty — treat as success rather than logging an
                // ERROR_ACCESS_DENIED-style false failure.
                if self.process_already_exited() {
                    return Ok(());
                }
                let err = std::io::Error::last_os_error();
                log::warn!(
                    "[WindowsConPtyChild:{}] TerminateJobObject failed: {}",
                    self.pid,
                    err
                );
                return Err(err);
            }

            if self.process_handle.is_null() {
                return Ok(());
            }
            if winapi::um::processthreadsapi::TerminateProcess(self.process_handle, 1) == 0 {
                // The process may already have exited; that's not a real failure
                // and avoids the recurring "Access is denied (os error 5)" noise.
                if self.process_already_exited() {
                    return Ok(());
                }
                let err = std::io::Error::last_os_error();
                log::warn!(
                    "[WindowsConPtyChild:{}] TerminateProcess failed: {}",
                    self.pid,
                    err
                );
                return Err(err);
            }
            Ok(())
        }
    }

    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync + 'static> {
        let mut dup: *mut winapi::ctypes::c_void = std::ptr::null_mut();
        unsafe {
            let ok = winapi::um::handleapi::DuplicateHandle(
                winapi::um::processthreadsapi::GetCurrentProcess(),
                self.process_handle,
                winapi::um::processthreadsapi::GetCurrentProcess(),
                &mut dup,
                0,
                0,
                winapi::um::winnt::DUPLICATE_SAME_ACCESS,
            );
            if ok == 0 {
                log::warn!(
                    "[WindowsConPtyChild:{}] DuplicateHandle failed, falling back to pid-based killer: {}",
                    self.pid,
                    std::io::Error::last_os_error()
                );
                return Box::new(WindowsPidKiller { pid: self.pid });
            }

            // Duplicate the job handle too so the clone can still tree-kill.
            // KILL_ON_JOB_CLOSE only fires when the LAST handle closes, so an
            // extra duplicate is safe and does not terminate the tree early.
            let mut dup_job: *mut winapi::ctypes::c_void = std::ptr::null_mut();
            if !self.job_handle.is_null()
                && winapi::um::handleapi::DuplicateHandle(
                    winapi::um::processthreadsapi::GetCurrentProcess(),
                    self.job_handle,
                    winapi::um::processthreadsapi::GetCurrentProcess(),
                    &mut dup_job,
                    0,
                    0,
                    winapi::um::winnt::DUPLICATE_SAME_ACCESS,
                ) == 0
            {
                log::warn!(
                    "[WindowsConPtyChild:{}] DuplicateHandle(job) failed, clone loses tree-kill: {}",
                    self.pid,
                    std::io::Error::last_os_error()
                );
                dup_job = std::ptr::null_mut();
            }

            Box::new(WindowsConPtyChild {
                pid: self.pid,
                process_handle: dup,
                job_handle: dup_job,
            })
        }
    }
}

#[cfg(target_os = "windows")]
impl WindowsConPtyChild {
    /// Returns true if the underlying process is known to have exited. Used to
    /// distinguish a benign "already dead" kill from a real termination failure.
    unsafe fn process_already_exited(&self) -> bool {
        if self.process_handle.is_null() {
            return true;
        }
        let wait = winapi::um::synchapi::WaitForSingleObject(self.process_handle, 0);
        wait == winapi::um::winbase::WAIT_OBJECT_0
    }
}

#[cfg(target_os = "windows")]
impl portable_pty::Child for WindowsConPtyChild {
    fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
        unsafe {
            if self.process_handle.is_null() {
                return Ok(Some(portable_pty::ExitStatus::with_exit_code(1)));
            }

            let wait = winapi::um::synchapi::WaitForSingleObject(self.process_handle, 0);

            if wait == winapi::shared::winerror::WAIT_TIMEOUT {
                return Ok(None);
            }

            if wait != winapi::um::winbase::WAIT_OBJECT_0 {
                return Err(std::io::Error::last_os_error());
            }

            let mut code: u32 = 0;
            if winapi::um::processthreadsapi::GetExitCodeProcess(self.process_handle, &mut code)
                == 0
            {
                return Err(std::io::Error::last_os_error());
            }

            Ok(Some(portable_pty::ExitStatus::with_exit_code(code)))
        }
    }

    fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
        unsafe {
            if self.process_handle.is_null() {
                return Ok(portable_pty::ExitStatus::with_exit_code(1));
            }

            let wait = winapi::um::synchapi::WaitForSingleObject(
                self.process_handle,
                winapi::um::winbase::INFINITE,
            );
            if wait != winapi::um::winbase::WAIT_OBJECT_0 {
                return Err(std::io::Error::last_os_error());
            }

            let mut code: u32 = 0;
            if winapi::um::processthreadsapi::GetExitCodeProcess(self.process_handle, &mut code)
                == 0
            {
                return Err(std::io::Error::last_os_error());
            }

            Ok(portable_pty::ExitStatus::with_exit_code(code))
        }
    }

    fn process_id(&self) -> Option<u32> {
        Some(self.pid)
    }

    fn as_raw_handle(&self) -> Option<*mut std::ffi::c_void> {
        Some(self.process_handle as *mut std::ffi::c_void)
    }
}
