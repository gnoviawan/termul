# Ralph Wiggum Stop Hook (Windows/PowerShell)
# Prevents session exit when a ralph-loop is active
# Feeds Claude's output back as input to continue the loop

$ErrorActionPreference = "Stop"

# Debug log file
$DEBUG_LOG = ".claude/ralph-debug.log"

function Write-DebugLog {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $DEBUG_LOG -Value "[$timestamp] $Message" -ErrorAction SilentlyContinue
}

Write-DebugLog "=== Stop hook triggered ==="

# Read hook input from stdin (advanced stop hook API)
$hookInput = $input | Out-String
Write-DebugLog "Hook input received: $($hookInput.Substring(0, [Math]::Min(500, $hookInput.Length)))"

# Check if ralph-loop is active
$ralphStateFile = ".claude/ralph-loop.local.md"

if (-not (Test-Path $ralphStateFile)) {
    # No active loop - allow exit
    Write-DebugLog "No state file found - allowing exit"
    exit 0
}

Write-DebugLog "State file found - processing loop"

# Read the state file
$content = Get-Content $ralphStateFile -Raw

# Parse YAML frontmatter (between --- markers)
$frontmatterMatch = [regex]::Match($content, '(?s)^---\r?\n(.*?)\r?\n---')
if (-not $frontmatterMatch.Success) {
    Write-Host "Ralph loop: State file corrupted (no frontmatter found)" -ForegroundColor Red
    Write-DebugLog "ERROR: No frontmatter found"
    Remove-Item $ralphStateFile -Force
    exit 0
}

$frontmatter = $frontmatterMatch.Groups[1].Value

# Parse frontmatter values
$iteration = 0
$maxIterations = 0
$completionPromise = $null

foreach ($line in $frontmatter -split '\r?\n') {
    if ($line -match '^iteration:\s*(.+)$') {
        $iteration = [int]$Matches[1]
    }
    elseif ($line -match '^max_iterations:\s*(.+)$') {
        $maxIterations = [int]$Matches[1]
    }
    elseif ($line -match '^completion_promise:\s*"?([^"]*)"?$') {
        $completionPromise = $Matches[1]
        if ($completionPromise -eq 'null') {
            $completionPromise = $null
        }
    }
}

# Validate iteration is a valid number
if ($iteration -lt 0) {
    Write-Host "Ralph loop: State file corrupted - 'iteration' is invalid" -ForegroundColor Red
    Write-DebugLog "ERROR: Invalid iteration value: $iteration"
    Remove-Item $ralphStateFile -Force
    exit 0
}

Write-DebugLog "Parsed: iteration=$iteration, max=$maxIterations, promise=$completionPromise"

# Check if max iterations reached
if ($maxIterations -gt 0 -and $iteration -ge $maxIterations) {
    Write-Host "Ralph loop: Max iterations ($maxIterations) reached."
    Write-DebugLog "Max iterations reached - stopping loop"
    Remove-Item $ralphStateFile -Force
    exit 0
}

# Get transcript path from hook input (JSON)
try {
    $hookData = $hookInput | ConvertFrom-Json
    $transcriptPath = $hookData.transcript_path
    Write-DebugLog "Transcript path: $transcriptPath"
}
catch {
    Write-Host "Ralph loop: Failed to parse hook input as JSON" -ForegroundColor Red
    Write-Host "Error: $_" -ForegroundColor Red
    Write-DebugLog "ERROR: Failed to parse transcript_path from hook input"
    Remove-Item $ralphStateFile -Force
    exit 0
}

if (-not $transcriptPath -or -not (Test-Path $transcriptPath)) {
    Write-Host "Ralph loop: Transcript file not found" -ForegroundColor Red
    Write-Host "Expected: $transcriptPath" -ForegroundColor Red
    Write-DebugLog "ERROR: Transcript file not found at: $transcriptPath"
    Remove-Item $ralphStateFile -Force
    exit 0
}

# Read transcript (JSONL format - one JSON per line)
$transcriptLines = Get-Content $transcriptPath

