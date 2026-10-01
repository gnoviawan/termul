param([int]$Seconds = 10)
$procs = Get-Process termul-manager -ErrorAction SilentlyContinue
if (-not $procs) { "no termul-manager"; exit }
$start = @{}
foreach ($p in $procs) { $start[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds }
$startWall = Get-Date
Start-Sleep -Seconds $Seconds
$elapsed = ((Get-Date) - $startWall).TotalMilliseconds
foreach ($p in (Get-Process termul-manager)) {
  $delta = $p.TotalProcessorTime.TotalMilliseconds - $start[$p.Id]
  $pct = [math]::Round($delta / ($elapsed * [Environment]::ProcessorCount) * 100, 1)
  $cores = [math]::Round($delta / $elapsed, 2)
  "PID $($p.Id): ${pct}% of machine (${cores} cores busy) WS=$([math]::Round($p.WorkingSet64/1MB))MB Threads=$($p.Threads.Count)"
}
# per-thread top consumers of the busiest PID
$busy = Get-Process termul-manager | Sort-Object CPU -Descending | Select-Object -First 1
"--- top threads PID $($busy.Id) ---"
$busy.Threads | Sort-Object TotalProcessorTime -Descending | Select-Object -First 6 Id, @{n='CPU_s';e={[math]::Round($_.TotalProcessorTime.TotalSeconds,1)}}, ThreadState | Format-Table -AutoSize
