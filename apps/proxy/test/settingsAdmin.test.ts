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
      budgets: {
        maxRoute: "hard"
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
    expect(config.budgetMaxRoute).toBe("hard");
    expect(config.routeQualityLowConfidenceThreshold).toBe(0.42);
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
            settings { systemPrompt classifier { model } }
          }
        }`,
        variables: {
          input: {
            schemaVersion: 1,
            systemPrompt: "  Follow organization proxy policy.  ",
            classifier: {
              model: "route-classifier-ui",
              timeoutMs: 1800,
              maxAttempts: 3,
              allowRedactedExcerpt: false
            },
            budgets: {
              warningEstimatedInputTokens: 1000,
              maxEstimatedInputTokens: 2000,
              maxRoute: "balanced"
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
    expect(file.classifier.timeoutMs).toBe(1800);
    expect(file.promptCapture.promptCaptureMode).toBe("hash_only");
    expect(file.systemPrompt).toBeUndefined();
    expect(orgSystemPrompt.value).toBe("Follow organization proxy policy.");
    expect(promptCapture).toEqual({
      promptCaptureMode: "hash_only",
      retentionDays: 7
    });
  });

  it("applies console agent settings with env precedence and surfaces them in responses", async () => {
    const settingsPath = await tempSettingsPath();
    await writeFile(settingsPath, JSON.stringify({
      schemaVersion: 1,
      classifier: {},
      budgets: {},
      routeQuality: {},
      promptCapture: {},
      consoleAgent: {
        model: "claude-router-deep",
        thinkingLevel: "high",
        maxTurns: 5,
        maxToolCallsPerTurn: 3,
        timeoutSeconds: 45
      }
    }), "utf8");

    const overridden = loadConfig({
      PROMPT_PROXY_SETTINGS_PATH: settingsPath,
      CONSOLE_AGENT_MAX_TURNS: "7"
    });
    expect(overridden.consoleAgentModel).toBe("claude-router-deep");
    expect(overridden.consoleAgentThinkingLevel).toBe("high");
    expect(overridden.consoleAgentMaxTurns).toBe(7);
    expect(overridden.consoleAgentMaxToolCallsPerTurn).toBe(3);
    expect(overridden.consoleAgentTimeoutSeconds).toBe(45);

    const app = buildServer(loadConfig({
      PROMPT_PROXY_SETTINGS_PATH: settingsPath,
      LOG_LEVEL: "fatal"
    }), { persistence: fakePersistence() });
    const response = await app.inject({
      method: "POST",
      url: "/admin/graphql",
      headers: adminHeaders(),
      payload: {
        query: `query ConsoleAgentSettings {
          settings {
            restartRequiredFor
            settings {
              consoleAgent { model thinkingLevel maxTurns maxToolCallsPerTurn timeoutSeconds }
            }
          }
        }`
      }
    });
    const body = response.json().data?.settings;
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(body.settings.consoleAgent).toEqual({
      model: "claude-router-deep",
      thinkingLevel: "high",
      maxTurns: 5,
      maxToolCallsPerTurn: 3,
      timeoutSeconds: 45
    });
    expect(body.restartRequiredFor).toContain("consoleAgent");
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
            budgets: {},
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
      }
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
