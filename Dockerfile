FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    jq \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh gosu \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# Lets code running inside the container (see runChat in src/cli.ts) tell it's already sandboxed
# here, so `everest chat` skips nesting another `docker compose exec` hop - the image has no
# Docker client/socket to do that with - and instead runs `claude` directly in this process.
ENV EVEREST_IN_CONTAINER=1

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .
RUN npm run typecheck

RUN mkdir -p /app/.harness && chown -R node:node /app

# Pin HOME to node's home. The container now starts as root and drops to node via gosu (see the
# entrypoint below), but gosu does NOT set $HOME, and `docker compose exec -u node` doesn't either
# - so without this, git/gh/claude at runtime would look in /root instead of /home/node and miss
# the config written just below (identity, credential helper) and the claude_home volume state.
ENV HOME=/home/node

# Write the git config into node's home as node, so it lands in /home/node/.gitconfig (preserved
# across recreation via the claude_home volume - see docker-compose.yml).
USER node
RUN git config --global user.email "harness@everest.local" \
    && git config --global user.name "Everest Harness" \
    && git config --global --add safe.directory /app \
    && git config --global credential."https://github.com".helper '!gh auth git-credential'

# Back to root so the entrypoint can realign /app's ownership onto node at runtime (see
# docker-entrypoint.sh / issue #84) before dropping privileges to node via gosu. The build-time
# chown above can't help here: the '.:/app' bind mount replaces /app's ownership at runtime, and
# under rootless Docker the host repo maps to root inside the container, leaving node unable to
# write .git. Container therefore starts as root purely to fix this up, then runs as node.
USER root
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "start"]
