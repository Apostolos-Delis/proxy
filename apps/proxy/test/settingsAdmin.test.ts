import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { defaultCompressionPolicy, type CompressionPolicy, type PromptCaptureMode } from "@proxy/schema";

import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

describe("persistent settings admin APIs", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("loads prompt-capture JSON settings without creating runtime routing controls", async () => {
    const settingsPath = await tempSettingsPath();
    await writeFile(settingsPath, JSON.stringify({
      schemaVersion: 1,
      promptCapture: {
        promptCaptureMode: "hash_only",
        retentionDays: 14
      },
    }), "utf8");

    const config = loadConfig({ PROXY_SETTINGS_PATH: settingsPath });

    expect(config.settingsPath).toBe(settingsPath);
    expect("classifierModel" in config).toBe(false);
    expect("routeQualityLowConfidenceThreshold" in config).toBe(false);
  });

  it("rejects legacy control-plane blocks instead of keeping dual configuration paths", async () => {
    const settingsPath = await tempSettingsPath();
    await writeFile(settingsPath, JSON.stringify({
      schemaVersion: 1,
      classifier: { model: "legacy-classifier" },
      budgets: { maxEstimatedInputTokens: 2000 },
      routeQuality: {},
      promptCapture: {}
    }), "utf8");

    expect(() => loadConfig({ PROXY_SETTINGS_PATH: settingsPath })).toThrow("Unrecognized keys");
  });

  it("writes validated JSON settings and applies prompt capture persistence", async () => {
    const settingsPath = await tempSettingsPath();
    const promptCapture = { promptCaptureMode: "raw_text" as PromptCaptureMode, retentionDays: 30 };
    const orgSystemPrompt = { value: null as string | null };
    const app = buildServer(loadConfig({
      PROXY_SETTINGS_PATH: settingsPath,
      DEFAULT_ORGANIZATION_ID: "org_settings_file",
      LOG_LEVEL: "fatal"
    }), { persistence: fakePersistence(promptCapture, "org_settings_file", orgSystemPrompt) });

    const response = await app.inject({
      method: "POST",
      url: "/admin/graphql",
      headers: adminHeaders(),
      payload: {
        query: `mutation UpdateSettings($input: SettingsInput!) {
          updateSettings(input: $input) {
            storage { format path }
            settings { systemPrompt costBaseline { anthropicMessagesModel openaiResponsesModel openaiChatModel } }
          }
        }`,
        variables: {
          input: {
            schemaVersion: 1,
            systemPrompt: "  Follow organization proxy policy.  ",
            costBaseline: {
              anthropicMessagesModel: "claude-opus-4-8",
              openaiResponsesModel: "gpt-5.5-pro",
              openaiChatModel: "gpt-5.5-chat-baseline"
            },
            promptCapture: {
              promptCaptureMode: "hash_only",
              retentionDays: 7
            }
          }
        }
      }
    });
    const body = response.json().data?.updateSettings;
    const file = JSON.parse(await readFile(settingsPath, "utf8"));

    await app.close();

    expect(response.statusCode).toBe(200);
    expect(body.storage).toEqual(expect.objectContaining({ format: "json", path: settingsPath }));
    expect(body.settings.systemPrompt).toBe("Follow organization proxy policy.");
    expect(body.settings.costBaseline).toEqual({
      anthropicMessagesModel: "claude-opus-4-8",
      openaiResponsesModel: "gpt-5.5-pro",
      openaiChatModel: "gpt-5.5-chat-baseline"
    });
    expect(file.promptCapture.promptCaptureMode).toBe("hash_only");
    expect(file).toEqual({
      schemaVersion: 1,
      promptCapture: { promptCaptureMode: "hash_only", retentionDays: 7 }
    });
    expect(file.systemPrompt).toBeUndefined();
    expect(file.costBaseline).toBeUndefined();
    expect(orgSystemPrompt.value).toBe("Follow organization proxy policy.");
    expect(promptCapture).toEqual({
      promptCaptureMode: "hash_only",
      retentionDays: 7
    });
  });

  it("rejects invalid settings without writing them", async () => {
    const settingsPath = await tempSettingsPath();
    const app = buildServer(loadConfig({
      PROXY_SETTINGS_PATH: settingsPath,
      LOG_LEVEL: "fatal"
    }), { persistence: fakePersistence() });

    const response = await app.inject({
      method: "POST",
      url: "/admin/graphql",
      headers: adminHeaders(),
      payload: {
        query: `mutation UpdateSettings($input: SettingsInput!) {
          updateSettings(input: $input) {
            organizationId
          }
        }`,
        variables: {
          input: {
            schemaVersion: 1,
            promptCapture: {
              promptCaptureMode: "raw_text",
              retentionDays: -1
            }
          }
        }
      }
    });
    const body = response.json();

    await app.close();

    expect(response.statusCode).toBe(200);
    expect(body.errors?.[0]?.message).toBe("invalid_settings");
    expect(body.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    await expect(readFile(settingsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  async function tempSettingsPath() {
    tempDir = await mkdtemp(join(tmpdir(), "proxy-settings-"));
    return join(tempDir, "settings.json");
  }
});

function adminHeaders() {
  return { cookie: "proxy_session=test-admin-session" };
}

function fakePersistence(
  promptCapture = { promptCaptureMode: "raw_text" as PromptCaptureMode, retentionDays: 30 },
  organizationId = "local",
  orgSystemPrompt = { value: null as string | null }
) {
  const orgCostBaseline = {
    anthropicMessagesModel: "claude-fable-5",
    openaiResponsesModel: "gpt-5.5",
    openaiChatModel: "gpt-5.5"
  };
  return {
    adminSessions: {
      resolve: async (token: string) => token === "test-admin-session"
        ? {
            sessionId: "session_1",
            organizationId,
            userId: "local-user",
            role: "owner"
          }
        : null,
      create: async () => null,
      revoke: async () => {}
    },
    organizationSettings: {
      systemPrompt: async () => orgSystemPrompt.value,
      setSystemPrompt: async (_organizationId: string, systemPrompt: string | null) => {
        orgSystemPrompt.value = systemPrompt;
        return systemPrompt;
      },
      cacheTtlUpgrade: async () => false,
      setCacheTtlUpgrade: async (_organizationId: string, enabled: boolean) => enabled,
      setAutomaticCaching: async (_organizationId: string, enabled: boolean) => enabled,
      setToolResultCompressionPolicy: async (_organizationId: string, policy: CompressionPolicy) => policy,
      setDuplicateToolResultReferences: async (_organizationId: string, enabled: boolean) => enabled,
      setCostBaseline: async (_organizationId: string, baseline: {
        anthropicMessagesModel: string | null;
        openaiResponsesModel: string | null;
        openaiChatModel: string | null;
      }) => {
        orgCostBaseline.anthropicMessagesModel = baseline.anthropicMessagesModel?.trim() || "claude-fable-5";
        orgCostBaseline.openaiResponsesModel = baseline.openaiResponsesModel?.trim() || "gpt-5.5";
        orgCostBaseline.openaiChatModel = baseline.openaiChatModel?.trim() || "gpt-5.5";
        return { ...orgCostBaseline };
      },
      editable: async () => ({
        systemPrompt: orgSystemPrompt.value,
        cacheTtlUpgrade: false,
        automaticCaching: false,
        toolResultCompressionPolicy: defaultCompressionPolicy(),
        duplicateToolResultReferences: false,
        costBaseline: { ...orgCostBaseline }
      })
    },
    promptArtifacts: {
      settings: async () => promptCapture,
      configure: async (input: { promptCaptureMode: PromptCaptureMode; retentionDays: number }) => {
        promptCapture.promptCaptureMode = input.promptCaptureMode;
        promptCapture.retentionDays = input.retentionDays;
        return {
          organizationId,
          ...promptCapture
        };
      }
    }
  } as never;
}