# Find last assistant message
$lastAssistantLine = $null
foreach ($line in $transcriptLines) {
    if ($line -match '"role"\s*:\s*"assistant"') {
        $lastAssistantLine = $line
    }
}

if (-not $lastAssistantLine) {
    Write-Host "Ralph loop: No assistant messages found in transcript" -ForegroundColor Red
    Write-DebugLog "ERROR: No assistant messages in transcript"
    Remove-Item $ralphStateFile -Force
    exit 0
}

Write-DebugLog "Found assistant line: $($lastAssistantLine.Substring(0, [Math]::Min(200, $lastAssistantLine.Length)))"

# Parse the assistant message JSON
try {
    $assistantMsg = $lastAssistantLine | ConvertFrom-Json
    $textContent = @()
    foreach ($block in $assistantMsg.message.content) {
        if ($block.type -eq 'text') {
            $textContent += $block.text
        }
    }
    $lastOutput = $textContent -join "`n"
}
catch {
    Write-Host "Ralph loop: Failed to parse assistant message JSON" -ForegroundColor Red
    Write-Host "Error: $_" -ForegroundColor Red
    Write-DebugLog "ERROR: Failed to parse assistant message JSON: $_"
    Remove-Item $ralphStateFile -Force
    exit 0
}

if ([string]::IsNullOrEmpty($lastOutput)) {
    Write-Host "Ralph loop: Assistant message contained no text content" -ForegroundColor Red
    Write-DebugLog "ERROR: No text content in assistant message"
    Remove-Item $ralphStateFile -Force
    exit 0
}

Write-DebugLog "Extracted text: $($lastOutput.Substring(0, [Math]::Min(200, $lastOutput.Length)))"

# Check for completion promise (only if set)
if ($completionPromise) {
    # Extract text from <promise> tags
    $promiseMatch = [regex]::Match($lastOutput, '<promise>(.*?)</promise>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($promiseMatch.Success) {
        $promiseText = $promiseMatch.Groups[1].Value.Trim()
        # Normalize whitespace
        $promiseText = $promiseText -replace '\s+', ' '

        if ($promiseText -eq $completionPromise) {
            Write-Host "Ralph loop: Detected <promise>$completionPromise</promise>"
            Remove-Item $ralphStateFile -Force
            exit 0
        }
    }
}

# Not complete - continue loop with SAME PROMPT
$nextIteration = $iteration + 1

# Extract prompt (everything after the closing ---)
$promptMatch = [regex]::Match($content, '(?s)^---\r?\n.*?\r?\n---\r?\n(.*)$')
if (-not $promptMatch.Success -or [string]::IsNullOrWhiteSpace($promptMatch.Groups[1].Value)) {
    Write-Host "Ralph loop: State file corrupted - no prompt text found" -ForegroundColor Red
    Write-DebugLog "ERROR: No prompt text found in state file"
    Remove-Item $ralphStateFile -Force
    exit 0
}

$promptText = $promptMatch.Groups[1].Value.Trim()
Write-DebugLog "Extracted prompt: $($promptText.Substring(0, [Math]::Min(100, $promptText.Length)))"

# Update iteration in state file
$newContent = $content -replace 'iteration:\s*\d+', "iteration: $nextIteration"
Set-Content $ralphStateFile -Value $newContent -NoNewline

# Build system message
if ($completionPromise) {
    $systemMsg = "Ralph iteration $nextIteration | To stop: output <promise>$completionPromise</promise> (ONLY when statement is TRUE - do not lie to exit!)"
}
else {
    $systemMsg = "Ralph iteration $nextIteration | No completion promise set - loop runs infinitely"
}

# Output JSON to block the stop and feed prompt back
$result = @{
    decision = "block"
    reason = $promptText
    systemMessage = $systemMsg
} | ConvertTo-Json -Compress

Write-DebugLog "SUCCESS: Blocking exit, continuing to iteration $nextIteration"
Write-Output $result

exit 0
