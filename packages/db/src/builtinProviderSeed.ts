import {
  ANTHROPIC_PROVIDER_CACHING_CAPABILITIES,
  OPENAI_PROVIDER_CACHING_CAPABILITIES,
  type BuiltinProvider,
  type ProviderAdapterKind,
  type ProviderAuthStyle,
  type ProviderRegistryEndpoint
} from "@proxy/schema";

export type BuiltinProviderSeedDefinition = {
  provider: BuiltinProvider;
  displayName: string;
  baseUrl: string;
  adapterKind: ProviderAdapterKind;
  adapterConfig: Record<string, unknown>;
  authStyle: ProviderAuthStyle;
  endpoints: ProviderRegistryEndpoint[];
  defaultHeaders: Record<string, string>;
  capabilities: Record<string, unknown>;
  forwardHarnessHeaders: boolean;
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
      connectionRegion: null,
      connectionSecretRef: "env:OPENAI_API_KEY",
      connectionSecretHint: "OPENAI_API_KEY"
    },
    {
      provider: "anthropic",
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
      connectionRegion: null,
      connectionSecretRef: "env:ANTHROPIC_API_KEY",
      connectionSecretHint: "ANTHROPIC_API_KEY"
    },
    {
      provider: "amazon-bedrock",
      displayName: "Amazon Bedrock",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      adapterKind: "aws-bedrock-converse",
      adapterConfig: {
        service: "bedrock-runtime",
        controlPlaneService: "bedrock",
        defaultRegion: "us-east-1",
        credentialMode: "aws_default_chain",
        region: "us-east-1",
        discoveryRegions: ["us-east-1"],
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
      connectionRegion: "us-east-1",
      connectionSecretRef: null,
      connectionSecretHint: "AWS default credential chain"
    }
  ];
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/g, "");
}
