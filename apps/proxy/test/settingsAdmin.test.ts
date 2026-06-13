import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import type { PromptCaptureMode } from "@prompt-proxy/schema";

describe("persistent settings admin APIs", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("loads JSON settings at startup with environment overrides taking precedence", async () => {
    const settingsPath = await tempSettingsPath();
    await writeFile(settingsPath, JSON.stringify({
      schemaVersion: 1,
      classifier: {
        model: "settings-classifier",
        timeoutMs: 2400,
        maxAttempts: 4,
        allowRedactedExcerpt: true
      },
      routeQuality: {
        lowConfidenceThreshold: 0.42
      },
      promptCapture: {}
    }), "utf8");

    const config = loadConfig({
      PROMPT_PROXY_SETTINGS_PATH: settingsPath,
      CLASSIFIER_MODEL: "env-classifier"
    });

    expect(config.settingsPath).toBe(settingsPath);
    expect(config.classifierModel).toBe("env-classifier");
    expect(config.classifierTimeoutMs).toBe(2400);
    expect(config.classifierMaxAttempts).toBe(4);
    expect(config.classifierAllowRedactedExcerpt).toBe(true);
    expect(config.routeQualityLowConfidenceThreshold).toBe(0.42);
  });

  it("ignores the budgets block in settings files saved before limits moved to routing configs", async () => {
    const settingsPath = await tempSettingsPath();
    await writeFile(settingsPath, JSON.stringify({
      schemaVersion: 1,
      classifier: { model: "legacy-classifier" },
      budgets: { warningEstimatedInputTokens: 1000, maxEstimatedInputTokens: 2000, maxRoute: "hard" },
      routeQuality: {},
      promptCapture: {}
    }), "utf8");

    const config = loadConfig({ PROMPT_PROXY_SETTINGS_PATH: settingsPath });

    expect(config.classifierModel).toBe("legacy-classifier");
  });

  it("writes validated JSON settings and applies prompt capture persistence", async () => {
    const settingsPath = await tempSettingsPath();
    const promptCapture = { promptCaptureMode: "raw_text" as PromptCaptureMode, retentionDays: 30 };
    const orgSystemPrompt = { value: null as string | null };
    const app = buildServer(loadConfig({
      PROMPT_PROXY_SETTINGS_PATH: settingsPath,
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
            settings { systemPrompt classifier { model } costBaseline { anthropicModel openaiModel } }
          }
        }`,
        variables: {
          input: {
            schemaVersion: 1,
            systemPrompt: "  Follow organization proxy policy.  ",
            costBaseline: {
              anthropicModel: "claude-opus-4-8",
              openaiModel: "gpt-5.5-pro"
            },
            classifier: {
              model: "route-classifier-ui",
              timeoutMs: 1800,
              maxAttempts: 3,
              allowRedactedExcerpt: false
            },
            routeQuality: {
              lowConfidenceThreshold: 0.6
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
    expect(body.settings.classifier.model).toBe("route-classifier-ui");
    expect(body.settings.systemPrompt).toBe("Follow organization proxy policy.");
    expect(body.settings.costBaseline).toEqual({
      anthropicModel: "claude-opus-4-8",
      openaiModel: "gpt-5.5-pro"
    });
    expect(file.classifier.timeoutMs).toBe(1800);
    expect(file.promptCapture.promptCaptureMode).toBe("hash_only");
    expect(file.systemPrompt).toBeUndefined();
    expect(file.costBaseline).toBeUndefined();
    expect(orgSystemPrompt.value).toBe("Follow organization proxy policy.");
    expect(promptCapture).toEqual({
      promptCaptureMode: "hash_only",
      retentionDays: 7
    });
  });

  it("rejects unpriced baseline models before writing settings", async () => {
    const settingsPath = await tempSettingsPath();
    const app = buildServer(loadConfig({
      PROMPT_PROXY_SETTINGS_PATH: settingsPath,
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
            costBaseline: {
              anthropicModel: "claude-not-a-model",
              openaiModel: "gpt-5.5"
            },
            classifier: {
              model: "route-classifier-ui",
              timeoutMs: 1800,
              maxAttempts: 3,
              allowRedactedExcerpt: false
            },
            routeQuality: {},
            promptCapture: {}
          }
        }
      }
    });
    const body = response.json();

    await app.close();

    expect(body.errors?.[0]?.message).toBe("baseline_model_unpriced: claude-not-a-model");
    expect(body.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    await expect(readFile(settingsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid settings without writing them", async () => {
    const settingsPath = await tempSettingsPath();
    const app = buildServer(loadConfig({
      PROMPT_PROXY_SETTINGS_PATH: settingsPath,
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
            classifier: {
              model: "route-classifier-ui",
              timeoutMs: 0,
              maxAttempts: 3,
              allowRedactedExcerpt: false
            },
            routeQuality: {},
            promptCapture: {}
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

  it("exposes the subscription oauth flag on the settings query when enabled", async () => {
    const app = buildServer(
      loadConfig({ SUBSCRIPTION_OAUTH_ENABLED: "true", LOG_LEVEL: "fatal" }),
      { persistence: fakePersistence() }
    );
    const response = await app.inject({
      method: "POST",
      url: "/admin/graphql",
      headers: adminHeaders(),
      payload: { query: "query { settings { subscriptionOAuthEnabled } }" }
    });
    await app.close();

    expect(response.json().data?.settings?.subscriptionOAuthEnabled).toBe(true);
  });

  it("defaults the subscription oauth flag to false on the settings query", async () => {
    const app = buildServer(
      loadConfig({ LOG_LEVEL: "fatal" }),
      { persistence: fakePersistence() }
    );
    const response = await app.inject({
      method: "POST",
      url: "/admin/graphql",
      headers: adminHeaders(),
      payload: { query: "query { settings { subscriptionOAuthEnabled } }" }
    });
    await app.close();

    expect(response.json().data?.settings?.subscriptionOAuthEnabled).toBe(false);
  });

  async function tempSettingsPath() {
    tempDir = await mkdtemp(join(tmpdir(), "prompt-proxy-settings-"));
    return join(tempDir, "settings.json");
  }
});

function adminHeaders() {
  return { cookie: "prompt_proxy_session=test-admin-session" };
}

function fakePersistence(
  promptCapture = { promptCaptureMode: "raw_text" as PromptCaptureMode, retentionDays: 30 },
  organizationId = "local",
  orgSystemPrompt = { value: null as string | null }
) {
  const orgCostBaseline = { anthropicModel: "claude-fable-5", openaiModel: "gpt-5.5" };
  const pricedModels = ["claude-fable-5", "claude-opus-4-8", "gpt-5.5", "gpt-5.5-pro"];
  return {
    adminQueries: {
      forScope: () => ({
        modelPricing: async () => pricedModels.map((model) => ({ model, source: "default" }))
      })
    },
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
      setToolResultCompression: async (_organizationId: string, enabled: boolean) => enabled,
      setDuplicateToolResultReferences: async (_organizationId: string, enabled: boolean) => enabled,
      setCostBaseline: async (_organizationId: string, baseline: { anthropicModel: string | null; openaiModel: string | null }) => {
        orgCostBaseline.anthropicModel = baseline.anthropicModel?.trim() || "claude-fable-5";
        orgCostBaseline.openaiModel = baseline.openaiModel?.trim() || "gpt-5.5";
        return { ...orgCostBaseline };
      },
      editable: async () => ({
        systemPrompt: orgSystemPrompt.value,
        cacheTtlUpgrade: false,
        automaticCaching: false,
        toolResultCompression: false,
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
