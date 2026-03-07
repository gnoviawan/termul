#[cfg(target_os = "windows")]
pub mod git_bash_paths {
    /// Primary Git Bash installation paths (Program Files)
    pub const PRIMARY_PATHS: &[&str] = &[
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
    ];

    /// Fallback Git Bash paths for non-standard installations
    pub const FALLBACK_PATHS: &[&str] = &[
        r"C:\tools\msys64\usr\bin\bash.exe",
        r"C:\msys64\usr\bin\bash.exe",
        r"C:\Git\bin\bash.exe",
        r"C:\Git\usr\bin\bash.exe",
    ];
}