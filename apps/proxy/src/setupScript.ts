const heredocDelimiter = "PP_CODEX_EOF";

function escapeDoubleQuoted(value: string) {
  return value.replace(/[\\"$`]/g, (char) => `\\${char}`);
}

export function buildSetupScript(baseUrl: string) {
  if (baseUrl.includes(heredocDelimiter)) {
    throw new Error(`setup script base URL collides with heredoc delimiter ${heredocDelimiter}`);
  }
  const base = escapeDoubleQuoted(baseUrl);
  return `#!/usr/bin/env bash
# Prompt Proxy setup.
#
# Usage:
#   curl -fsSL ${baseUrl}/setup.sh | bash -s -- <api-key>
#   curl -fsSL ${baseUrl}/setup.sh | bash -s -- --harness codex <api-key>
#   curl -fsSL ${baseUrl}/setup.sh | bash -s -- --harness claude-code <api-key>
#   curl -fsSL ${baseUrl}/setup.sh | bash -s -- --harness opencode <api-key>
set -euo pipefail

PP_BASE_URL="${base}"
PP_HARNESS="all"
PP_TOKEN=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --harness)
      if [ "$#" -lt 2 ]; then
        echo "--harness requires one of: all, codex, claude-code, opencode" >&2
        exit 1
      fi
      PP_HARNESS="\${2:-}"
      shift 2
      ;;
    --harness=*)
      PP_HARNESS="\${1#--harness=}"
      shift
      ;;
    -h|--help)
      cat <<'PP_HELP_EOF'
Usage: setup.sh [--harness all|codex|claude-code|opencode] <api-key>

Without --harness, setup.sh configures Claude Code and Codex with one shared key.
Use a harness-specific mode when you want different API keys or routing configs per harness.
PP_HELP_EOF
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      if [ -z "$PP_TOKEN" ]; then
        PP_TOKEN="$1"
        shift
      else
        echo "Unexpected argument: $1" >&2
        exit 1
      fi
      ;;
  esac
done

while [ "$#" -gt 0 ]; do
  if [ -z "$PP_TOKEN" ]; then
    PP_TOKEN="$1"
    shift
  else
    echo "Unexpected argument: $1" >&2
    exit 1
  fi
done

case "$PP_HARNESS" in
  both|multi|multiple) PP_HARNESS="all" ;;
  claude) PP_HARNESS="claude-code" ;;
  open-code) PP_HARNESS="opencode" ;;
esac

case "$PP_HARNESS" in
  all|codex|claude-code|opencode) ;;
  *)
    echo "Unknown harness: $PP_HARNESS. Use one of: all, codex, claude-code, opencode." >&2
    exit 1
    ;;
esac

if [ -z "$PP_TOKEN" ]; then
  PP_TOKEN="\${PROMPT_PROXY_TOKEN:-}"
fi
if [ -z "$PP_TOKEN" ] && ( : < /dev/tty ) 2>/dev/null; then
  printf "Paste your Prompt Proxy API key: " > /dev/tty
  IFS= read -r PP_TOKEN < /dev/tty
fi
if [ -z "$PP_TOKEN" ]; then
  echo "No API key provided. Re-run as: curl -fsSL $PP_BASE_URL/setup.sh | bash -s -- --harness $PP_HARNESS <api-key>" >&2
  exit 1
fi

case "$PP_HARNESS" in
  codex)
    PP_TOKEN_PATH="$HOME/.prompt-proxy/codex.token"
    PP_TOKEN_PATH_DISPLAY="~/.prompt-proxy/codex.token"
    PP_CODEX_ENV="PROMPT_PROXY_CODEX_TOKEN"
    PP_CODEX_PROVIDER="prompt_proxy_codex"
    ;;
  claude-code)
    PP_TOKEN_PATH="$HOME/.prompt-proxy/claude-code.token"
    PP_TOKEN_PATH_DISPLAY="~/.prompt-proxy/claude-code.token"
    PP_CODEX_ENV=""
    PP_CODEX_PROVIDER=""
    ;;
  opencode)
    PP_TOKEN_PATH="$HOME/.prompt-proxy/opencode.token"
    PP_TOKEN_PATH_DISPLAY="~/.prompt-proxy/opencode.token"
    PP_CODEX_ENV=""
    PP_CODEX_PROVIDER=""
    ;;
  *)
    PP_TOKEN_PATH="$HOME/.prompt-proxy/token"
    PP_TOKEN_PATH_DISPLAY="~/.prompt-proxy/token"
    PP_CODEX_ENV="PROMPT_PROXY_TOKEN"
    PP_CODEX_PROVIDER="prompt_proxy"
    ;;
esac

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

mkdir -p "$HOME/.prompt-proxy"
printf '%s\\n' "$PP_TOKEN" > "$PP_TOKEN_PATH"
chmod 600 "$PP_TOKEN_PATH"
echo "key: stored at $PP_TOKEN_PATH_DISPLAY"

if [ "$PP_HARNESS" = "all" ] || [ "$PP_HARNESS" = "claude-code" ]; then
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
settings.apiKeyHelper = "cat " + process.argv[3];
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\\n");
' "$PP_BASE_URL" "$PP_USER_ID" "$PP_TOKEN_PATH_DISPLAY"
    echo "claude: configured ~/.claude/settings.json"
  else
    echo "claude: node not found - set model/env/apiKeyHelper in ~/.claude/settings.json by hand" >&2
  fi
fi

if [ "$PP_HARNESS" = "all" ] || [ "$PP_HARNESS" = "codex" ]; then
  [ -f "$HOME/.zshrc" ] || [ -f "$HOME/.bashrc" ] || touch "$HOME/.zshrc"
  PP_TOKEN_EXPORT="export \${PP_CODEX_ENV}=\\"\\$(cat \${PP_TOKEN_PATH_DISPLAY})\\""
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    [ -f "$rc" ] || continue
    if grep -Eq "^[[:space:]]*(export[[:space:]]+)?\${PP_CODEX_ENV}=" "$rc"; then
      tmp_rc="$(mktemp)"
      awk -v desired="$PP_TOKEN_EXPORT" -v env="$PP_CODEX_ENV" '
        $0 ~ "^[[:space:]]*(export[[:space:]]+)?" env "=" {
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

  mkdir -p "$HOME/.codex"
  codex_config="$HOME/.codex/config.toml"
  if [ -n "$PP_USER_ID" ]; then
    PP_CODEX_HEADERS="http_headers = { \\"x-prompt-proxy-user-id\\" = \\"$PP_USER_ID\\" }"
  else
    PP_CODEX_HEADERS=""
  fi
  if [ ! -s "$codex_config" ]; then
    cat > "$codex_config" <<${heredocDelimiter}
model = "router-auto"
model_provider = "$PP_CODEX_PROVIDER"

[model_providers.$PP_CODEX_PROVIDER]
name = "Prompt Proxy"
base_url = "$PP_BASE_URL/v1"
env_key = "$PP_CODEX_ENV"
wire_api = "responses"
supports_websockets = true
$PP_CODEX_HEADERS
${heredocDelimiter}
    echo "codex: wrote ~/.codex/config.toml"
  else
    tmp_config="$(mktemp)"
    {
      printf '%s\\n' 'model = "router-auto"'
      printf 'model_provider = "%s"\\n\\n' "$PP_CODEX_PROVIDER"
      awk -v table="[model_providers.$PP_CODEX_PROVIDER]" '
        $0 == table { skipping = 1; seen_table = 1; next }
        /^\\[/ {
          skipping = 0
          seen_table = 1
        }
        skipping { next }
        !seen_table && /^[[:space:]]*model[[:space:]]*=/ { next }
        !seen_table && /^[[:space:]]*model_provider[[:space:]]*=/ { next }
        { print }
      ' "$codex_config"
      cat <<${heredocDelimiter}

[model_providers.$PP_CODEX_PROVIDER]
name = "Prompt Proxy"
base_url = "$PP_BASE_URL/v1"
env_key = "$PP_CODEX_ENV"
wire_api = "responses"
supports_websockets = true
$PP_CODEX_HEADERS
${heredocDelimiter}
    } > "$tmp_config"
    mv "$tmp_config" "$codex_config"
    echo "codex: configured $PP_CODEX_PROVIDER as the default provider"
  fi
fi

if [ "$PP_HARNESS" = "opencode" ]; then
  if command -v node >/dev/null 2>&1; then
    PP_OPENCODE_CONFIG_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
    PP_OPENCODE_DATA_DIR="\${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
    PP_OPENCODE_CONFIG_FILE="$PP_OPENCODE_CONFIG_DIR/opencode.json"
    PP_OPENCODE_AUTH_FILE="$PP_OPENCODE_DATA_DIR/auth.json"
    mkdir -p "$PP_OPENCODE_CONFIG_DIR" "$PP_OPENCODE_DATA_DIR"
    node -e '
const fs = require("fs");
const configFile = process.argv[1];
const authFile = process.argv[2];
const baseUrl = process.argv[3];
const token = process.argv[4];
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}
const config = readJson(configFile);
const existingProvider = (config.provider || {})["prompt-proxy-chat"] || {};
config["$schema"] = config["$schema"] || "https://opencode.ai/config.json";
config.provider = Object.assign({}, config.provider || {}, {
  "prompt-proxy-chat": Object.assign({}, existingProvider, {
    npm: "@ai-sdk/openai-compatible",
    name: "Prompt Proxy Chat",
    options: Object.assign({}, existingProvider.options || {}, { baseURL: baseUrl + "/v1" }),
    models: Object.assign({}, existingProvider.models || {}, {
      "router-auto": { name: "Router Auto" },
      "router-fast": { name: "Router Fast" },
      "router-balanced": { name: "Router Balanced" },
      "router-hard": { name: "Router Hard" },
      "router-deep": { name: "Router Deep" }
    })
  })
});
config.model = config.model || "prompt-proxy-chat/router-auto";
config.small_model = config.small_model || "prompt-proxy-chat/router-fast";
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\\n");
const auth = readJson(authFile);
auth["prompt-proxy-chat"] = { type: "api", key: token };
fs.writeFileSync(authFile, JSON.stringify(auth, null, 2) + "\\n", { mode: 0o600 });
fs.chmodSync(authFile, 0o600);
' "$PP_OPENCODE_CONFIG_FILE" "$PP_OPENCODE_AUTH_FILE" "$PP_BASE_URL" "$PP_TOKEN"
    echo "opencode: configured ~/.config/opencode/opencode.json"
    echo "opencode: stored credential in ~/.local/share/opencode/auth.json"
  else
    echo "opencode: node not found - run /connect and paste the key from $PP_TOKEN_PATH_DISPLAY" >&2
  fi
fi

case "$PP_HARNESS" in
  codex) echo "Done. Open a new terminal and run: codex" ;;
  claude-code) echo "Done. Open a new terminal and run: claude" ;;
  opencode) echo "Done. Open opencode and select prompt-proxy-chat/router-auto from /models" ;;
  *) echo "Done. Open a new terminal and run: claude  (or codex)" ;;
esac
`;
}
