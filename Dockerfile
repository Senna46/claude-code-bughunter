# Dockerfile for Claude Code BugHunter
# Multi-stage build: installs dependencies, builds TypeScript, then
# runs the daemon with gh CLI, claude CLI, and git available.
# Requires mounting gh and claude auth configs as volumes.

# ============================================================
# Stage 1: Build
# ============================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ============================================================
# Stage 2: Runtime
# ============================================================
FROM node:22-bookworm-slim

# Install git and gh CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy built application and production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ ./dist/

# Configure git identity and credential helper for automated commits
RUN git config --global user.email "bughunter@claude-code.local" \
  && git config --global user.name "Claude Code BugHunter" \
  && git config --global credential.https://github.com.helper "!/usr/bin/gh auth git-credential"

# Create directories for state and repos
RUN mkdir -p /data/repos /data/db

ENV BUGHUNTER_WORK_DIR=/data/repos
ENV BUGHUNTER_DB_PATH=/data/db/state.db

# Copy entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
