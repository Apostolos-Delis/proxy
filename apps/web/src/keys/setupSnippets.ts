export type SnippetLanguage = "shell" | "json" | "toml";

export const keyPlaceholder = "<your-api-key>";

// Escapes a value for a single-quoted bash context ('...').
function singleQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// One short command that fetches the hosted setup script from the proxy and
// runs it with the key as the argument. The script itself lives at
// GET <apiBase>/setup.sh so people can read it before piping it into bash.
export function buildSetupCommand({ apiBase, secret }: { apiBase: string; secret: string | null }) {
  return `curl -fsSL ${apiBase}/setup.sh | bash -s -- ${singleQuote(secret ?? keyPlaceholder)}`;
}

export type ManualStep = {
  title: string;
  detail: string;
  snippet: string;
  language: SnippetLanguage;
};

// The same four things the hosted script does, as do-it-by-hand steps.
export function buildManualSteps({ apiBase, secret }: { apiBase: string; secret: string | null }): ManualStep[] {
  const key = secret ?? keyPlaceholder;
  return [
    {
      title: "Store the key",
      detail: "Claude Code's apiKeyHelper and the Codex shell export both read this file.",
      snippet: [
        "mkdir -p ~/.prompt-proxy",
        `printf '%s\\n' ${singleQuote(key)} > ~/.prompt-proxy/token`,
        "chmod 600 ~/.prompt-proxy/token"
      ].join("\n"),
      language: "shell"
    },
    {
      title: "Point Claude Code at the proxy",
      detail: "Merge these settings into ~/.claude/settings.json (create the file if it does not exist).",
      snippet: JSON.stringify(
        {
          model: "claude-router-auto",
          env: {
            ANTHROPIC_BASE_URL: apiBase,
            CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
          },
          apiKeyHelper: "cat ~/.prompt-proxy/token"
        },
        null,
        2
      ),
      language: "json"
    },
    {
      title: "Export the key for Codex",
      detail: "Add this line to ~/.zshrc (or ~/.bashrc) — Codex reads the key from PROMPT_PROXY_TOKEN.",
      snippet: `export PROMPT_PROXY_TOKEN="$(cat ~/.prompt-proxy/token)"`,
      language: "shell"
    },
    {
      title: "Register the Codex provider",
      detail: "Add this to ~/.codex/config.toml. If the file already has a model/model_provider, keep yours and add only the provider table.",
      snippet: [
        `model = "router-auto"`,
        `model_provider = "prompt_proxy"`,
        "",
        "[model_providers.prompt_proxy]",
        `name = "Prompt Proxy"`,
        `base_url = "${apiBase}/v1"`,
        `env_key = "PROMPT_PROXY_TOKEN"`,
        `wire_api = "responses"`,
        "supports_websockets = true"
      ].join("\n"),
      language: "toml"
    }
  ];
}
