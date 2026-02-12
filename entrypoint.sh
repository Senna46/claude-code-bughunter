#!/bin/bash
# Entrypoint for Claude Code BugHunter Docker container.
# Ensures Claude CLI authentication is configured before starting the daemon.
# On macOS, OAuth credentials are stored in Keychain (not files), so
# CLAUDE_CODE_OAUTH_TOKEN env var is required for Docker.

set -euo pipefail

# ============================================================
# Claude CLI authentication setup
# ============================================================

# Ensure ~/.claude.json exists with onboarding completed
# (required for claude -p to skip interactive prompts)
CLAUDE_JSON="/root/.claude.json"
if [ ! -f "$CLAUDE_JSON" ]; then
  echo '{"hasCompletedOnboarding": true}' > "$CLAUDE_JSON"
  echo "[entrypoint] Created $CLAUDE_JSON with onboarding bypass."
elif ! grep -q '"hasCompletedOnboarding"' "$CLAUDE_JSON" 2>/dev/null; then
  # File exists but missing the flag - add it via temp file to preserve content
  python3 -c "
import json, sys
try:
    with open('$CLAUDE_JSON') as f:
        data = json.load(f)
except:
    data = {}
data['hasCompletedOnboarding'] = True
with open('$CLAUDE_JSON', 'w') as f:
    json.dump(data, f, indent=2)
" 2>/dev/null || {
    # Fallback if python3 is not available: overwrite
    echo '{"hasCompletedOnboarding": true}' > "$CLAUDE_JSON"
  }
  echo "[entrypoint] Updated $CLAUDE_JSON with onboarding bypass."
fi

# Validate authentication
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "[entrypoint] CLAUDE_CODE_OAUTH_TOKEN is set. Using OAuth authentication."
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[entrypoint] ANTHROPIC_API_KEY is set. Using API key authentication (pay-as-you-go billing)."
elif [ -f "/root/.claude/.credentials.json" ]; then
  echo "[entrypoint] Found mounted credentials file. Using file-based authentication."
else
  echo "[entrypoint] WARNING: No Claude authentication found."
  echo "[entrypoint]   For Pro/Max plan (macOS Docker):"
  echo "[entrypoint]     1. Run 'claude setup-token' on your Mac"
  echo "[entrypoint]     2. Set CLAUDE_CODE_OAUTH_TOKEN in .env"
  echo "[entrypoint]   For API key:"
  echo "[entrypoint]     Set ANTHROPIC_API_KEY in .env"
  echo "[entrypoint]   For Linux (file-based auth):"
  echo "[entrypoint]     Mount ~/.claude to /root/.claude (already configured in docker-compose.yml)"
fi

# ============================================================
# Start the application
# ============================================================

exec node dist/main.js "$@"
