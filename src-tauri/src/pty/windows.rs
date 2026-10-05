//! Windows-specific PTY utilities
//!
//! This module provides Windows-specific PTY spawning functionality using ConPTY.

use std::fs::File;
use std::mem::{size_of, MaybeUninit};
use std::os::windows::io::FromRawHandle;
use winapi::ctypes::c_void;

/// ADR-004.2: Build a Windows command-line string from an argv array using the
/// `CommandLineToArgvW` escaping rules.
///
/// ConPTY ultimately consumes a single command-*line* string (via
/// `CreateProcessW`). To launch an agent safely we must convert a discrete argv
/// array into that string ourselves rather than concatenating user text into a
/// shell command line. This is the ONE audited quoting site for the
/// terminal-native agent launcher; do not hand-roll quoting elsewhere.
///
/// The algorithm is the inverse of `CommandLineToArgvW` (see Daniel Colascione,
/// "Everybody quotes command line arguments the wrong way"):
/// - An argument is quoted when it is empty or contains a space, tab, newline,
///   vertical tab, or double-quote.
/// - Backslashes are literal unless they immediately precede a double-quote (or
///   the closing quote of a quoted argument), in which case each backslash in
///   that run is doubled.
/// - Embedded double-quotes are escaped as `\"`.
///
/// Because the resulting string is handed to `CreateProcessW` directly (never to
/// `cmd.exe /c`), `cmd` metacharacters (`&`, `|`, `^`, `%`) are not interpreted.
pub fn build_windows_command_line(program: &str, args: &[String]) -> String {
    let mut cmdline = String::new();
    append_quoted_arg(&mut cmdline, program);
    for arg in args {
        cmdline.push(' ');
        append_quoted_arg(&mut cmdline, arg);
    }
    cmdline
}

fn arg_needs_quoting(arg: &str) -> bool {
    arg.is_empty()
        || arg
            .chars()
            .any(|c| matches!(c, ' ' | '\t' | '\n' | '\x0b' | '"'))
}

fn append_quoted_arg(cmdline: &mut String, arg: &str) {
    if !arg_needs_quoting(arg) {
        cmdline.push_str(arg);
        return;
    }

    cmdline.push('"');

    let mut chars = arg.chars().peekable();
    loop {
        let mut backslashes = 0usize;
        while matches!(chars.peek(), Some('\\')) {
            chars.next();
            backslashes += 1;
        }

        match chars.next() {
            None => {
                // End of argument: backslashes precede the closing quote, so
                // double them to keep them literal.
                for _ in 0..backslashes * 2 {
                    cmdline.push('\\');
                }
                break;
            }
            Some('"') => {
                // Backslashes precede a literal quote: double them, then escape
                // the quote itself.
                for _ in 0..backslashes * 2 + 1 {
                    cmdline.push('\\');
                }
                cmdline.push('"');
            }
            Some(c) => {
                // Backslashes not before a quote stay literal.
                for _ in 0..backslashes {
                    cmdline.push('\\');
                }
                cmdline.push(c);
            }
        }
    }

    cmdline.push('"');
}

/// ConPTY handles owned for a terminal lifecycle.
pub struct ConPtyHandles {
    hpcon: *mut c_void,
}

impl ConPtyHandles {
    pub fn raw_hpcon(&self) -> *mut c_void {
        self.hpcon
    }
}

// SAFETY: ConPtyHandles is only accessed through the Arc<Mutex<...>> wrapper in
// TerminalInstance, ensuring exclusive access. The HPCON handle is valid for the
// lifetime of the struct and closed exactly once in Drop.
unsafe impl Send for ConPtyHandles {}

// SAFETY: ConPtyHandles is only accessed through the Arc<Mutex<...>> wrapper in
// TerminalInstance, ensuring exclusive access. The HPCON handle is valid for the
// lifetime of the struct and closed exactly once in Drop.
unsafe impl Sync for ConPtyHandles {}

