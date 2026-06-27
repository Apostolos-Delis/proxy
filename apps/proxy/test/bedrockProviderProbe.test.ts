import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  probeProviderCredential,
  type ProviderHealthProbeDependencies
} from "../src/providerHealthProbe.js";

describe("Bedrock provider probes", () => {
  it("tests model access without attempting streaming", async () => {
    const events: unknown[] = [];
    const commands: string[] = [];
    const result = await probeProviderCredential(dependencies({
      events,
      commands,
      send: async () => ({ $metadata: { requestId: "bedrock-request" } })
    }), {
      organizationId: "org_bedrock_probe",
      workspaceId: "org_bedrock_probe:workspace:default",
      actorUserId: "local-user",
      providerAccountId: "provider_account_bedrock",
      model: "anthropic.claude-3-5-haiku-20241022-v1:0",
      operation: "model_access"
    });

    expect(result).toEqual(expect.objectContaining({
      provider: "amazon-bedrock",
      providerAccountId: "provider_account_bedrock",
      status: "success",
      healthStatus: "healthy",
      stateUpdated: true
    }));
    expect(commands).toEqual(["ConverseCommand"]);
    expect(result.dimensions).toEqual(expect.objectContaining({
      target: expect.objectContaining({ dialect: "bedrock-converse", operation: "Converse" }),
      basicChat: expect.objectContaining({ status: "passed" }),
      streaming: expect.objectContaining({ status: "not_attempted" })
    }));
    expect(JSON.stringify(events)).not.toContain("bedrock-secret-token");
  });

  it("classifies streaming permission failures as the primary streaming test result", async () => {
    const events: unknown[] = [];
    const commands: string[] = [];
    const result = await probeProviderCredential(dependencies({
      events,
      commands,
      send: async (command) => {
        if (command.constructor.name === "ConverseCommand") return {};
        throw {
          name: "AccessDeniedException",
          message: "User is not authorized to perform bedrock:InvokeModelWithResponseStream.",
          $metadata: { httpStatusCode: 403 }
        };
      }
    }), {
      organizationId: "org_bedrock_probe",
      workspaceId: "org_bedrock_probe:workspace:default",
      actorUserId: "local-user",
      providerAccountId: "provider_account_bedrock",
      model: "anthropic.claude-3-5-haiku-20241022-v1:0",
      operation: "streaming"
    });

    expect(result).toEqual(expect.objectContaining({
      provider: "amazon-bedrock",
      status: "failed",
      healthStatus: "terminal",
      errorType: "model_access_denied",
      statusCode: 403,
      stateUpdated: true
    }));
    expect(commands).toEqual(["ConverseCommand", "ConverseStreamCommand"]);
    expect(result.dimensions).toEqual(expect.objectContaining({
      target: expect.objectContaining({ dialect: "bedrock-converse", operation: "ConverseStream" }),
      basicChat: expect.objectContaining({ status: "passed" }),
      streaming: expect.objectContaining({ status: "failed" }),
      failure: expect.objectContaining({
        category: "auth_denied",
        metadata: expect.objectContaining({
          bedrockErrorKind: "stream_permission_denied",
          bedrockOperation: "ConverseStream",
          region: "us-east-1"
        })
      })
    }));
    expect(JSON.stringify(events)).not.toContain("bedrock-secret-token");
  });
});

function dependencies(input: {
  events: unknown[];
  commands: string[];
  send: (command: { constructor: { name: string } }) => Promise<unknown>;
}): ProviderHealthProbeDependencies {
  return {
    config: loadConfig({
      LOG_LEVEL: "fatal",
      PROXY_TOKEN: "proxy-token",
      OPENAI_API_KEY: "openai-upstream-key",
      ANTHROPIC_API_KEY: "anthropic-upstream-key",
      PROVIDER_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64")
    }),
    events: {
      append: async (event: unknown) => {
        input.events.push(event);
      }
    } as never,
    providerCredentials: {
      resolveAccount: async () => ({
        provider: "amazon-bedrock",
        providerAccountId: "provider_account_bedrock",
        token: "bedrock-secret-token",
        authType: "api_key",
        providerAccountSettings: {
          credentialMode: "aws_bedrock_bearer_token",
          region: "us-east-1",
          discoveryRegions: ["us-east-1"]
        }
      })
    },
    providerRegistry: {
      resolve: async () => ({
        id: "provider_bedrock",
        organizationId: null,
        slug: "amazon-bedrock",
        displayName: "Amazon Bedrock",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        adapterKind: "aws-bedrock-converse",
        adapterConfig: { defaultRegion: "us-east-1" },
        authStyle: "aws-sdk",
        endpoints: [
          { dialect: "bedrock-converse", operation: "Converse" },
          { dialect: "bedrock-converse", operation: "ConverseStream" }
        ],
        defaultHeaders: {},
        capabilities: {},
        forwardHarnessHeaders: false,
        enabled: true,
        builtin: true
      })
    },
    bedrockRuntimeClientFactory: () => ({
      send: async (command: unknown) => {
        const named = command as { constructor: { name: string } };
        input.commands.push(named.constructor.name);
        return input.send(named);
      }
    })
  };
}
