export type SnippetLanguage = "shell" | "json" | "toml";
export type HarnessSetupTarget = "claude-code" | "codex" | "opencode";
export type HarnessSetupSelection = HarnessSetupTarget[];

export const keyPlaceholder = "<your-api-key>";
export const defaultHarnessSetupSelection: HarnessSetupSelection = ["claude-code", "codex"];
export const harnessSetupOptions: { value: HarnessSetupTarget; label: string; description: string }[] = [
  {
    value: "claude-code",
    label: "Claude Code",
    description: "Add Claude Code settings for Anthropic Messages traffic."
  },
  {
    value: "codex",
    label: "Codex",
    description: "Add a Codex provider and shell export for Responses traffic."
  },
  {
    value: "opencode",
    label: "opencode",
    description: "Add the opencode chat provider and auth entry."
  }
];

export function harnessSetupLabel(harnesses: HarnessSetupSelection = defaultHarnessSetupSelection) {
  return selectedHarnesses(harnesses)
    .map((target) => harnessSetupOptions.find((option) => option.value === target)?.label ?? target)
    .join(" + ");
}

function singleQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function selectedHarnesses(harnesses: HarnessSetupSelection | undefined) {
  return harnesses && harnesses.length > 0 ? harnesses : defaultHarnessSetupSelection;
}

export function buildSetupCommand({
  apiBase,
  secret,
  harnesses = defaultHarnessSetupSelection
}: {
  apiBase: string;
  secret: string | null;
  harnesses?: HarnessSetupSelection;
}) {
  const flags = selectedHarnesses(harnesses).map((harness) => `--harness ${harness}`).join(" ");
  return `curl -fsSL ${apiBase}/setup.sh | bash -s -- ${flags} ${singleQuote(secret ?? keyPlaceholder)}`;
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
  harnesses = defaultHarnessSetupSelection
}: {
  apiBase: string;
  secret: string | null;
  harnesses?: HarnessSetupSelection;
}): ManualStep[] {
  const key = secret ?? keyPlaceholder;
  const selected = selectedHarnesses(harnesses);
  const tokenPath = tokenPathForHarnesses(selected);
  const steps: ManualStep[] = [storeKeyStep(key, tokenPath)];
  if (selected.includes("claude-code")) {
    steps.push(claudeCodeStep(apiBase, tokenPath));
  }
  if (selected.includes("codex")) {
    steps.push(codexExportStep(selected), codexProviderStep(apiBase, selected));
  }
  if (selected.includes("opencode")) {
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
    detail: "Merge these settings into ~/.claude/settings.json (create the file if it does not exist).",
    snippet: JSON.stringify(
      {
        model: "claude-router-auto",
        env: {
          ANTHROPIC_BASE_URL: apiBase,
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
        },
        apiKeyHelper: `cat ${tokenPath}`
      },
      null,
      2
    ),
    language: "json"
  };
}

function codexExportStep(harnesses: HarnessSetupSelection): ManualStep {
  const envKey = codexEnvForHarnesses(harnesses);
  const tokenPath = tokenPathForHarnesses(harnesses);
  return {
    title: "Export the key for Codex",
    detail: `Add this line to ~/.zshrc (or ~/.bashrc) so Codex can read ${envKey}.`,
    snippet: `export ${envKey}="$(cat ${tokenPath})"`,
    language: "shell"
  };
}

function codexProviderStep(apiBase: string, harnesses: HarnessSetupSelection): ManualStep {
  const envKey = codexEnvForHarnesses(harnesses);
  const provider = codexProviderForHarnesses(harnesses);
  return {
    title: "Register the Codex provider",
    detail: "Add this to ~/.codex/config.toml. If the file already has a model/model_provider, keep yours and add only the provider table.",
    snippet: [
      `model = "router-auto"`,
      `model_provider = "${provider}"`,
      "",
      `[model_providers.${provider}]`,
      `name = "Prompt Proxy"`,
      `base_url = "${apiBase}/v1"`,
      `env_key = "${envKey}"`,
      `wire_api = "responses"`,
      "supports_websockets = true"
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

export function tokenPathForHarnesses(harnesses: HarnessSetupSelection = defaultHarnessSetupSelection) {
  const selected = selectedHarnesses(harnesses);
  if (selected.length !== 1) return "~/.prompt-proxy/token";
  const [harness] = selected;
  if (harness === "codex") return "~/.prompt-proxy/codex.token";
  if (harness === "claude-code") return "~/.prompt-proxy/claude-code.token";
  if (harness === "opencode") return "~/.prompt-proxy/opencode.token";
  return "~/.prompt-proxy/token";
}

function codexEnvForHarnesses(harnesses: HarnessSetupSelection) {
  return harnesses.length === 1 && harnesses[0] === "codex" ? "PROMPT_PROXY_CODEX_TOKEN" : "PROMPT_PROXY_TOKEN";
}

function codexProviderForHarnesses(harnesses: HarnessSetupSelection) {
  return harnesses.length === 1 && harnesses[0] === "codex" ? "prompt_proxy_codex" : "prompt_proxy";
}
