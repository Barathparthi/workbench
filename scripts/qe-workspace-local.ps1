<#
.SYNOPSIS
  QE Workspace in your browser, on this machine only (PHASE_10 §10.6).

.DESCRIPTION
  Runs deploy/compose/docker-compose.local-web.yml with a fresh sign-in token, waits for the IDE and shows the link
  to open (this console only: the token is never written to a log). Settings, all optional:
    QE_RUNTIME_IMAGE  the IDE image (default qews/runtime:dev)
    QE_LOCAL_PORT     the port on 127.0.0.1 (default 3000)
    QE_SSH_DIR        your SSH folder, mounted read-only (default $HOME\.ssh)

.EXAMPLE
  .\scripts\qe-workspace-local.ps1 C:\src\my-project
  .\scripts\qe-workspace-local.ps1 -Stop
#>
param(
  [string]$ProjectDir = '.',
  [switch]$Stop,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'

$compose = Join-Path $PSScriptRoot '..\deploy\compose\docker-compose.local-web.yml'

if ($Stop) {
  docker compose -p qe-workspace-local down
  exit $LASTEXITCODE
}

$project = (Resolve-Path $ProjectDir).Path
$sshDir = if ($env:QE_SSH_DIR) { $env:QE_SSH_DIR } else { Join-Path $HOME '.ssh' }
if (-not (Test-Path $sshDir -PathType Container)) {
  # Docker would create a missing folder; give it an empty one instead.
  $sshDir = Join-Path ([System.IO.Path]::GetTempPath()) ("qe-empty-ssh-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $sshDir | Out-Null
  Write-Host "No SSH folder found: personal targets will be empty."
}
$port = if ($env:QE_LOCAL_PORT) { $env:QE_LOCAL_PORT } else { '3000' }

# 256 random bits, base64url.
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

$env:QE_PROJECT_DIR = $project
$env:QE_SSH_DIR = $sshDir
$env:QE_LOCAL_PORT = $port
$env:QE_LOCAL_WEB_TOKEN = $token
try {
  docker compose -f $compose up -d --force-recreate | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'docker compose failed' }
} finally {
  # Only the container needs it.
  Remove-Item Env:QE_LOCAL_WEB_TOKEN
}

# The link uses localhost: webviews (Markdown preview, plugin panels) open on their own <id>.webview.localhost origin.
$url = "http://localhost:$port"
Write-Host -NoNewline "Starting QE Workspace for $project "
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
  # Up means it refuses us: 401 without the sign-in cookie.
  try {
    Invoke-WebRequest -Uri "$url/" -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 2 | Out-Null
  } catch {
    $response = $_.Exception.Response
    if ($null -ne $response -and [int]$response.StatusCode -eq 401) { $ready = $true; break }
  }
  Write-Host -NoNewline '.'
  Start-Sleep -Seconds 1
}
Write-Host ''
if (-not $ready) {
  Write-Error 'QE Workspace did not start. See: docker compose -p qe-workspace-local logs'
}

$link = "$url/?token=$token"
Write-Host 'QE Workspace is running. Open this link (it signs this browser in; keep it to yourself):'
Write-Host ''
Write-Host "  $link"
Write-Host ''
Write-Host "Stop it with: $PSCommandPath -Stop"
if (-not $NoBrowser) { Start-Process $link }
