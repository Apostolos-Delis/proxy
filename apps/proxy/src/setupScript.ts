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
Setup updates only Prompt Proxy-owned marker blocks and reports unmarked conflicts.
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

pp_has_marker() {
  local dest_file="$1"
  local marker="$2"
  local write_path
  write_path="$(pp_resolved_write_path "$dest_file")"
  [ -f "$write_path" ] || return 1
  awk -v marker="$marker" '$0 == marker { found = 1; exit } END { exit found ? 0 : 1 }' "$write_path"
}

pp_write_marked_block() {
  local dest_file="$1"
  local begin_marker="$2"
  local end_marker="$3"
  local content_file="$4"
  local mode="\${5:-append}"
  local write_path
  local tmp_file
  write_path="$(pp_resolved_write_path "$dest_file")"
  mkdir -p "$(dirname "$write_path")"
  tmp_file="$(mktemp)"

  if [ -f "$write_path" ]; then
    awk -v begin="$begin_marker" -v end="$end_marker" -v content="$content_file" -v mode="$mode" '
      function emit_block() {
        print begin
        while ((getline line < content) > 0) print line
        close(content)
        print end
      }
      BEGIN {
        replaced = 0
        skipping = 0
        if (mode == "prepend") emit_block()
      }
      $0 == begin {
        if (!replaced && mode != "prepend") emit_block()
        replaced = 1
        skipping = 1
        next
      }
      $0 == end && skipping {
        skipping = 0
        next
      }
      skipping { next }
      { print }
      END {
        if (!replaced && mode != "prepend") {
          if (NR > 0) print ""
          emit_block()
        }
      }
    ' "$write_path" > "$tmp_file"
  else
    {
      printf '%s\\n' "$begin_marker"
      cat "$content_file"
      printf '%s\\n' "$end_marker"
    } > "$tmp_file"
  fi

  pp_replace_file "$tmp_file" "$dest_file"
}

pp_toml_has_top_key() {
  local dest_file="$1"
  local key="$2"
  local write_path
  write_path="$(pp_resolved_write_path "$dest_file")"
  [ -f "$write_path" ] || return 1
  awk -v key="$key" '
    BEGIN { status = 1 }
    /^[[:space:]]*\\[/ { exit }
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { status = 0; exit }
    END { exit status }
  ' "$write_path"
}

pp_toml_has_table() {
  local dest_file="$1"
  local table="$2"
  local write_path
  write_path="$(pp_resolved_write_path "$dest_file")"
  [ -f "$write_path" ] || return 1
  awk -v table="$table" '
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)
      if (line == table) { found = 1; exit }
      split(line, parts, "#")
      line = parts[1]
      sub(/[[:space:]]+$/, "", line)
      if (line == table) { found = 1; exit }
    }
    END { exit found ? 0 : 1 }
  ' "$write_path"
}

mkdir -p "$HOME/.prompt-proxy"
printf '%s\\n' "$PP_TOKEN" > "$PP_TOKEN_PATH"
chmod 600 "$PP_TOKEN_PATH"
echo "key: stored at $PP_TOKEN_PATH_DISPLAY"

if [ "$PP_SETUP_CLAUDE" -eq 1 ]; then
  if command -v node >/dev/null 2>&1; then
    mkdir -p "$HOME/.claude"
    PP_CLAUDE_MARKER_FILE="$HOME/.prompt-proxy/claude-code-settings.marker.json"
    node -e '
