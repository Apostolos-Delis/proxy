export const keyPlaceholder = "<your-api-key>";

const heredocDelimiters = ["PP_SETUP_EOF", "PP_TOKEN_EOF", "PP_CODEX_EOF"];

// Escapes a value for a double-quoted bash context ("...").
function escapeDoubleQuoted(value: string) {
  return value.replace(/[\\"$`]/g, (char) => `\\${char}`);
}

// One copy-paste script that configures Claude Code (~/.claude/settings.json,
// scoped so ANTHROPIC_* never leaks into the shell) and Codex (provider block
// + PROMPT_PROXY_TOKEN shell export). Wrapped in `bash -s <<'…'` so set -e and
// shell state stay in a child shell. Idempotent: safe to re-run.
export function buildSetupScript({ apiBase, secret }: { apiBase: string; secret: string | null }) {
  const key = secret ?? keyPlaceholder;
  for (const delimiter of heredocDelimiters) {
    if (key.includes(delimiter) || apiBase.includes(delimiter)) {
      throw new Error(`setup script input collides with heredoc delimiter ${delimiter}`);
    }
  }
  const base = escapeDoubleQuoted(apiBase);
  return `bash -s <<'PP_SETUP_EOF'
set -euo pipefail

# Key file — read by Claude Code's apiKeyHelper and the shell hook below.
mkdir -p "$HOME/.prompt-proxy"
cat > "$HOME/.prompt-proxy/token" <<'PP_TOKEN_EOF'
${key}
PP_TOKEN_EOF
chmod 600 "$HOME/.prompt-proxy/token"

# Claude Code — scoped to ~/.claude/settings.json so other Anthropic tools
# on this machine are untouched. Overwrites model/env/apiKeyHelper.
if command -v node >/dev/null 2>&1; then
  mkdir -p "$HOME/.claude"
  node -e '
const fs = require("fs");
const file = \`\${process.env.HOME}/.claude/settings.json\`;
let settings = {};
try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
settings.model = "claude-router-auto";
settings.env = Object.assign({}, settings.env, {
  ANTHROPIC_BASE_URL: process.argv[1],
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
});
settings.apiKeyHelper = "cat ~/.prompt-proxy/token";
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\\n");
' "${base}"
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
  cat > "$codex_config" <<'PP_CODEX_EOF'
model = "router-auto"
model_provider = "prompt_proxy"

[model_providers.prompt_proxy]
name = "Prompt Proxy"
base_url = "${apiBase}/v1"
env_key = "PROMPT_PROXY_TOKEN"
wire_api = "responses"
supports_websockets = true
PP_CODEX_EOF
  echo "codex: wrote ~/.codex/config.toml"
else
  cat >> "$codex_config" <<'PP_CODEX_EOF'

[model_providers.prompt_proxy]
name = "Prompt Proxy"
base_url = "${apiBase}/v1"
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
PP_SETUP_EOF`;
}
