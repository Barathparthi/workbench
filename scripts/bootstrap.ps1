# Developer bootstrap (Windows PowerShell): checks the toolchain, installs dependencies and builds.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$requiredNode = (Get-Content .nvmrc -Raw).Trim()
$requiredMajor = $requiredNode.Split(".")[0]

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js $requiredNode is required (see .nvmrc). Install it with nvm-windows or fnm."
}

$currentNode = (node --version).TrimStart("v")
if ($currentNode.Split(".")[0] -ne $requiredMajor) {
  Write-Error "Node.js $requiredMajor.x is required (found $currentNode)."
}
if ($currentNode -ne $requiredNode) {
  Write-Warning ".nvmrc pins Node.js $requiredNode; you have $currentNode."
}

Write-Host "node $(node --version), npm $(npm --version)"

if (Get-Command docker -ErrorAction SilentlyContinue) {
  Write-Host "docker: $(docker --version)"
} else {
  Write-Warning "Docker not found. It is needed for integration tests and the local dev stack (Phase 03+)."
}

npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Bootstrap complete. Next: npm run verify"
