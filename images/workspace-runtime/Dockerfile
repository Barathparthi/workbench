# syntax=docker/dockerfile:1
# Workspace runtime, development image (02_PHASES/PHASE_02 §2.7; hardened and slimmed in Phase 05):
# the browser IDE serving /home/qe/project on port 3000, as UID 1000.
#
#   docker build -f images/workspace-runtime/Dockerfile -t qews/runtime:dev .
#   docker run --rm -p 127.0.0.1:3000:3000 -e QE_MODE=local-web -v "$PWD":/home/qe/project qews/runtime:dev
#
# The IDE has no login of its own: publish the port on 127.0.0.1 only (local web token: Phase 10; hosted
# gateway and NetworkPolicy: Phase 05). QE_MODE defaults to hosted, which refuses to start (exit 78) until
# QE_CONTROL_PLANE_URL and QE_WORKSPACE_ID are set, so a pod is never silently a local-web IDE.
#
# Built-in VS Code plugins are added when QE_VSX_URL names the Open VSX mirror (pinned and hash-checked).

FROM node:24.22.0-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0 AS build
# Native modules (native-keymap, keytar) compile against these headers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libx11-dev libxkbfile-dev libsecret-1-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
ARG QE_VSX_URL=""
RUN npm ci \
 && npm run build -w @qe/theia-qe-core \
 && npm run build -w @qe/ide-browser \
 && if [ -n "$QE_VSX_URL" ]; then npm run plugins:download; else mkdir -p plugins; fi \
 && npm prune --omit=dev

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git less libsecret-1-0 libstdc++6 openssh-client procps \
      python3 python3-pip python3-venv ripgrep tini vim-tiny \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 --shell /bin/bash qe \
 && install -d -o qe -g qe /home/qe/project
# Phase 05 hardening: no setuid/setgid binaries, so the user's shell has no route to root.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true
COPY --from=build /usr/local/bin/node /usr/local/bin/node
# Application files belong to root: the qe user can read and run them but not change them.
COPY --from=build --chown=root:root /src /opt/qe-workspace
# UTF-8 terminals and tools by default (Phase 06); TERM is set per terminal by the QE terminal policy.
ENV NODE_ENV=production QE_MODE=hosted LANG=C.UTF-8 LC_ALL=C.UTF-8
USER 1000:1000
WORKDIR /home/qe/project
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/qe-workspace/apps/ide-browser/lib/backend/main.js", "/home/qe/project", \
     "--hostname=0.0.0.0", "--port=3000", "--plugins=local-dir:/opt/qe-workspace/plugins"]
