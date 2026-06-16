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
#   curl -fsSL ${baseUrl}/setup.sh | bash -s -- --harness claude-code --harness codex <api-key>
set -euo pipefail

PP_BASE_URL="${base}"
PP_HARNESSES=""
PP_HARNESS_ARG_COUNT=0
PP_TOKEN=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --harness)
      if [ "$#" -lt 2 ]; then
        echo "--harness requires one of: codex, claude-code, opencode" >&2
        exit 1
      fi
      PP_HARNESSES="$PP_HARNESSES \${2:-}"
      PP_HARNESS_ARG_COUNT=$((PP_HARNESS_ARG_COUNT + 1))
      shift 2
      ;;
    --harness=*)
      PP_HARNESSES="$PP_HARNESSES \${1#--harness=}"
      PP_HARNESS_ARG_COUNT=$((PP_HARNESS_ARG_COUNT + 1))
      shift
      ;;
    -h|--help)
      cat <<'PP_HELP_EOF'
Usage: setup.sh [--harness codex] [--harness claude-code] [--harness opencode] <api-key>

Without --harness, setup.sh configures Claude Code and Codex with one shared key.
Pass --harness more than once to configure multiple harnesses with one shared key.
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

if [ "$PP_HARNESS_ARG_COUNT" -eq 0 ]; then
  PP_HARNESSES="claude-code codex"
fi

PP_SETUP_CLAUDE=0
PP_SETUP_CODEX=0
PP_SETUP_OPENCODE=0
for PP_HARNESS in $PP_HARNESSES; do
  case "$PP_HARNESS" in
    claude-code) PP_SETUP_CLAUDE=1 ;;
    codex) PP_SETUP_CODEX=1 ;;
    opencode) PP_SETUP_OPENCODE=1 ;;
    *)
      echo "Unknown harness: $PP_HARNESS. Use one or more of: codex, claude-code, opencode." >&2
      exit 1
      ;;
  esac
done
PP_HARNESS_COUNT=$((PP_SETUP_CLAUDE + PP_SETUP_CODEX + PP_SETUP_OPENCODE))
if [ "$PP_HARNESS_COUNT" -eq 0 ]; then
  echo "Pick at least one harness: codex, claude-code, opencode." >&2
  exit 1
fi

if [ -z "$PP_TOKEN" ]; then
  PP_TOKEN="\${PROMPT_PROXY_TOKEN:-}"
fi
if [ -z "$PP_TOKEN" ] && ( : < /dev/tty ) 2>/dev/null; then
  printf "Paste your Prompt Proxy API key: " > /dev/tty
  IFS= read -r PP_TOKEN < /dev/tty
fi
if [ -z "$PP_TOKEN" ]; then
  PP_HARNESS_FLAGS=""
  [ "$PP_SETUP_CLAUDE" -eq 1 ] && PP_HARNESS_FLAGS="$PP_HARNESS_FLAGS --harness claude-code"
  [ "$PP_SETUP_CODEX" -eq 1 ] && PP_HARNESS_FLAGS="$PP_HARNESS_FLAGS --harness codex"
  [ "$PP_SETUP_OPENCODE" -eq 1 ] && PP_HARNESS_FLAGS="$PP_HARNESS_FLAGS --harness opencode"
  echo "No API key provided. Re-run as: curl -fsSL $PP_BASE_URL/setup.sh | bash -s --$PP_HARNESS_FLAGS <api-key>" >&2
  exit 1
fi

if [ "$PP_HARNESS_COUNT" -gt 1 ]; then
  PP_TOKEN_PATH="$HOME/.prompt-proxy/token"
  PP_TOKEN_PATH_DISPLAY="~/.prompt-proxy/token"
elif [ "$PP_SETUP_CODEX" -eq 1 ]; then
  PP_TOKEN_PATH="$HOME/.prompt-proxy/codex.token"
  PP_TOKEN_PATH_DISPLAY="~/.prompt-proxy/codex.token"
elif [ "$PP_SETUP_CLAUDE" -eq 1 ]; then
  PP_TOKEN_PATH="$HOME/.prompt-proxy/claude-code.token"
  PP_TOKEN_PATH_DISPLAY="~/.prompt-proxy/claude-code.token"
else
  PP_TOKEN_PATH="$HOME/.prompt-proxy/opencode.token"
  PP_TOKEN_PATH_DISPLAY="~/.prompt-proxy/opencode.token"
fi

