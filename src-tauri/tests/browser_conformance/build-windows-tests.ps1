# Builds every test executable and puts the Common-Controls v6 manifest next to
# each one. Tauri's windowing code imports comctl32 entry points that exist
# only in v6, and test executables are not linked with the application
# manifest, so without the sidecar they die at load time.
#
# Run from src-tauri. Extra arguments go to `cargo test --no-run`.

$ErrorActionPreference = 'Stop'
$manifest = Join-Path $PSScriptRoot 'comctl32-v6.manifest'

$messages = & cargo test --no-run --message-format=json @args
if ($LASTEXITCODE -ne 0) { throw "cargo test --no-run failed with exit code $LASTEXITCODE" }

$count = 0
foreach ($line in $messages) {
    try { $message = $line | ConvertFrom-Json } catch { continue }
    if ($message.reason -eq 'compiler-artifact' -and $message.profile.test -and $message.executable) {
        Copy-Item -Path $manifest -Destination "$($message.executable).manifest" -Force
        (Get-Item $message.executable).LastWriteTime = Get-Date
        $count++
    }
}
Write-Host "manifest installed next to $count test executables"
