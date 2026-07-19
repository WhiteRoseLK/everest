FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    jq \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
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

RUN chown -R node:node /app
USER node

RUN git config --global user.email "harness@everest.local" \
    && git config --global user.name "Everest Harness" \
    && git config --global --add safe.directory /app \
    && git config --global credential."https://github.com".helper '!gh auth git-credential'

CMD ["npm", "start"]
