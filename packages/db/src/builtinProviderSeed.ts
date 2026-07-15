import {
  ANTHROPIC_PROVIDER_CACHING_CAPABILITIES,
  OPENAI_PROVIDER_CACHING_CAPABILITIES,
  type BuiltinProvider,
  type ProviderAdapterKind,
  type ProviderAuthStyle,
  type ProviderRegistryEndpoint
} from "@proxy/schema";

export const BUILTIN_PROVIDER_IDS: Record<BuiltinProvider, string> = {
  openai: "00000000-0000-0000-0000-000000000001",
  anthropic: "00000000-0000-0000-0000-000000000002",
  "amazon-bedrock": "00000000-0000-0000-0000-000000000003"
};

export type BuiltinProviderSeedDefinition = {
  provider: BuiltinProvider;
  id: string;
  displayName: string;
  baseUrl: string;
  adapterKind: ProviderAdapterKind;
  adapterConfig: Record<string, unknown>;
  authStyle: ProviderAuthStyle;
  endpoints: ProviderRegistryEndpoint[];
  defaultHeaders: Record<string, string>;
  capabilities: Record<string, unknown>;
  forwardHarnessHeaders: boolean;
  accountSecretRef: string;
  accountSettings: Record<string, unknown>;
  connectionRegion: string | null;
  connectionSecretRef: string | null;
  connectionSecretHint: string;
};

export function builtinProviderSeedDefinitions(input: {
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
}): BuiltinProviderSeedDefinition[] {
  return [
    {
      provider: "openai",
      id: BUILTIN_PROVIDER_IDS.openai,
      displayName: "OpenAI",
      baseUrl: trimTrailingSlash(input.openaiBaseUrl),
      adapterKind: "generic-http-json",
      adapterConfig: {},
      authStyle: "bearer",
      endpoints: [
        { dialect: "openai-responses", path: "/responses" },
        { dialect: "openai-chat", path: "/chat/completions" }
      ],
      defaultHeaders: {},
      capabilities: {
        efforts: ["low", "medium", "high", "xhigh"],
        promptCaching: OPENAI_PROVIDER_CACHING_CAPABILITIES
      },
      forwardHarnessHeaders: true,
      accountSecretRef: "env:OPENAI_API_KEY",
      accountSettings: {},
      connectionRegion: null,
      connectionSecretRef: "env:OPENAI_API_KEY",
      connectionSecretHint: "OPENAI_API_KEY"
    },
    {
      provider: "anthropic",
      id: BUILTIN_PROVIDER_IDS.anthropic,
      displayName: "Anthropic",
      baseUrl: trimTrailingSlash(input.anthropicBaseUrl),
      adapterKind: "generic-http-json",
      adapterConfig: {},
      authStyle: "x-api-key",
      endpoints: [{ dialect: "anthropic-messages", path: "/messages" }],
      defaultHeaders: {},
      capabilities: {
        efforts: ["low", "medium", "high", "xhigh", "max", "ultracode"],
        promptCaching: ANTHROPIC_PROVIDER_CACHING_CAPABILITIES
      },
      forwardHarnessHeaders: true,
      accountSecretRef: "env:ANTHROPIC_API_KEY",
      accountSettings: {},
      connectionRegion: null,
      connectionSecretRef: "env:ANTHROPIC_API_KEY",
      connectionSecretHint: "ANTHROPIC_API_KEY"
    },
    {
      provider: "amazon-bedrock",
      id: BUILTIN_PROVIDER_IDS["amazon-bedrock"],
      displayName: "Amazon Bedrock",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      adapterKind: "aws-bedrock-converse",
      adapterConfig: {
        service: "bedrock-runtime",
        controlPlaneService: "bedrock",
        defaultRegion: "us-east-1",
        supportsBearerToken: true,
        supportsInferenceProfiles: true
      },
      authStyle: "aws-sdk",
      endpoints: [
        { dialect: "bedrock-converse", operation: "Converse" },
        { dialect: "bedrock-converse", operation: "ConverseStream" }
      ],
      defaultHeaders: {},
      capabilities: {},
      forwardHarnessHeaders: false,
      accountSecretRef: "aws:default-chain",
      accountSettings: {
        credentialMode: "aws_default_chain",
        region: "us-east-1",
        discoveryRegions: ["us-east-1"]
      },
      connectionRegion: "us-east-1",
      connectionSecretRef: null,
      connectionSecretHint: "AWS default credential chain"
    }
  ];
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/g, "");
}
