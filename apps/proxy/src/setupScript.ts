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
#   4. Registers the prompt_proxy provider in ~/.codex/config.toml.
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
settings.apiKeyHelper = "cat ~/.prompt-proxy/token";
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\\n");
' "$PP_BASE_URL"
  echo "claude: configured ~/.claude/settings.json"
else
  echo "claude: node not found — set model/env/apiKeyHelper in ~/.claude/settings.json by hand" >&2
fi

# Codex reads the key from the shell environment (env_key).
[ -f "$HOME/.zshrc" ] || [ -f "$HOME/.bashrc" ] || touch "$HOME/.zshrc"
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  [ -f "$rc" ] || continue
  if ! grep -q "PROMPT_PROXY_TOKEN" "$rc"; then
    printf '\\nexport PROMPT_PROXY_TOKEN="$(cat ~/.prompt-proxy/token)"\\n' >> "$rc"
  fi
done

# Codex provider registration.
mkdir -p "$HOME/.codex"
codex_config="$HOME/.codex/config.toml"
if [ -s "$codex_config" ] && grep -qF "[model_providers.prompt_proxy]" "$codex_config"; then
  echo "codex: provider already configured"
elif [ ! -s "$codex_config" ]; then
  cat > "$codex_config" <<PP_CODEX_EOF
model = "router-auto"
model_provider = "prompt_proxy"

[model_providers.prompt_proxy]
name = "Prompt Proxy"
base_url = "$PP_BASE_URL/v1"
env_key = "PROMPT_PROXY_TOKEN"
wire_api = "responses"
supports_websockets = true
PP_CODEX_EOF
  echo "codex: wrote ~/.codex/config.toml"
else
  cat >> "$codex_config" <<PP_CODEX_EOF

[model_providers.prompt_proxy]
name = "Prompt Proxy"
base_url = "$PP_BASE_URL/v1"
env_key = "PROMPT_PROXY_TOKEN"
wire_api = "responses"
supports_websockets = true
PP_CODEX_EOF
  echo "codex: appended the prompt_proxy provider to ~/.codex/config.toml"
  echo "codex: to make it the default, add these two lines at the TOP of that file:" >&2
  echo '  model = "router-auto"' >&2
  echo '  model_provider = "prompt_proxy"' >&2
fi

echo "Done. Open a new terminal and run: claude  (or codex)"
`;
}
