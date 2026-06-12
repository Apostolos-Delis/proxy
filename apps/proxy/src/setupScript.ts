const heredocDelimiter = "PP_CODEX_EOF";

// Escapes a value for a double-quoted bash context ("...").
function escapeDoubleQuoted(value: string) {
  return value.replace(/[\\"$`]/g, (char) => `\\${char}`);
}

// The hosted setup script served at GET /setup.sh. It carries no secrets: the
// key arrives as the first argument (`bash -s -- <key>`), the PROMPT_PROXY_TOKEN
// environment variable, or an interactive /dev/tty prompt. Idempotent: safe to
// re-run.
export function buildSetupScript(baseUrl: string) {
  if (baseUrl.includes(heredocDelimiter)) {
    throw new Error(`setup script base URL collides with heredoc delimiter ${heredocDelimiter}`);
  }
  const base = escapeDoubleQuoted(baseUrl);
  return `#!/usr/bin/env bash
# Prompt Proxy setup — routes Claude Code and Codex through the proxy.
#
# Usage:
#   curl -fsSL ${baseUrl}/setup.sh | bash -s -- <api-key>
#
# What it does (idempotent, safe to re-run):
#   1. Stores the key at ~/.prompt-proxy/token (chmod 600).
#   2. Points Claude Code at the proxy via ~/.claude/settings.json.
#   3. Exports PROMPT_PROXY_TOKEN from your shell rc for Codex.
#   4. Registers and selects the prompt_proxy provider in ~/.codex/config.toml.
set -euo pipefail

PP_BASE_URL="${base}"
PP_TOKEN="\${1:-\${PROMPT_PROXY_TOKEN:-}}"
if [ -z "$PP_TOKEN" ] && ( : < /dev/tty ) 2>/dev/null; then
  printf "Paste your Prompt Proxy API key: " > /dev/tty
  IFS= read -r PP_TOKEN < /dev/tty
fi
if [ -z "$PP_TOKEN" ]; then
  echo "No API key provided. Re-run as: curl -fsSL $PP_BASE_URL/setup.sh | bash -s -- <api-key>" >&2
  exit 1
fi

# Identity stamped on every request so the proxy attributes usage to you. The
# proxy reads x-prompt-proxy-user-id; we default to your git email, then $USER.
# Override with PROMPT_PROXY_USER_ID. Empty is fine — the key's owner is used.
PP_USER_ID="\${PROMPT_PROXY_USER_ID:-}"
if [ -z "$PP_USER_ID" ]; then
  PP_USER_ID="$(git config --get user.email 2>/dev/null || true)"
fi
if [ -z "$PP_USER_ID" ]; then
  PP_USER_ID="\${USER:-}"
fi
if [ -n "$PP_USER_ID" ]; then
  echo "identity: requests attribute to $PP_USER_ID (override with PROMPT_PROXY_USER_ID)"
fi

# Key file — read by Claude Code's apiKeyHelper and the shell export below.
mkdir -p "$HOME/.prompt-proxy"
printf '%s\\n' "$PP_TOKEN" > "$HOME/.prompt-proxy/token"
chmod 600 "$HOME/.prompt-proxy/token"
echo "key: stored at ~/.prompt-proxy/token"

# Claude Code — scoped to ~/.claude/settings.json so other Anthropic tools
# on this machine are untouched. Overwrites model/env/apiKeyHelper.
if command -v node >/dev/null 2>&1; then
  mkdir -p "$HOME/.claude"
  node -e '
const fs = require("fs");
const file = process.env.HOME + "/.claude/settings.json";
let settings = {};
try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
settings.model = "claude-router-auto";
settings.env = Object.assign({}, settings.env, {
  ANTHROPIC_BASE_URL: process.argv[1],
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
});
if (process.argv[2]) {
  settings.env.ANTHROPIC_CUSTOM_HEADERS = "x-prompt-proxy-user-id: " + process.argv[2];
}
settings.apiKeyHelper = "cat ~/.prompt-proxy/token";
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\\n");
' "$PP_BASE_URL" "$PP_USER_ID"
  echo "claude: configured ~/.claude/settings.json"
else
  echo "claude: node not found — set model/env/apiKeyHelper in ~/.claude/settings.json by hand" >&2
fi

# Codex reads the key from the shell environment (env_key).
[ -f "$HOME/.zshrc" ] || [ -f "$HOME/.bashrc" ] || touch "$HOME/.zshrc"
PP_TOKEN_EXPORT='export PROMPT_PROXY_TOKEN="$(cat ~/.prompt-proxy/token)"'
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  [ -f "$rc" ] || continue
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?PROMPT_PROXY_TOKEN=' "$rc"; then
    tmp_rc="$(mktemp)"
    awk -v desired="$PP_TOKEN_EXPORT" '
      /^[[:space:]]*(export[[:space:]]+)?PROMPT_PROXY_TOKEN=/ {
        if (!replaced) print desired
        replaced = 1
        next
      }
      { print }
    ' "$rc" > "$tmp_rc"
    mv "$tmp_rc" "$rc"
  else
    printf '\\n%s\\n' "$PP_TOKEN_EXPORT" >> "$rc"
  fi
done

# Codex provider registration.
mkdir -p "$HOME/.codex"
codex_config="$HOME/.codex/config.toml"
# Stamp the same identity header Claude Code sends, when we resolved one.
if [ -n "$PP_USER_ID" ]; then
  PP_CODEX_HEADERS="http_headers = { \\"x-prompt-proxy-user-id\\" = \\"$PP_USER_ID\\" }"
else
  PP_CODEX_HEADERS=""
fi
if [ ! -s "$codex_config" ]; then
  cat > "$codex_config" <<PP_CODEX_EOF
model = "router-auto"
model_provider = "prompt_proxy"

[model_providers.prompt_proxy]
name = "Prompt Proxy"
base_url = "$PP_BASE_URL/v1"
env_key = "PROMPT_PROXY_TOKEN"
wire_api = "responses"
supports_websockets = true
$PP_CODEX_HEADERS
PP_CODEX_EOF
  echo "codex: wrote ~/.codex/config.toml"
else
  tmp_config="$(mktemp)"
  {
    printf '%s\\n' 'model = "router-auto"'
    printf '%s\\n\\n' 'model_provider = "prompt_proxy"'
    awk '
      /^\\[model_providers\\.prompt_proxy\\]$/ { skipping = 1; seen_table = 1; next }
      /^\\[/ {
        skipping = 0
        seen_table = 1
      }
      skipping { next }
      !seen_table && /^[[:space:]]*model[[:space:]]*=/ { next }
      !seen_table && /^[[:space:]]*model_provider[[:space:]]*=/ { next }
      { print }
    ' "$codex_config"
    cat <<PP_CODEX_EOF

[model_providers.prompt_proxy]
name = "Prompt Proxy"
base_url = "$PP_BASE_URL/v1"
env_key = "PROMPT_PROXY_TOKEN"
wire_api = "responses"
supports_websockets = true
$PP_CODEX_HEADERS
PP_CODEX_EOF
  } > "$tmp_config"
  mv "$tmp_config" "$codex_config"
  echo "codex: configured prompt_proxy as the default provider"
fi

echo "Done. Open a new terminal and run: claude  (or codex)"
`;
}