impl Drop for ConPtyHandles {
    fn drop(&mut self) {
        if !self.hpcon.is_null() {
            unsafe {
                winapi::um::consoleapi::ClosePseudoConsole(self.hpcon);
            }
            self.hpcon = std::ptr::null_mut();
        }
    }
}

type ConPtySpawnResult = (
    Box<dyn std::io::Read + Send>,
    Box<dyn std::io::Write + Send>,
    u32,
    *mut c_void,
    // Job Object handle (KILL_ON_JOB_CLOSE) owning the child process tree, or
    // null if the Job Object could not be created/assigned. Owned by the caller.
    *mut c_void,
    ConPtyHandles,
);

fn validate_conpty_size(cols: u16, rows: u16) -> std::io::Result<winapi::um::wincon::COORD> {
    fn validate_dimension(value: u16, name: &str) -> std::io::Result<i16> {
        if value == 0 || value > i16::MAX as u16 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("ConPTY {} must be between 1 and {} cells", name, i16::MAX),
            ));
        }

        Ok(value as i16)
    }

    Ok(winapi::um::wincon::COORD {
        X: validate_dimension(cols, "columns")?,
        Y: validate_dimension(rows, "rows")?,
    })
}

pub fn resize_conpty(handles: &ConPtyHandles, cols: u16, rows: u16) -> std::io::Result<()> {
    if handles.raw_hpcon().is_null() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "ConPTY handle is null",
        ));
    }

    let size = validate_conpty_size(cols, rows)?;

    let result = unsafe { winapi::um::consoleapi::ResizePseudoConsole(handles.raw_hpcon(), size) };
    if result != 0 {
        return Err(std::io::Error::other(format!(
            "ResizePseudoConsole failed: HRESULT 0x{:08X}",
            result
        )));
    }

    Ok(())
}

/// Convert Rust string to Windows UTF-16 string
fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn env_to_wide_block(env: &std::collections::HashMap<String, String>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    let mut entries: Vec<String> = env.iter().map(|(k, v)| format!("{}={}", k, v)).collect();
    entries.sort();

    let mut block: Vec<u16> = Vec::new();
    for entry in entries {
        block.extend(std::ffi::OsStr::new(&entry).encode_wide());
        block.push(0);
    }

    while matches!(block.last(), Some(0)) {
        block.pop();
    }

    block.push(0);
    block.push(0);

    block
}

/// Create a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and assign
/// `process` to it. When the returned handle is closed, the OS terminates the
/// process and its entire descendant tree. Returns a null handle (and logs a
/// warning) if the job could not be created, configured, or assigned, in which
/// case the caller proceeds with the process running but without tree-kill.
#[cfg(target_os = "windows")]
unsafe fn create_kill_on_close_job(process: *mut c_void) -> *mut c_void {
    use winapi::um::jobapi2::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    };
    use winapi::um::winnt::{
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
    if job.is_null() {
        log::warn!(
            "[ConPTY] CreateJobObject failed, orphan protection disabled: {}",
            std::io::Error::last_os_error()
        );
        return std::ptr::null_mut();
    }

    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        &mut info as *mut _ as *mut c_void,
        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
    ) == 0
    {
        log::warn!(
            "[ConPTY] SetInformationJobObject failed, orphan protection disabled: {}",
            std::io::Error::last_os_error()
        );
        winapi::um::handleapi::CloseHandle(job);
        return std::ptr::null_mut();
    }

    // Nested jobs are supported on Win8+/Win10+ (ConPTY requires Win10+), so
    // assignment is safe even if the child is already in a job.
    if AssignProcessToJobObject(job, process) == 0 {
        log::warn!(
            "[ConPTY] AssignProcessToJobObject failed, orphan protection disabled: {}",
            std::io::Error::last_os_error()
        );
        winapi::um::handleapi::CloseHandle(job);
        return std::ptr::null_mut();
    }

    job
}