const fs = require("fs");
const file = process.env.HOME + "/.claude/settings.json";
const markerFile = process.argv[3];
let settings = {};
let marker = {};
try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
try { marker = JSON.parse(fs.readFileSync(markerFile, "utf8")); } catch {}
const managed = new Set(Array.isArray(marker.fields) ? marker.fields : []);
const nextManaged = [];
const conflicts = [];
function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
function setTopLevel(key, value) {
  if (settings[key] === undefined || managed.has(key)) {
    settings[key] = value;
    nextManaged.push(key);
  } else {
    conflicts.push(key);
  }
}
function setEnv(key, value) {
  const path = "env." + key;
  if (settings.env[key] === undefined || managed.has(path)) {
    settings.env[key] = value;
    nextManaged.push(path);
  } else {
    conflicts.push(path);
  }
}
setTopLevel("model", "claude-router-auto");
if (!isObject(settings.env)) {
  if (settings.env === undefined || managed.has("env")) {
    settings.env = {};
    nextManaged.push("env");
  } else {
    conflicts.push("env");
  }
}
if (isObject(settings.env)) {
  setEnv("ANTHROPIC_BASE_URL", process.argv[1]);
  setEnv("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "1");
}
setTopLevel("apiKeyHelper", "cat " + process.argv[2]);
if (isObject(settings.env) && typeof settings.env.ANTHROPIC_CUSTOM_HEADERS === "string") {
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
if (conflicts.length > 0) {
  console.error("claude: found user-managed settings outside Prompt Proxy marker: " + conflicts.join(", ") + "; leaving them unchanged");
}
if (nextManaged.length > 0) {
  fs.writeFileSync(markerFile, JSON.stringify({ version: 1, harness: "claude-code", fields: nextManaged }, null, 2) + "\\n", { mode: 0o600 });
  fs.chmodSync(markerFile, 0o600);
}
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\\n");
' "$PP_BASE_URL" "$PP_TOKEN_PATH_DISPLAY" "$PP_CLAUDE_MARKER_FILE"
    echo "claude: configured ~/.claude/settings.json"
  else
    echo "claude: node not found - set model/env/apiKeyHelper in ~/.claude/settings.json by hand" >&2
  fi
fi

if [ "$PP_SETUP_CODEX" -eq 1 ]; then
  [ -f "$HOME/.zshrc" ] || [ -f "$HOME/.bashrc" ] || touch "$HOME/.zshrc"
  PP_TOKEN_EXPORT="export \${PP_CODEX_ENV}=\\"\\$(cat \${PP_TOKEN_PATH_DISPLAY})\\""
  PP_RC_BEGIN="# >>> prompt-proxy codex $PP_CODEX_ENV >>>"
  PP_RC_END="# <<< prompt-proxy codex $PP_CODEX_ENV <<<"
  tmp_rc_block="$(mktemp)"
  printf '%s\\n' "$PP_TOKEN_EXPORT" > "$tmp_rc_block"
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    [ -f "$rc" ] || continue
    if pp_has_marker "$rc" "$PP_RC_BEGIN"; then
      pp_write_marked_block "$rc" "$PP_RC_BEGIN" "$PP_RC_END" "$tmp_rc_block"
    elif awk -v env="$PP_CODEX_ENV" '$0 ~ "^[[:space:]]*(export[[:space:]]+)?" env "=" { found = 1; exit } END { exit found ? 0 : 1 }' "$(pp_resolved_write_path "$rc")"; then
      echo "codex: found unmarked $PP_CODEX_ENV in $rc; leaving it unchanged" >&2
    else
      pp_write_marked_block "$rc" "$PP_RC_BEGIN" "$PP_RC_END" "$tmp_rc_block"
    fi
  done

  PP_CODEX_HOME="\${CODEX_HOME:-$HOME/.codex}"
  if [ "$PP_CODEX_HOME" = "$HOME/.codex" ]; then
    PP_CODEX_CONFIG_DISPLAY="~/.codex/config.toml"
  else
    PP_CODEX_CONFIG_DISPLAY="$PP_CODEX_HOME/config.toml"
  fi
  mkdir -p "$PP_CODEX_HOME"
  codex_config="$PP_CODEX_HOME/config.toml"
  codex_config_existed=0
  [ -s "$codex_config" ] && codex_config_existed=1
  PP_CODEX_DEFAULTS_BEGIN="# >>> prompt-proxy codex defaults >>>"
  PP_CODEX_DEFAULTS_END="# <<< prompt-proxy codex defaults <<<"
  PP_CODEX_PROVIDER_BEGIN="# >>> prompt-proxy codex provider $PP_CODEX_PROVIDER >>>"
  PP_CODEX_PROVIDER_END="# <<< prompt-proxy codex provider $PP_CODEX_PROVIDER <<<"
  tmp_codex_defaults="$(mktemp)"
  cat > "$tmp_codex_defaults" <<${heredocDelimiter}
model = "gpt-5.5"
model_provider = "$PP_CODEX_PROVIDER"
${heredocDelimiter}
  tmp_codex_provider="$(mktemp)"
  cat > "$tmp_codex_provider" <<${heredocDelimiter}

[model_providers.$PP_CODEX_PROVIDER]
name = "Prompt Proxy"
base_url = "$PP_BASE_URL/v1"
env_key = "$PP_CODEX_ENV"
wire_api = "responses"
supports_websockets = false
${heredocDelimiter}

  codex_provider_conflict=0
  if ! pp_has_marker "$codex_config" "$PP_CODEX_PROVIDER_BEGIN" && pp_toml_has_table "$codex_config" "[model_providers.$PP_CODEX_PROVIDER]"; then
    codex_provider_conflict=1
  fi
  codex_defaults_conflict=0
  if pp_toml_has_top_key "$codex_config" "model" || pp_toml_has_top_key "$codex_config" "model_provider"; then
    codex_defaults_conflict=1
  fi

  if pp_has_marker "$codex_config" "$PP_CODEX_DEFAULTS_BEGIN"; then
    pp_write_marked_block "$codex_config" "$PP_CODEX_DEFAULTS_BEGIN" "$PP_CODEX_DEFAULTS_END" "$tmp_codex_defaults" prepend
  elif [ "$codex_provider_conflict" -eq 1 ]; then
    if [ "$codex_defaults_conflict" -eq 1 ]; then
      echo "codex: found unmarked top-level model/model_provider in $PP_CODEX_CONFIG_DISPLAY; leaving defaults unchanged" >&2
    fi
    :
  elif [ "$codex_defaults_conflict" -eq 1 ]; then
    echo "codex: found unmarked top-level model/model_provider in $PP_CODEX_CONFIG_DISPLAY; leaving defaults unchanged" >&2
  else
    pp_write_marked_block "$codex_config" "$PP_CODEX_DEFAULTS_BEGIN" "$PP_CODEX_DEFAULTS_END" "$tmp_codex_defaults" prepend
  fi

  if pp_has_marker "$codex_config" "$PP_CODEX_PROVIDER_BEGIN"; then
    pp_write_marked_block "$codex_config" "$PP_CODEX_PROVIDER_BEGIN" "$PP_CODEX_PROVIDER_END" "$tmp_codex_provider"
  elif [ "$codex_provider_conflict" -eq 1 ]; then
    echo "codex: found unmarked [model_providers.$PP_CODEX_PROVIDER] in $PP_CODEX_CONFIG_DISPLAY; leaving it unchanged" >&2
  else
    pp_write_marked_block "$codex_config" "$PP_CODEX_PROVIDER_BEGIN" "$PP_CODEX_PROVIDER_END" "$tmp_codex_provider"
  fi

  if [ "$codex_config_existed" -eq 0 ]; then
    echo "codex: wrote $PP_CODEX_CONFIG_DISPLAY"
  else
    echo "codex: updated Prompt Proxy-owned Codex blocks for $PP_CODEX_PROVIDER"
  fi
fi

if [ "$PP_SETUP_OPENCODE" -eq 1 ]; then
  if command -v node >/dev/null 2>&1; then
    PP_OPENCODE_CONFIG_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
    PP_OPENCODE_DATA_DIR="\${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
    PP_OPENCODE_CONFIG_FILE="$PP_OPENCODE_CONFIG_DIR/opencode.json"
    PP_OPENCODE_AUTH_FILE="$PP_OPENCODE_DATA_DIR/auth.json"
    PP_OPENCODE_CONFIG_MARKER_FILE="$HOME/.prompt-proxy/opencode-config.prompt-proxy-chat.marker.json"
    PP_OPENCODE_AUTH_MARKER_FILE="$HOME/.prompt-proxy/opencode-auth.prompt-proxy-chat.marker.json"
    mkdir -p "$PP_OPENCODE_CONFIG_DIR" "$PP_OPENCODE_DATA_DIR"
    node -e '
const fs = require("fs");
const configFile = process.argv[1];
const authFile = process.argv[2];
const baseUrl = process.argv[3];
const tokenFile = process.argv[4];
const configMarkerFile = process.argv[5];
const authMarkerFile = process.argv[6];
const providerId = "prompt-proxy-chat";
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}
function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
function readToken(file) {
  return fs.readFileSync(file, "utf8").replace(/\\r?\\n$/, "");
}
const config = readJson(configFile);
const configMarker = readJson(configMarkerFile);
const managedConfig = new Set(Array.isArray(configMarker.fields) ? configMarker.fields : []);
const nextManagedConfig = [];
const conflicts = [];
config["$schema"] = config["$schema"] || "https://opencode.ai/config.json";
if (config.provider === undefined || (managedConfig.has("provider") && !isObject(config.provider))) {
  config.provider = {};
}
if (isObject(config.provider)) {
  const existingProvider = config.provider[providerId];
  if (existingProvider === undefined || managedConfig.has("provider." + providerId)) {
    config.provider = Object.assign({}, config.provider, {
      [providerId]: Object.assign({}, isObject(existingProvider) ? existingProvider : {}, {
    npm: "@ai-sdk/openai-compatible",
    name: "Prompt Proxy Chat",
        options: Object.assign({}, isObject(existingProvider?.options) ? existingProvider.options : {}, { baseURL: baseUrl + "/v1" }),
        models: Object.assign({}, isObject(existingProvider?.models) ? existingProvider.models : {}, {
      "router-auto": { name: "Router Auto" },
      "router-fast": { name: "Router Fast" },
      "router-balanced": { name: "Router Balanced" },
      "router-hard": { name: "Router Hard" },
      "router-deep": { name: "Router Deep" }
    })
  })
    });
    nextManagedConfig.push("provider." + providerId);
  } else {
    conflicts.push("provider." + providerId);
  }
} else {
  conflicts.push("provider");
}
if (config.model === undefined || managedConfig.has("model")) {
  config.model = "prompt-proxy-chat/router-auto";
  nextManagedConfig.push("model");
}
if (config.small_model === undefined || managedConfig.has("small_model")) {
  config.small_model = "prompt-proxy-chat/router-fast";
  nextManagedConfig.push("small_model");
}
if (nextManagedConfig.length > 0) {
  fs.writeFileSync(configMarkerFile, JSON.stringify({ version: 1, harness: "opencode", fields: nextManagedConfig }, null, 2) + "\\n", { mode: 0o600 });
  fs.chmodSync(configMarkerFile, 0o600);
}
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\\n");
const auth = readJson(authFile);
if (auth[providerId] === undefined || fs.existsSync(authMarkerFile)) {
  auth[providerId] = { type: "api", key: readToken(tokenFile) };
  fs.writeFileSync(authMarkerFile, JSON.stringify({ version: 1, harness: "opencode", provider: providerId }, null, 2) + "\\n", { mode: 0o600 });
  fs.chmodSync(authMarkerFile, 0o600);
} else {
  conflicts.push("auth." + providerId);
}
if (conflicts.length > 0) {
  console.error("opencode: found user-managed entries outside Prompt Proxy markers: " + conflicts.join(", ") + "; leaving them unchanged");
}
fs.writeFileSync(authFile, JSON.stringify(auth, null, 2) + "\\n", { mode: 0o600 });
fs.chmodSync(authFile, 0o600);
' "$PP_OPENCODE_CONFIG_FILE" "$PP_OPENCODE_AUTH_FILE" "$PP_BASE_URL" "$PP_TOKEN_PATH" "$PP_OPENCODE_CONFIG_MARKER_FILE" "$PP_OPENCODE_AUTH_MARKER_FILE"
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
  [ "$PP_SETUP_CLAUDE" -eq 1 ] && PP_LAUNCH="claude"
  if [ "$PP_SETUP_CODEX" -eq 1 ]; then
    if [ -n "$PP_LAUNCH" ]; then
      PP_LAUNCH="$PP_LAUNCH, codex"
    else
      PP_LAUNCH="codex"
    fi
  fi
  if [ -n "$PP_LAUNCH" ]; then
    case "$PP_LAUNCH" in
      *,*) echo "Done. Open a new terminal and run one of: $PP_LAUNCH" ;;
      *) echo "Done. Open a new terminal and run: $PP_LAUNCH" ;;
    esac
  fi
  if [ "$PP_SETUP_OPENCODE" -eq 1 ]; then
    echo "Open opencode and select prompt-proxy-chat/router-auto from /models"
  fi
fi
`;
}
