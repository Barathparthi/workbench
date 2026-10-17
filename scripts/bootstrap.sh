#!/usr/bin/env bash
# Developer bootstrap (Linux/macOS): checks the toolchain, installs dependencies and builds.
set -euo pipefail

cd "$(dirname "$0")/.."

required_node="$(tr -d '[:space:]' < .nvmrc)"
required_major="${required_node%%.*}"

if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js ${required_node} is required (see .nvmrc). Install it with nvm: nvm install" >&2
  exit 1
fi

current_node="$(node --version | sed 's/^v//')"
if [ "${current_node%%.*}" != "${required_major}" ]; then
  echo "error: Node.js ${required_major}.x is required (found ${current_node}). Run: nvm install && nvm use" >&2
  exit 1
fi
if [ "${current_node}" != "${required_node}" ]; then
  echo "warning: .nvmrc pins Node.js ${required_node}; you have ${current_node}."
fi

echo "node $(node --version), npm $(npm --version)"

if command -v docker >/dev/null 2>&1; then
  echo "docker: $(docker --version)"
else
  echo "warning: Docker not found. It is needed for integration tests and the local dev stack (Phase 03+)."
fi

npm ci
npm run build

echo
echo "Bootstrap complete. Next: npm run verify"
