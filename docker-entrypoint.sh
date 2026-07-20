#!/usr/bin/env bash
# Container entrypoint: realigns ownership of the bind-mounted repo (/app) onto the `node` user,
# then drops privileges to `node` before running the actual command.
#
# Why this is needed (issue #84): docker-compose.yml bind-mounts the host repo at `.:/app`. Under
# rootless Docker (the deployment target - see CLAUDE.md), the host user owning the repo (uid 1000)
# maps to *root* inside the container, while the harness must run as the non-root `node` user
# (Claude Code's bypassPermissions refuses to run as root). So `node` (a subordinate uid on the
# host) can't write to /app/.git, and every `git checkout`/`commit`/`fetch` fails with EACCES,
# stalling the whole loop before it can pick up a single issue. The Dockerfile's build-time
# `chown` doesn't help: the bind mount replaces /app's contents *and* ownership at runtime. The
# container therefore starts as root (= the host user under rootless) purely to fix this up here,
# at runtime, once the bind mount is live.
set -euo pipefail

if [ "$(id -u)" = "0" ]; then
  # `-xdev` keeps find on the bind mount's own filesystem, so it does NOT descend into volumes
  # mounted over subpaths of /app (node_modules, .harness, /home/node) - those are separate,
  # already node-owned, and potentially large. `-not -user node` makes restarts near-instant once
  # the repo is already aligned. A chown failure on a stray path shouldn't abort startup: warn and
  # press on rather than leaving the container in a crash loop.
  find /app -xdev \! -user node -exec chown node:node {} + ||
    echo "entrypoint: warning: some paths under /app could not be chowned to node" >&2
  exec gosu node "$@"
fi

# Already non-root (e.g. the container was started with an explicit `user:`): nothing to realign,
# just run the command as-is.
exec "$@"
