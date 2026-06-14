export type SnippetLanguage = "shell" | "json" | "toml";
export type HarnessSetupTarget = "all" | "claude-code" | "codex" | "opencode";

export const keyPlaceholder = "<your-api-key>";
export const userPlaceholder = "<your-email>";
export const harnessSetupOptions: { value: HarnessSetupTarget; label: string; description: string }[] = [
  {
    value: "all",
    label: "Claude Code + Codex",
    description: "Use one shared key for both local harnesses."
  },
  {
    value: "codex",
    label: "Codex",
    description: "Use a Codex-specific key and routing config."
  },
  {
    value: "claude-code",
    label: "Claude Code",
    description: "Use a Claude Code-specific key and routing config."
  },
  {
    value: "opencode",
    label: "opencode",
    description: "Use an opencode-specific key and routing config."
  }
];

export function harnessSetupLabel(target: HarnessSetupTarget) {
  return harnessSetupOptions.find((option) => option.value === target)?.label ?? target;
}

function singleQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildSetupCommand({
  apiBase,
  secret,
  harness = "all"
}: {
  apiBase: string;
  secret: string | null;
  harness?: HarnessSetupTarget;
}) {
  return `curl -fsSL ${apiBase}/setup.sh | bash -s -- --harness ${harness} ${singleQuote(secret ?? keyPlaceholder)}`;
}

export type ManualStep = {
  title: string;
  detail: string;
  snippet: string;
  language: SnippetLanguage;
};

export function buildManualSteps({
  apiBase,
  secret,
  harness = "all"
}: {
  apiBase: string;
  secret: string | null;
  harness?: HarnessSetupTarget;
}): ManualStep[] {
  const key = secret ?? keyPlaceholder;
  const tokenPath = tokenPathForHarness(harness);
  const steps: ManualStep[] = [storeKeyStep(key, tokenPath)];
  if (harness === "all" || harness === "claude-code") {
    steps.push(claudeCodeStep(apiBase, tokenPath));
  }
  if (harness === "all" || harness === "codex") {
    steps.push(codexExportStep(harness), codexProviderStep(apiBase, harness));
  }
  if (harness === "opencode") {
    steps.push(opencodeConfigStep(apiBase), opencodeAuthStep(key));
  }
  return steps;
}

function storeKeyStep(key: string, tokenPath: string): ManualStep {
  return {
    title: "Store the key",
    detail: "The selected harness setup reads this file.",
    snippet: [
      "mkdir -p ~/.prompt-proxy",
      `printf '%s\\n' ${singleQuote(key)} > ${tokenPath}`,
      `chmod 600 ${tokenPath}`
    ].join("\n"),
    language: "shell"
  };
}

function claudeCodeStep(apiBase: string, tokenPath: string): ManualStep {
  return {
    title: "Point Claude Code at the proxy",
    detail: `Merge these settings into ~/.claude/settings.json (create the file if it does not exist). Replace ${userPlaceholder} so usage is attributed to you.`,
    snippet: JSON.stringify(
      {
        model: "claude-router-auto",
        env: {
          ANTHROPIC_BASE_URL: apiBase,
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
          ANTHROPIC_CUSTOM_HEADERS: `x-prompt-proxy-user-id: ${userPlaceholder}`
        },
        apiKeyHelper: `cat ${tokenPath}`
      },
      null,
      2
    ),
    language: "json"
  };
}

function codexExportStep(harness: HarnessSetupTarget): ManualStep {
  const envKey = codexEnvForHarness(harness);
  const tokenPath = tokenPathForHarness(harness);
  return {
    title: "Export the key for Codex",
    detail: `Add this line to ~/.zshrc (or ~/.bashrc) so Codex can read ${envKey}.`,
    snippet: `export ${envKey}="$(cat ${tokenPath})"`,
    language: "shell"
  };
}

function codexProviderStep(apiBase: string, harness: HarnessSetupTarget): ManualStep {
  const envKey = codexEnvForHarness(harness);
  const provider = codexProviderForHarness(harness);
  return {
    title: "Register the Codex provider",
    detail: `Add this to ~/.codex/config.toml. If the file already has a model/model_provider, keep yours and add only the provider table. Replace ${userPlaceholder} so usage is attributed to you.`,
    snippet: [
      `model = "router-auto"`,
      `model_provider = "${provider}"`,
      "",
      `[model_providers.${provider}]`,
      `name = "Prompt Proxy"`,
      `base_url = "${apiBase}/v1"`,
      `env_key = "${envKey}"`,
      `wire_api = "responses"`,
      "supports_websockets = true",
      `http_headers = { "x-prompt-proxy-user-id" = "${userPlaceholder}" }`
    ].join("\n"),
    language: "toml"
  };
}

function opencodeConfigStep(apiBase: string): ManualStep {
  return {
    title: "Register the opencode provider",
    detail: "Merge this into ~/.config/opencode/opencode.json, or into a project opencode.json if you want it scoped to one repo.",
    snippet: JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: {
          "prompt-proxy-chat": {
            npm: "@ai-sdk/openai-compatible",
            name: "Prompt Proxy Chat",
            options: {
              baseURL: `${apiBase}/v1`
            },
            models: {
              "router-auto": { name: "Router Auto" },
              "router-fast": { name: "Router Fast" },
              "router-balanced": { name: "Router Balanced" },
              "router-hard": { name: "Router Hard" },
              "router-deep": { name: "Router Deep" }
            }
          }
        },
        model: "prompt-proxy-chat/router-auto",
        small_model: "prompt-proxy-chat/router-fast"
      },
      null,
      2
    ),
    language: "json"
  };
}

function opencodeAuthStep(key: string): ManualStep {
  return {
    title: "Connect opencode credentials",
    detail: "Run /connect in opencode, choose prompt-proxy-chat, and paste this key. opencode stores it in ~/.local/share/opencode/auth.json.",
    snippet: [
      "opencode",
      "/connect",
      "prompt-proxy-chat",
      key
    ].join("\n"),
    language: "shell"
  };
}

export function tokenPathForHarness(harness: HarnessSetupTarget) {
  if (harness === "codex") return "~/.prompt-proxy/codex.token";
  if (harness === "claude-code") return "~/.prompt-proxy/claude-code.token";
  if (harness === "opencode") return "~/.prompt-proxy/opencode.token";
  return "~/.prompt-proxy/token";
}

function codexEnvForHarness(harness: HarnessSetupTarget) {
  return harness === "codex" ? "PROMPT_PROXY_CODEX_TOKEN" : "PROMPT_PROXY_TOKEN";
}

function codexProviderForHarness(harness: HarnessSetupTarget) {
  return harness === "codex" ? "prompt_proxy_codex" : "prompt_proxy";
}
