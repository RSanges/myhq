# Restores the pm2 process list at logon on Windows (README, "Restart at boot
# on Windows"). Started by a scheduled task: calls Node and pm2 by their full
# paths (the logon environment may not be ready for the `pm2` shim), tries a
# few times, and logs each attempt to %USERPROFILE%\.pm2\resurrect-task.log.
# Exits 1 when nothing is online after the last attempt.

$ErrorActionPreference = "Continue"
$log = Join-Path $env:USERPROFILE ".pm2\resurrect-task.log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null

function Write-Log([string]$text) {
  Add-Content -Path $log -Encoding utf8 -Value "$(Get-Date -Format s) $text"
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:ProgramFiles "nodejs\node.exe" }
# A global pm2 installed from a packaged app (an MSIX app such as Claude
# Desktop) lands in that app's redirected AppData, invisible to this task:
# look there too, after the real one.
$pm2 = @(
  (Join-Path $env:APPDATA "npm\node_modules\pm2\bin\pm2")
  Get-ChildItem (Join-Path $env:LOCALAPPDATA "Packages") -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName "LocalCache\Roaming\npm\node_modules\pm2\bin\pm2" }
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $pm2) { $pm2 = Join-Path $env:APPDATA "npm\node_modules\pm2\bin\pm2" }

function Test-Online {
  $list = & $node $pm2 jlist 2>$null | Out-String
  return $list -match '"status"\s*:\s*"online"'
}

for ($attempt = 1; $attempt -le 3; $attempt++) {
  if (-not (Test-Path $node) -or -not (Test-Path $pm2)) {
    Write-Log "attempt ${attempt}: node ($node, found: $(Test-Path $node)) or pm2 ($pm2, found: $(Test-Path $pm2)) missing, as $(whoami)"
  } elseif (Test-Online) {
    Write-Log "attempt ${attempt}: already online, nothing to do"
    exit 0
  } else {
    $output = & $node $pm2 resurrect 2>&1 | Out-String
    Write-Log "attempt ${attempt}: pm2 resurrect exited $LASTEXITCODE`n$($output.Trim())"
    Start-Sleep -Seconds 10
    if (Test-Online) {
      Write-Log "attempt ${attempt}: online"
      exit 0
    }
  }
  Start-Sleep -Seconds 30
}
Write-Log "nothing online after 3 attempts"
exit 1