/// Spawn a command using Windows ConPTY with proper flags to hide console window
///
/// This function uses the Windows ConPTY API directly to spawn processes
/// without showing the console window (the main issue with portable-pty 0.9).
///
/// # Returns
/// A tuple of (reader, writer, pid, process_handle, job_handle, conpty_handles)
pub fn spawn_conpty(
    command: &str,
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
    env: &std::collections::HashMap<String, String>,
) -> std::io::Result<ConPtySpawnResult> {
    #[cfg(not(target_os = "windows"))]
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "ConPTY is Windows-only",
        ));
    }

    #[cfg(target_os = "windows")]
    unsafe {
        use winapi::shared::minwindef::*;
        use winapi::um::consoleapi::{ClosePseudoConsole, CreatePseudoConsole};
        use winapi::um::handleapi::{CloseHandle, SetHandleInformation};
        use winapi::um::processthreadsapi::{
            CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
            UpdateProcThreadAttribute, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
        };
        use winapi::um::winbase::{EXTENDED_STARTUPINFO_PRESENT, HANDLE_FLAG_INHERIT};
        use winapi::um::wincontypes::HPCON;

        // PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE value from Windows SDK
        const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: DWORD = 0x00020016;

        // 1. Create anonymous pipes for stdin/stdout
        let mut input_read: *mut c_void = std::ptr::null_mut();
        let mut input_write: *mut c_void = std::ptr::null_mut();
        let mut output_read: *mut c_void = std::ptr::null_mut();
        let mut output_write: *mut c_void = std::ptr::null_mut();

        let mut sa = winapi::um::minwinbase::SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<winapi::um::minwinbase::SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };

        if winapi::um::namedpipeapi::CreatePipe(
            &mut input_read,
            &mut input_write,
            &mut sa as *mut _,
            0,
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }

        if winapi::um::namedpipeapi::CreatePipe(
            &mut output_read,
            &mut output_write,
            &mut sa as *mut _,
            0,
        ) == 0
        {
            CloseHandle(input_read);
            CloseHandle(input_write);
            return Err(std::io::Error::last_os_error());
        }

        if SetHandleInformation(input_write, HANDLE_FLAG_INHERIT, 0) == 0 {
            CloseHandle(input_read);
            CloseHandle(input_write);
            CloseHandle(output_read);
            CloseHandle(output_write);
            return Err(std::io::Error::last_os_error());
        }
        if SetHandleInformation(output_read, HANDLE_FLAG_INHERIT, 0) == 0 {
            CloseHandle(input_read);
            CloseHandle(input_write);
            CloseHandle(output_read);
            CloseHandle(output_write);
            return Err(std::io::Error::last_os_error());
        }

        // 2. Create the pseudo console
        let mut hpcon: HPCON = std::ptr::null_mut();
        let size = validate_conpty_size(cols, rows)?;
        let result = CreatePseudoConsole(size, input_read, output_write, 0, &mut hpcon);

        if result != 0 {
            CloseHandle(input_read);
            CloseHandle(input_write);
            CloseHandle(output_read);
            CloseHandle(output_write);
            return Err(std::io::Error::other(format!(
                "CreatePseudoConsole failed: HRESULT 0x{:08X}",
                result
            )));
        }

        // 3. Initialize the attribute list
        let mut attr_list_size: usize = 0;
        InitializeProcThreadAttributeList(
            std::ptr::null_mut(),
            1,
            0,
            &mut attr_list_size as *mut _,
        );

        let attr_list_words = attr_list_size.div_ceil(size_of::<usize>()).max(1);
        let mut attr_list_storage: Vec<MaybeUninit<usize>> =
            vec![MaybeUninit::uninit(); attr_list_words];
        let attr_list = attr_list_storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;

        if InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_list_size) == 0 {
            CloseHandle(input_read);
            CloseHandle(input_write);
            CloseHandle(output_read);
            CloseHandle(output_write);
            ClosePseudoConsole(hpcon);
            return Err(std::io::Error::last_os_error());
        }

        // 4. Set PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
        if UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            hpcon,
            std::mem::size_of::<HPCON>(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) == 0
        {
            DeleteProcThreadAttributeList(attr_list);
            CloseHandle(input_read);
            CloseHandle(input_write);
            CloseHandle(output_read);
            CloseHandle(output_write);
            ClosePseudoConsole(hpcon);
            return Err(std::io::Error::last_os_error());
        }

        // 5. Create STARTUPINFOEXW with pseudo-console attribute
        let mut si: winapi::um::winbase::STARTUPINFOEXW = std::mem::zeroed();
        si.StartupInfo.cb = std::mem::size_of::<winapi::um::winbase::STARTUPINFOEXW>() as u32;
        si.lpAttributeList = attr_list;

        // 6. Prepare command line and environment
        let mut cmd_line = to_wide(command);
        let cwd_wide = cwd.map(to_wide);
        let mut env_block = env_to_wide_block(env);

        // 7. Create the process
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let create_result = CreateProcessW(
            std::ptr::null(),
            cmd_line.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            EXTENDED_STARTUPINFO_PRESENT
                | winapi::um::winbase::CREATE_UNICODE_ENVIRONMENT
                | winapi::um::winbase::CREATE_SUSPENDED,
            env_block.as_mut_ptr() as *mut _,
            cwd_wide
                .as_ref()
                .map_or(std::ptr::null_mut(), |p| p.as_ptr() as *const _ as *mut _),
            &mut si.StartupInfo as *mut _ as *mut _,
            &mut pi,
        );

        if create_result == 0 {
            DeleteProcThreadAttributeList(attr_list);
            CloseHandle(input_read);
            CloseHandle(input_write);
            CloseHandle(output_read);
            CloseHandle(output_write);
            ClosePseudoConsole(hpcon);
            return Err(std::io::Error::last_os_error());
        }

        DeleteProcThreadAttributeList(attr_list);

        // 7b. Assign the child to a Job Object configured to kill the whole
        // process tree when the job handle closes. This is the core fix for the
        // ConPTY orphan leak (#281): even if app-side cleanup is deferred or the
        // app exits uncleanly, the OS reaps the entire descendant tree when the
        // owning handle (held by the terminal instance) is closed. It also kills
        // grandchildren that single-PID TerminateProcess misses. On any failure
        // we log and continue with a null job handle — no regression vs. before.
        let job = create_kill_on_close_job(pi.hProcess);

        // Resume the child only after it is in the job so no grandchild can
        // escape assignment (#281 spawn race).
        if winapi::um::processthreadsapi::ResumeThread(pi.hThread) == u32::MAX {
            let err = std::io::Error::last_os_error();
            log::warn!("[ConPTY] ResumeThread failed: {}", err);
            let _ = winapi::um::processthreadsapi::TerminateProcess(pi.hProcess, 1);
            if !job.is_null() {
                winapi::um::handleapi::CloseHandle(job);
            }
            winapi::um::handleapi::CloseHandle(pi.hProcess);
            winapi::um::handleapi::CloseHandle(pi.hThread);
            CloseHandle(input_read);
            CloseHandle(input_write);
            CloseHandle(output_read);
            CloseHandle(output_write);
            ClosePseudoConsole(hpcon);
            return Err(err);
        }

        // 8. Close ConPTY's pipe ends (we keep our ends)
        CloseHandle(input_read);
        CloseHandle(output_write);

        // 9. Create reader and writer from our pipe ends
        // std:: uses its own c_void; winapi handles must be cast at the boundary.
        let reader = Box::new(File::from_raw_handle(output_read as *mut std::ffi::c_void))
            as Box<dyn std::io::Read + Send>;
        let writer = Box::new(File::from_raw_handle(input_write as *mut std::ffi::c_void))
            as Box<dyn std::io::Write + Send>;

        let conpty_handles = ConPtyHandles { hpcon };

        CloseHandle(pi.hThread);

        Ok((
            reader,
            writer,
            pi.dwProcessId,
            pi.hProcess,
            job,
            conpty_handles,
        ))
    }
}

#[cfg(test)]
mod tests;