if [ "$PP_SETUP_CODEX" -eq 1 ] && [ "$PP_HARNESS_COUNT" -eq 1 ]; then
  PP_CODEX_ENV="PROMPT_PROXY_CODEX_TOKEN"
  PP_CODEX_PROVIDER="prompt_proxy_codex"
else
  PP_CODEX_ENV="PROMPT_PROXY_TOKEN"
  PP_CODEX_PROVIDER="prompt_proxy"
fi

pp_resolved_write_path() {
  local path="$1"
  local target=""

  if [ -L "$path" ]; then
    if command -v realpath >/dev/null 2>&1; then
      target="$(realpath "$path" 2>/dev/null || true)"
    fi
    if [ -z "$target" ]; then
      target="$(readlink "$path")"
      case "$target" in
        /*) ;;
        *) target="$(cd "$(dirname "$path")" && pwd -P)/$target" ;;
      esac
    fi
    printf '%s\\n' "$target"
    return
  fi

  printf '%s\\n' "$path"
}

pp_replace_file() {
  local tmp_file="$1"
  local dest_file="$2"
  local write_path
  write_path="$(pp_resolved_write_path "$dest_file")"
  mv "$tmp_file" "$write_path"
}

mkdir -p "$HOME/.prompt-proxy"
printf '%s\\n' "$PP_TOKEN" > "$PP_TOKEN_PATH"
chmod 600 "$PP_TOKEN_PATH"
echo "key: stored at $PP_TOKEN_PATH_DISPLAY"

if [ "$PP_SETUP_CLAUDE" -eq 1 ]; then
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
if (typeof settings.env.ANTHROPIC_CUSTOM_HEADERS === "string") {
  const customHeaders = settings.env.ANTHROPIC_CUSTOM_HEADERS
    .split(",")
    .map((header) => header.trim())
    .filter((header) => header && !/^x-prompt-proxy-user-id\\s*:/i.test(header));
  if (customHeaders.length > 0) {
    settings.env.ANTHROPIC_CUSTOM_HEADERS = customHeaders.join(", ");
  } else {
    delete settings.env.ANTHROPIC_CUSTOM_HEADERS;
  }
}
settings.apiKeyHelper = "cat " + process.argv[2];
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\\n");
' "$PP_BASE_URL" "$PP_TOKEN_PATH_DISPLAY"
    echo "claude: configured ~/.claude/settings.json"
  else
    echo "claude: node not found - set model/env/apiKeyHelper in ~/.claude/settings.json by hand" >&2
  fi
fi

if [ "$PP_SETUP_CODEX" -eq 1 ]; then
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
      pp_replace_file "$tmp_rc" "$rc"
    else
      printf '\\n%s\\n' "$PP_TOKEN_EXPORT" >> "$rc"
    fi
  done

  mkdir -p "$HOME/.codex"
  codex_config="$HOME/.codex/config.toml"
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
${heredocDelimiter}
    } > "$tmp_config"
    pp_replace_file "$tmp_config" "$codex_config"
    echo "codex: configured $PP_CODEX_PROVIDER as the default provider"
  fi
fi

if [ "$PP_SETUP_OPENCODE" -eq 1 ]; then
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

if [ "$PP_HARNESS_COUNT" -eq 1 ] && [ "$PP_SETUP_CODEX" -eq 1 ]; then
  echo "Done. Open a new terminal and run: codex"
elif [ "$PP_HARNESS_COUNT" -eq 1 ] && [ "$PP_SETUP_CLAUDE" -eq 1 ]; then
  echo "Done. Open a new terminal and run: claude"
elif [ "$PP_HARNESS_COUNT" -eq 1 ] && [ "$PP_SETUP_OPENCODE" -eq 1 ]; then
  echo "Done. Open opencode and select prompt-proxy-chat/router-auto from /models"
else
  PP_LAUNCH=""
  [ "$PP_SETUP_CLAUDE" -eq 1 ] && PP_LAUNCH="$PP_LAUNCH claude"
  [ "$PP_SETUP_CODEX" -eq 1 ] && PP_LAUNCH="$PP_LAUNCH codex"
  if [ -n "$PP_LAUNCH" ]; then
    echo "Done. Open a new terminal and run:$PP_LAUNCH"
  fi
  if [ "$PP_SETUP_OPENCODE" -eq 1 ]; then
    echo "Open opencode and select prompt-proxy-chat/router-auto from /models"
  fi
fi
`;
}
