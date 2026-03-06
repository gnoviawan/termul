//! Windows-specific PTY utilities
//!
//! This module provides Windows-specific PTY spawning functionality using ConPTY.

use std::ffi::c_void;
use std::fs::File;
use std::mem::{size_of, MaybeUninit};
use std::os::windows::io::FromRawHandle;

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
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("ResizePseudoConsole failed: HRESULT 0x{:08X}", result),
        ));
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

/// Spawn a command using Windows ConPTY with proper flags to hide console window
///
/// This function uses the Windows ConPTY API directly to spawn processes
/// without showing the console window (the main issue with portable-pty 0.9).
///
/// # Returns
/// A tuple of (reader, writer, pid, process_handle, conpty_handles)
pub fn spawn_conpty(
    command: &str,
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
    env: &std::collections::HashMap<String, String>,
) -> std::io::Result<(
    Box<dyn std::io::Read + Send>,
    Box<dyn std::io::Write + Send>,
    u32,
    *mut c_void,
    ConPtyHandles,
)> {
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
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("CreatePseudoConsole failed: HRESULT 0x{:08X}", result),
            ));
        }

        // 3. Initialize the attribute list
        let mut attr_list_size: usize = 0;
        InitializeProcThreadAttributeList(
            std::ptr::null_mut(),
            1,
            0,
            &mut attr_list_size as *mut _ as *mut usize,
        );

        let attr_list_words =
            ((attr_list_size + size_of::<usize>() - 1) / size_of::<usize>()).max(1);
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
            hpcon as *mut c_void,
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
            EXTENDED_STARTUPINFO_PRESENT | winapi::um::winbase::CREATE_UNICODE_ENVIRONMENT,
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

        // 8. Close ConPTY's pipe ends (we keep our ends)
        CloseHandle(input_read);
        CloseHandle(output_write);

        // 9. Create reader and writer from our pipe ends
        let reader = Box::new(File::from_raw_handle(output_read)) as Box<dyn std::io::Read + Send>;
        let writer = Box::new(File::from_raw_handle(input_write)) as Box<dyn std::io::Write + Send>;

        let conpty_handles = ConPtyHandles {
            hpcon: hpcon as *mut c_void,
        };

        CloseHandle(pi.hThread);

        Ok((
            reader,
            writer,
            pi.dwProcessId,
            pi.hProcess as *mut c_void,
            conpty_handles,
        ))
    }
}
