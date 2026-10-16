use std::path::Path;
use std::time::{Duration, Instant};

use super::hide_console;

pub(crate) const EXIT_TIMEOUT: Duration = Duration::from_secs(10);

/// PowerShell that starts a hidden `ping -n 60` grandchild, writes its PID to
/// `pid_file`, then sleeps for a minute (a launcher that outlives the test).
pub(crate) fn grandchild_launcher_script(pid_file: &Path) -> String {
    format!(
        "$p = Start-Process -FilePath ping.exe -ArgumentList '-n','60','127.0.0.1' \
         -WindowStyle Hidden -PassThru; \
         Set-Content -LiteralPath '{}' -Value $p.Id; \
         Start-Sleep -Seconds 60",
        pid_file.display()
    )
}

pub(crate) fn powershell_args(script: &str) -> Vec<String> {
    [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]
    .map(str::to_string)
    .to_vec()
}

pub(crate) fn read_pid_file(path: &Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(pid) = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| text.trim().parse().ok())
        {
            return pid;
        }
        assert!(
            Instant::now() < deadline,
            "launcher never wrote {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn open_process(pid: u32) -> std::io::Result<Option<winapi::um::winnt::HANDLE>> {
    use winapi::shared::winerror::ERROR_INVALID_PARAMETER;
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::winnt::SYNCHRONIZE;

    // SAFETY: plain Win32 call; the caller closes a returned handle.
    let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
    if !handle.is_null() {
        return Ok(Some(handle));
    }
    let error = std::io::Error::last_os_error();
    // OpenProcess reports a nonexistent PID as ERROR_INVALID_PARAMETER.
    if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
        Ok(None)
    } else {
        Err(error)
    }
}

fn try_wait_for_exit(pid: u32, timeout: Duration) -> std::io::Result<bool> {
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::synchapi::WaitForSingleObject;
    use winapi::um::winbase::WAIT_OBJECT_0;

    let Some(handle) = open_process(pid)? else {
        return Ok(true);
    };
    let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
    // SAFETY: `handle` is a live process handle, closed before returning.
    unsafe {
        let exited = WaitForSingleObject(handle, millis) == WAIT_OBJECT_0;
        CloseHandle(handle);
        Ok(exited)
    }
}

pub(crate) fn is_alive(pid: u32) -> bool {
    !try_wait_for_exit(pid, Duration::ZERO)
        .unwrap_or_else(|error| panic!("cannot query process {pid}: {error}"))
}

pub(crate) fn wait_for_exit(pid: u32, timeout: Duration) -> bool {
    try_wait_for_exit(pid, timeout)
        .unwrap_or_else(|error| panic!("cannot query process {pid}: {error}"))
}

pub(crate) struct KillOnFail(pub(crate) u32);

impl Drop for KillOnFail {
    fn drop(&mut self) {
        if matches!(try_wait_for_exit(self.0, Duration::ZERO), Ok(false)) {
            let mut command = std::process::Command::new("taskkill");
            hide_console(&mut command);
            let _ = command.args(["/F", "/PID", &self.0.to_string()]).output();
        }
    }
}
