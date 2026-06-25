import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { eq } from "drizzle-orm";

import {
  apiKeyProviderAccounts,
  apiKeys,
  defaultWorkspaceId,
  decryptSecret,
  encryptSecret,
  events,
  modelCatalog,
  providers,
  providerAccounts,
  providerAccountHealth,
  providerAttempts,
  providerModelHealth,
  users
} from "@proxy/db";

import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";
import { startAnthropicMock, startOpenAIMock } from "./helpers.js";
import {
  openAIChatGPTTokenBundle,
  parseOpenAIChatGPTSecret,
  stringifyOpenAIChatGPTTokenBundle
} from "../src/openAIChatGPTAuth.js";
import { ProviderCredentialOAuthService } from "../src/persistence/providerCredentialOAuth.js";
import { ProviderCredentialStore } from "../src/persistence/providerCredentials.js";
import { requestBodyHash } from "../src/toolResultCompression.js";

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const CUSTOMER_KEY = "sk-ant-customer-zzz";
const OPENAI_PROVIDER_ID = "00000000-0000-0000-0000-000000000001";
const ANTHROPIC_PROVIDER_ID = "00000000-0000-0000-0000-000000000002";
const CUSTOM_PROVIDER_ID = "10000000-0000-0000-0000-000000000001";
const SHADOW_OPENAI_PROVIDER_ID = "10000000-0000-0000-0000-000000000002";
const UNBOUND_OPENAI_PROVIDER_ID = "10000000-0000-0000-0000-000000000003";
const REDIRECT_OPENAI_PROVIDER_ID = "10000000-0000-0000-0000-000000000004";
const CUSTOM_ANTHROPIC_PROVIDER_ID = "10000000-0000-0000-0000-000000000005";

const CREATE = `mutation Create($input: CreateProviderCredentialInput!) {
  createProviderCredential(input: $input) { id providerId provider baseUrl name status authType secretHint ownerUserId }
}`;
const CREATE_LOCAL = `mutation CreateLocal($input: CreateProviderCredentialFromLocalAuthInput!) {
  createProviderCredentialFromLocalAuth(input: $input) { id providerId provider baseUrl name status authType secretHint ownerUserId }
}`;
const START_OAUTH = `mutation StartOAuth($input: StartProviderCredentialOAuthInput!) {
  startProviderCredentialOAuth(input: $input) { loginId verificationUrl userCode }
}`;
const CANCEL_OAUTH = `mutation CancelOAuth($loginId: ID!) {
  cancelProviderCredentialOAuth(loginId: $loginId) { loginId status error }
}`;
const REVOKE = `mutation Revoke($id: ID!) { revokeProviderCredential(providerAccountId: $id) { id status } }`;
const PROBE = `mutation Probe($input: ProbeProviderCredentialInput!) {
  probeProviderCredential(input: $input) {
    probeId
    providerAccountId
    provider
    model
    status
    healthStatus
    errorType
    message
    statusCode
    latencyMs
    checkedAt
    stateUpdated
    dimensions
  }
}`;
const BIND = `mutation Bind($apiKeyId: ID!, $provider: String!, $providerAccountId: ID) {
  assignApiKeyProviderAccount(apiKeyId: $apiKeyId, provider: $provider, providerAccountId: $providerAccountId) {
    id providerCredentials { provider providerId providerAccountId name status }
  }
}`;
const LIST = `query { providerAccounts { id providerId provider baseUrl name authType status secretHint ownerUserId boundKeyCount } }`;
const PROVIDERS = `query {
  providers {
    slug
    displayName
    authStyle
    enabled
    builtin
    endpoints { dialect path }
  }
}`;
const HEALTH_LIST = `query {
  providerAccounts {
    id
    health {
      status
      cooldownUntil
      lastErrorType
      lastErrorAt
      lastSuccessAt
      consecutiveFailures
      modelHealth {
        providerId
        providerAccountId
        model
        status
        lastErrorType
        lastErrorAt
        lockoutUntil
        consecutiveFailures
        lastSuccessAt
      }
    }
  }
}`;

const messageBody = JSON.stringify({
  model: "claude-router-auto",
  messages: [{ role: "user", content: "debug this flaky auth regression and find root cause" }],
  max_tokens: 1024,
  stream: true
});

const openAIResponseBody = JSON.stringify({
  model: "gpt-router-auto",
  input: [{ role: "user", content: "debug this flaky auth regression and find root cause" }],
  stream: true
});

describe("BYOK provider credentials", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("forwards with the customer key when bound and never exposes the secret", async () => {
    const fixture = await setup("org_byok_bound");

    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Acme key", apiKey: CUSTOMER_KEY }
    });
    expect(created.errors).toBeUndefined();
    const account = created.data?.createProviderCredential;
    expect(account.name).toBe("Acme key");
    expect(account.providerId).toBe(ANTHROPIC_PROVIDER_ID);
    expect(account.baseUrl).toBeNull();
    expect(account.secretHint.startsWith("••••")).toBe(true);
    expect(JSON.stringify(created)).not.toContain(CUSTOMER_KEY);

    const bound = await gql(fixture, BIND, {
      apiKeyId: "org_byok_bound:api-key:default",
      provider: "anthropic",
      providerAccountId: account.id
    });
    expect(bound.errors).toBeUndefined();
    expect(bound.data?.assignApiKeyProviderAccount.providerCredentials).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "anthropic", providerAccountId: account.id })
    ]));

    await sendMessage(fixture);
    const providerCall = fixture.anthropic.records.find((record) => record.path === "/messages");
    expect(providerCall?.headers["x-api-key"]).toBe(CUSTOMER_KEY);
    const eventRows = await fixture.db.select().from(events);
    const attemptRows = await fixture.db.select().from(providerAttempts).where(eq(providerAttempts.providerAccountId, account.id));
    const started = eventRows.find((event) => event.eventType === "provider.request_started");
    const terminal = eventRows.find((event) => event.eventType === "provider.response_completed");
    expect(started?.payload).toEqual(expect.objectContaining({ providerAccountId: account.id }));
    expect(terminal?.payload).toEqual(expect.objectContaining({ providerAccountId: account.id }));
    expect(attemptRows).toHaveLength(1);

    const list = await gql(fixture, LIST);
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain(CUSTOMER_KEY);
    expect(serialized).not.toContain("secret_ciphertext");
  });

  it("does not resolve provider credential bindings outside the request workspace", async () => {
    const fixture = await setup("org_byok_binding_workspace_scope");

    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Scoped key", apiKey: CUSTOMER_KEY }
    });
    expect(created.errors).toBeUndefined();
    const account = created.data?.createProviderCredential;

    const bound = await gql(fixture, BIND, {
      apiKeyId: "org_byok_binding_workspace_scope:api-key:default",
      provider: "anthropic",
      providerAccountId: account.id
    });
    expect(bound.errors).toBeUndefined();

    const scopedCredential = await fixture.persistence.providerCredentials.resolveForRequest({
      organizationId: "org_byok_binding_workspace_scope",
      workspaceId: defaultWorkspaceId("org_byok_binding_workspace_scope"),
      apiKeyId: "org_byok_binding_workspace_scope:api-key:default",
      provider: "anthropic"
    });
    expect(scopedCredential?.providerAccountId).toBe(account.id);

    const otherWorkspaceCredential = await fixture.persistence.providerCredentials.resolveForRequest({
      organizationId: "org_byok_binding_workspace_scope",
      workspaceId: "org_byok_binding_workspace_scope:workspace:other",
      apiKeyId: "org_byok_binding_workspace_scope:api-key:default",
      provider: "anthropic"
    });
    expect(otherWorkspaceCredential).toBeUndefined();
  });

  it("emits provider account cooldown events for BYOK rate limits", async () => {
    const fixture = await setup("org_byok_rate_limited", {
      PROVIDER_RATE_LIMIT_MAX_ATTEMPTS: "1",
      PROVIDER_RATE_LIMIT_MAX_DELAY_MS: "1"
    });
    const rateLimitedOpenAI = await startOpenAIMock({
      rateLimitProviderOnce: {
        headers: { "retry-after": "30" }
      }
    });

    try {
      const created = await gql(fixture, CREATE, {
        input: {
          provider: "openai",
          name: "Rate limited key",
          apiKey: "sk-openai-customer",
          baseUrl: rateLimitedOpenAI.url
        }
      });
      expect(created.errors).toBeUndefined();
      const account = created.data?.createProviderCredential;

      const bound = await gql(fixture, BIND, {
        apiKeyId: "org_byok_rate_limited:api-key:default",
        provider: "openai",
        providerAccountId: account.id
      });
      expect(bound.errors).toBeUndefined();

      const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
        method: "POST",
        headers: {
          "x-api-key": "proxy-token",
          "content-type": "application/json"
        },
        body: openAIResponseBody
      });
      await response.text();

      const eventRows = await fixture.db.select().from(events);
      const cooldown = eventRows.find((event) => event.eventType === "provider_account.cooldown_started");

      expect(response.status).toBe(429);
      expect(cooldown?.workspaceId).toBe(defaultWorkspaceId("org_byok_rate_limited"));
      expect(cooldown?.scopeType).toBe("provider_account");
      expect(cooldown?.scopeId).toBe(account.id);
      expect(cooldown?.payload).toEqual(expect.objectContaining({
        providerAccountId: account.id,
        classification: expect.objectContaining({
          errorType: "rate_limited",
          scope: "provider_account"
        })
      }));
    } finally {
      await rateLimitedOpenAI.close();
    }
  });

  it("exposes provider account health and model lockouts through admin GraphQL", async () => {
    const organizationId = "org_byok_health_graphql";
    const fixture = await setup(organizationId);
    const cooldownUntil = new Date("2026-06-18T12:05:00.000Z");
    const lastErrorAt = new Date("2026-06-18T12:00:00.000Z");
    const lastSuccessAt = new Date("2026-06-18T11:55:00.000Z");
    const lockoutUntil = new Date("2026-06-18T12:10:00.000Z");

    const created = await gql(fixture, CREATE, {
      input: {
        provider: "openai",
        name: "Health key",
        apiKey: "sk-openai-health"
      }
    });
    expect(created.errors).toBeUndefined();
    const account = created.data?.createProviderCredential;

    await fixture.db.insert(providerAccountHealth).values({
      id: `${organizationId}:account-health`,
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      providerAccountId: account.id,
      providerId: account.providerId,
      status: "cooldown",
      lastErrorType: "rate_limited",
      lastErrorMessage: "rate limited",
      lastErrorAt,
      cooldownUntil,
      consecutiveFailures: 2,
      lastSuccessAt,
      metadata: {}
    });
    await fixture.db.insert(providerModelHealth).values({
      id: `${organizationId}:model-health`,
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      providerId: account.providerId,
      providerAccountId: account.id,
      model: "gpt-locked",
      status: "locked_out",
      lastErrorType: "model_unavailable",
      lastErrorAt,
      lockoutUntil,
      consecutiveFailures: 1,
      lastSuccessAt,
      metadata: {}
    });

    const result = await gql(fixture, HEALTH_LIST);
    const listed = (result.data?.providerAccounts ?? []).find((row: { id: string }) => row.id === account.id);

    expect(result.errors).toBeUndefined();
    expect(listed?.health).toEqual({
      status: "cooldown",
      cooldownUntil: cooldownUntil.toISOString(),
      lastErrorType: "rate_limited",
      lastErrorAt: lastErrorAt.toISOString(),
      lastSuccessAt: lastSuccessAt.toISOString(),
      consecutiveFailures: 2,
      modelHealth: [
        {
          providerId: account.providerId,
          providerAccountId: account.id,
          model: "gpt-locked",
          status: "locked_out",
          lastErrorType: "model_unavailable",
          lastErrorAt: lastErrorAt.toISOString(),
          lockoutUntil: lockoutUntil.toISOString(),
          consecutiveFailures: 1,
          lastSuccessAt: lastSuccessAt.toISOString()
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("sk-openai-health");
  });

  it("probes a provider account and records healthy state", async () => {
    const organizationId = "org_byok_probe_success";
    const fixture = await setup(organizationId);

    const created = await gql(fixture, CREATE, {
      input: {
        provider: "openai",
        name: "Probe key",
        apiKey: "sk-openai-probe",
        baseUrl: fixture.openai.url
      }
    });
    expect(created.errors).toBeUndefined();
    const account = created.data?.createProviderCredential;

    const result = await gql(fixture, PROBE, {
      input: {
        providerAccountId: account.id,
        model: "gpt-probe"
      }
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.probeProviderCredential).toEqual(expect.objectContaining({
      providerAccountId: account.id,
      provider: "openai",
      model: "gpt-probe",
      status: "success",
      healthStatus: "healthy",
      statusCode: 200,
      stateUpdated: true
    }));
    expect(JSON.stringify(result)).not.toContain("sk-openai-probe");

    const probeCalls = fixture.openai.records.filter((record) =>
      record.path === "/responses" && record.body.model === "gpt-probe"
    );
    expect(probeCalls).toHaveLength(2);
    expect(probeCalls[0]?.body).toEqual(expect.objectContaining({
      stream: false,
      max_output_tokens: 8
    }));
    expect(probeCalls[1]?.body).toEqual(expect.objectContaining({ stream: true }));
    expect(probeCalls[0]?.headers.authorization).toBe("Bearer sk-openai-probe");

    const [accountHealth] = await fixture.db
      .select()
      .from(providerAccountHealth)
      .where(eq(providerAccountHealth.providerAccountId, account.id));
    const [modelHealth] = await fixture.db
      .select()
      .from(providerModelHealth)
      .where(eq(providerModelHealth.providerAccountId, account.id));
    expect(accountHealth).toEqual(expect.objectContaining({
      organizationId,
      providerAccountId: account.id,
      providerId: account.providerId,
      status: "healthy",
      consecutiveFailures: 0
    }));
    expect(accountHealth.lastCheckedAt).toBeInstanceOf(Date);
    expect(accountHealth.lastSuccessAt).toBeInstanceOf(Date);
    expect(modelHealth).toEqual(expect.objectContaining({
      organizationId,
      providerAccountId: account.id,
      providerId: account.providerId,
      model: "gpt-probe",
      status: "healthy",
      consecutiveFailures: 0
    }));

    const eventRows = await fixture.db.select().from(events);
    const probeEvent = eventRows.find((event) => event.eventType === "provider_account.health_probe_completed");
    expect(probeEvent?.workspaceId).toBe(defaultWorkspaceId(organizationId));
    expect(probeEvent?.scopeType).toBe("provider_account");
    expect(probeEvent?.scopeId).toBe(account.id);
    expect(probeEvent?.payload).toEqual(expect.objectContaining({
      providerAccountId: account.id,
      providerId: account.providerId,
      model: "gpt-probe",
      status: "success",
      healthStatus: "healthy",
      stateUpdated: true,
      dimensions: expect.objectContaining({
        basicChat: expect.objectContaining({ status: "passed" }),
        streaming: expect.objectContaining({ status: "passed" }),
        toolCalls: expect.objectContaining({ status: "not_configured" })
      })
    }));
    expect(JSON.stringify(probeEvent?.payload)).not.toContain("sk-openai-probe");
  });

  it("keeps partial stream probe results event-only", async () => {
    const organizationId = "org_byok_probe_partial_stream";
    const fixture = await setup(organizationId);
    const streamFailingOpenAI = await startOpenAIMock({ failStreamProvider: true });
    const cooldownUntil = new Date("2026-06-18T12:05:00.000Z");
    const lockoutUntil = new Date("2026-06-18T12:10:00.000Z");
    const lastErrorAt = new Date("2026-06-18T12:00:00.000Z");

    try {
      const created = await gql(fixture, CREATE, {
        input: {
          provider: "openai",
          name: "Probe partial key",
          apiKey: "sk-openai-probe-partial",
          baseUrl: streamFailingOpenAI.url
        }
      });
      expect(created.errors).toBeUndefined();
      const account = created.data?.createProviderCredential;
      await fixture.db.insert(providerAccountHealth).values({
        id: `${organizationId}:account-health`,
        organizationId,
        workspaceId: defaultWorkspaceId(organizationId),
        providerAccountId: account.id,
        providerId: account.providerId,
        status: "cooldown",
        lastErrorType: "rate_limited",
        lastErrorMessage: "existing cooldown",
        lastErrorAt,
        cooldownUntil,
        consecutiveFailures: 3,
        metadata: {}
      });
      await fixture.db.insert(providerModelHealth).values({
        id: `${organizationId}:model-health`,
        organizationId,
        workspaceId: defaultWorkspaceId(organizationId),
        providerId: account.providerId,
        providerAccountId: account.id,
        model: "gpt-probe",
        status: "locked_out",
        lastErrorType: "model_unavailable",
        lastErrorAt,
        lockoutUntil,
        consecutiveFailures: 2,
        metadata: {}
      });

      const result = await gql(fixture, PROBE, {
        input: {
          providerAccountId: account.id,
          model: "gpt-probe"
        }
      });

      expect(result.errors).toBeUndefined();
      expect(result.data?.probeProviderCredential).toEqual(expect.objectContaining({
        providerAccountId: account.id,
        provider: "openai",
        model: "gpt-probe",
        status: "partial",
        healthStatus: "unknown",
        errorType: "stream_failed",
        message: "Streaming probe failed.",
        statusCode: 200,
        stateUpdated: false,
        dimensions: expect.objectContaining({
          basicChat: expect.objectContaining({ status: "passed" }),
          streaming: expect.objectContaining({ status: "failed" })
        })
      }));

      const probeCalls = streamFailingOpenAI.records.filter((record) =>
        record.path === "/responses" && record.body.model === "gpt-probe"
      );
      expect(probeCalls.map((record) => record.body.stream)).toEqual([false, true]);

      const [accountHealth] = await fixture.db
        .select()
        .from(providerAccountHealth)
        .where(eq(providerAccountHealth.providerAccountId, account.id));
      const [modelHealth] = await fixture.db
        .select()
        .from(providerModelHealth)
        .where(eq(providerModelHealth.providerAccountId, account.id));
      expect(accountHealth).toEqual(expect.objectContaining({
        status: "cooldown",
        lastErrorType: "rate_limited",
        lastErrorMessage: "existing cooldown",
        consecutiveFailures: 3
      }));
      expect(accountHealth.cooldownUntil?.toISOString()).toBe(cooldownUntil.toISOString());
      expect(modelHealth).toEqual(expect.objectContaining({
        status: "locked_out",
        lastErrorType: "model_unavailable",
        consecutiveFailures: 2
      }));
      expect(modelHealth.lockoutUntil?.toISOString()).toBe(lockoutUntil.toISOString());

      const eventRows = await fixture.db.select().from(events);
      const probeEvent = eventRows.find((event) => event.eventType === "provider_account.health_probe_completed");
      expect(probeEvent?.payload).toEqual(expect.objectContaining({
        status: "partial",
        healthStatus: "unknown",
        errorType: "stream_failed",
        stateUpdated: false,
        dimensions: expect.objectContaining({
          basicChat: expect.objectContaining({ status: "passed" }),
          streaming: expect.objectContaining({ status: "failed" })
        })
      }));
    } finally {
      await streamFailingOpenAI.close();
    }
  });

  it("probes a provider account and records high-confidence failure state", async () => {
    const organizationId = "org_byok_probe_rate_limited";
    const fixture = await setup(organizationId);
    const rateLimitedOpenAI = await startOpenAIMock({
      rateLimitProviderOnce: {
        headers: { "retry-after": "30" },
        body: { error: { message: "mock rate limit", code: "rate_limit" } }
      }
    });

    try {
      const created = await gql(fixture, CREATE, {
        input: {
          provider: "openai",
          name: "Probe rate limit key",
          apiKey: "sk-openai-probe-rate-limit",
          baseUrl: rateLimitedOpenAI.url
        }
      });
      expect(created.errors).toBeUndefined();
      const account = created.data?.createProviderCredential;

      const result = await gql(fixture, PROBE, {
        input: {
          providerAccountId: account.id,
          model: "gpt-probe"
        }
      });

      expect(result.errors).toBeUndefined();
      expect(result.data?.probeProviderCredential).toEqual(expect.objectContaining({
        providerAccountId: account.id,
        provider: "openai",
        model: "gpt-probe",
        status: "failed",
        healthStatus: "cooldown",
        errorType: "rate_limited",
        message: "Probe classified as rate_limited.",
        statusCode: 429,
        stateUpdated: true
      }));
      expect(JSON.stringify(result)).not.toContain("mock rate limit");
      expect(JSON.stringify(result)).not.toContain("sk-openai-probe-rate-limit");
      expect(rateLimitedOpenAI.records.filter((record) => record.path === "/responses")).toHaveLength(1);

      const [accountHealth] = await fixture.db
        .select()
        .from(providerAccountHealth)
        .where(eq(providerAccountHealth.providerAccountId, account.id));
      expect(accountHealth).toEqual(expect.objectContaining({
        organizationId,
        providerAccountId: account.id,
        providerId: account.providerId,
        status: "cooldown",
        lastErrorType: "rate_limited",
        lastErrorMessage: "Probe classified as rate_limited.",
        consecutiveFailures: 1
      }));
      expect(accountHealth.cooldownUntil).toBeInstanceOf(Date);
      expect(accountHealth.lastCheckedAt).toBeInstanceOf(Date);

      const eventRows = await fixture.db.select().from(events);
      const probeEvent = eventRows.find((event) => event.eventType === "provider_account.health_probe_completed");
      expect(probeEvent?.payload).toEqual(expect.objectContaining({
        providerAccountId: account.id,
        providerId: account.providerId,
        model: "gpt-probe",
        status: "failed",
        healthStatus: "cooldown",
        errorType: "rate_limited",
        message: "Probe classified as rate_limited.",
        stateUpdated: true,
        classification: expect.objectContaining({
          errorType: "rate_limited",
          scope: "provider_account",
          message: "Probe classified as rate_limited."
        })
      }));
      expect(JSON.stringify(probeEvent?.payload)).not.toContain("mock rate limit");
      expect(JSON.stringify(probeEvent?.payload)).not.toContain("sk-openai-probe-rate-limit");
    } finally {
      await rateLimitedOpenAI.close();
    }
  });

  it("round-trips a credential binding for an org-scoped custom provider", async () => {
    const fixture = await setup("org_byok_custom");
    await fixture.db.insert(providers).values({
      id: CUSTOM_PROVIDER_ID,
      organizationId: "org_byok_custom",
      slug: "acme-vllm",
      displayName: "Acme vLLM",
      baseUrl: "http://10.0.0.5:8000/v1",
      authStyle: "bearer",
      endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
      defaultHeaders: {},
      forwardHarnessHeaders: false,
      enabled: true
    });

    const created = await gql(fixture, CREATE, {
      input: {
        provider: "acme-vllm",
        name: "Acme custom key",
        apiKey: "sk-acme-custom",
        baseUrl: "http://10.0.0.6:8000/v1"
      }
    });
    expect(created.errors).toBeUndefined();
    const account = created.data?.createProviderCredential;
    expect(account).toMatchObject({
      providerId: CUSTOM_PROVIDER_ID,
      provider: "acme-vllm",
      baseUrl: "http://10.0.0.6:8000/v1",
      name: "Acme custom key"
    });

    const bound = await gql(fixture, BIND, {
      apiKeyId: "org_byok_custom:api-key:default",
      provider: "acme-vllm",
      providerAccountId: account.id
    });
    expect(bound.errors).toBeUndefined();
    expect(bound.data?.assignApiKeyProviderAccount.providerCredentials).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "acme-vllm",
        providerId: CUSTOM_PROVIDER_ID,
        providerAccountId: account.id
      })
    ]));
    expect(JSON.stringify(created)).not.toContain("sk-acme-custom");
  });

  it("forwards through a provider account base URL override", async () => {
    const fixture = await setup("org_byok_account_base_url");
    const alternateAnthropic = await startAnthropicMock();

    try {
      const created = await gql(fixture, CREATE, {
        input: {
          provider: "anthropic",
          name: "Regional Anthropic key",
          apiKey: CUSTOMER_KEY,
          baseUrl: alternateAnthropic.url
        }
      });
      expect(created.errors).toBeUndefined();
      const account = created.data?.createProviderCredential;
      expect(account.baseUrl).toBe(alternateAnthropic.url);

      const bound = await gql(fixture, BIND, {
        apiKeyId: "org_byok_account_base_url:api-key:default",
        provider: "anthropic",
        providerAccountId: account.id
      });
      expect(bound.errors).toBeUndefined();

      await sendMessage(fixture);

      const alternateCall = alternateAnthropic.records.find((record) => record.path === "/messages");
      expect(alternateCall?.headers["x-api-key"]).toBe(CUSTOMER_KEY);
      expect(fixture.anthropic.records.find((record) => record.path === "/messages")).toBeUndefined();
    } finally {
      await alternateAnthropic.close();
    }
  });

  it("does not follow redirects from provider account base URL overrides", async () => {
    const fixture = await setup("org_byok_account_base_url_redirect");
    const redirectTarget = await startOpenAIMock();
    const redirectSource = await startOpenAIMock({ redirectProviderTo: redirectTarget.url });

    try {
      const created = await gql(fixture, CREATE, {
        input: {
          provider: "openai",
          name: "Redirecting OpenAI key",
          apiKey: "sk-openai-redirect",
          baseUrl: redirectSource.url
        }
      });
      expect(created.errors).toBeUndefined();
      const account = created.data?.createProviderCredential;
      const bound = await gql(fixture, BIND, {
        apiKeyId: "org_byok_account_base_url_redirect:api-key:default",
        provider: "openai",
        providerAccountId: account.id
      });
      expect(bound.errors).toBeUndefined();

      const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "x-api-key": "proxy-token",
          "content-type": "application/json"
        },
        body: openAIResponseBody
      });

      expect(response.status).toBe(302);
      expect(redirectTarget.records.find((record) => record.body.model === "gpt-router-auto")).toBeUndefined();
    } finally {
      await redirectSource.close();
      await redirectTarget.close();
    }
  });

  it("lists effective registry providers for routing config editors", async () => {
    const fixture = await setup("org_byok_provider_registry");
    await fixture.db.insert(providers).values({
      id: SHADOW_OPENAI_PROVIDER_ID,
      organizationId: "org_byok_provider_registry",
      slug: "openai",
      displayName: "OpenAI Gateway",
      baseUrl: "https://gateway.example.test/v1",
      authStyle: "none",
      endpoints: [{ dialect: "openai-responses", path: "/responses" }],
      defaultHeaders: {},
      forwardHarnessHeaders: false,
      enabled: true
    });

    const result = await gql(fixture, PROVIDERS);

    expect(result.errors).toBeUndefined();
    const rows = result.data?.providers ?? [];
    expect(rows.filter((provider) => provider.slug === "openai")).toHaveLength(1);
    expect(rows.find((provider) => provider.slug === "openai")).toMatchObject({
      slug: "openai",
      displayName: "OpenAI Gateway",
      authStyle: "none",
      builtin: false,
      endpoints: [{ dialect: "openai-responses", path: "/responses" }]
    });
    expect(rows.find((provider) => provider.slug === "anthropic")).toMatchObject({
      slug: "anthropic",
      builtin: true
    });
  });

  it("lists enabled provider catalog models in model discovery", async () => {
    const organizationId = "org_byok_model_discovery";
    const fixture = await setup(organizationId);
    await fixture.db.insert(providers).values({
      id: CUSTOM_PROVIDER_ID,
      organizationId,
      slug: "acme-responses",
      displayName: "Acme Responses",
      baseUrl: "https://acme.example.test/v1",
      authStyle: "none",
      endpoints: [{ dialect: "openai-responses", path: "/responses" }],
      defaultHeaders: {},
      forwardHarnessHeaders: false,
      enabled: true
    });
    await fixture.db.insert(modelCatalog).values({
      id: `${organizationId}:model:acme-coder`,
      organizationId,
      providerId: CUSTOM_PROVIDER_ID,
      model: "acme-coder",
      capabilities: {},
      pricing: {}
    });

    const response = await fetch(`${fixture.proxyUrl}/v1/models`, {
      headers: { authorization: "Bearer proxy-token" }
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "anthropic-router-deep" }),
      expect.objectContaining({
        id: "acme-coder",
        object: "model",
        owned_by: "acme-responses",
        type: "model",
        display_name: "acme-coder"
      })
    ]));

    const publicResponse = await fetch(`${fixture.proxyUrl}/v1/models`);
    const publicBody = await publicResponse.json();
    expect(publicBody.data.some((model) => model.id === "acme-coder")).toBe(false);
  });

  it("forwards through an org provider row that shadows a builtin slug", async () => {
    const organizationId = "org_provider_shadow";
    const fixture = await setup(organizationId);
    const shadowOpenAI = await startOpenAIMock();
    const providerAccountId = `${organizationId}:provider-account:shadow-openai`;

    try {
      await fixture.db.insert(providers).values({
        id: SHADOW_OPENAI_PROVIDER_ID,
        organizationId,
        slug: "openai",
        displayName: "Shadow OpenAI",
        baseUrl: shadowOpenAI.url,
        authStyle: "bearer",
        endpoints: [{ dialect: "openai-responses", path: "/responses" }],
        defaultHeaders: { "x-acme-provider": "shadow" },
        forwardHarnessHeaders: false,
        enabled: true
      });
      await fixture.db.insert(providerAccounts).values({
        id: providerAccountId,
        organizationId,
        providerId: SHADOW_OPENAI_PROVIDER_ID,
        name: "Shadow OpenAI key",
        authType: "api_key",
        secretCiphertext: encryptSecret("sk-shadow-openai", ENCRYPTION_KEY),
        secretHint: "••••enai",
        settings: {}
      });
      await fixture.db.insert(apiKeyProviderAccounts).values({
        organizationId,
        workspaceId: defaultWorkspaceId(organizationId),
        apiKeyId: `${organizationId}:api-key:default`,
        providerId: SHADOW_OPENAI_PROVIDER_ID,
        providerAccountId
      });

      const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer proxy-token",
          "content-type": "application/json",
          "x-codex-turn-state": "should-not-forward"
        },
        body: JSON.stringify({
          model: "router-auto",
          input: "fix the failing auth test and find root cause",
          stream: true
        })
      });

      expect(response.status).toBe(200);
      await response.text();

      const shadowCall = shadowOpenAI.records.find((record) =>
        record.path === "/responses" && record.body.model === "gpt-5.5"
      );
      expect(shadowCall?.headers.authorization).toBe("Bearer sk-shadow-openai");
      expect(shadowCall?.headers["x-acme-provider"]).toBe("shadow");
      expect(shadowCall?.headers["x-codex-turn-state"]).toBeUndefined();
      expect(shadowCall?.body.model).toBe("gpt-5.5");
      expect(fixture.openai.records.find((record) => record.body.model === "gpt-5.5")).toBeUndefined();
    } finally {
      await shadowOpenAI.close();
    }
  });

  it("rejects org provider rows without falling back to operator credentials", async () => {
    const organizationId = "org_provider_unbound";
    const fixture = await setup(organizationId);
    const shadowOpenAI = await startOpenAIMock();

    try {
      await fixture.db.insert(providers).values({
        id: UNBOUND_OPENAI_PROVIDER_ID,
        organizationId,
        slug: "openai",
        displayName: "Unbound OpenAI",
        baseUrl: shadowOpenAI.url,
        authStyle: "bearer",
        endpoints: [{ dialect: "openai-responses", path: "/responses" }],
        defaultHeaders: {},
        forwardHarnessHeaders: true,
        enabled: true
      });
      await fixture.db
        .update(providers)
        .set({ enabled: false })
        .where(eq(providers.slug, "anthropic"));

      const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer proxy-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "router-auto",
          input: "fix the failing auth test and find root cause",
          stream: true
        })
      });
      const body = await response.json();

      const eventRows = await fixture.db.select().from(events);
      const decision = eventRows.find((event) => event.eventType === "routing.decision_recorded");

      expect(response.status).toBe(400);
      expect(body.error).toBe("route_not_available_for_surface");
      expect(decision?.payload).toEqual(expect.objectContaining({
        guardrailActions: expect.arrayContaining([
          "target_skipped_provider_credential_unresolved:openai"
        ])
      }));
      expect(shadowOpenAI.records.find((record) => record.body.model === "gpt-5.5")).toBeUndefined();
      expect(fixture.openai.records.find((record) => record.body.model === "gpt-5.5")).toBeUndefined();
    } finally {
      await shadowOpenAI.close();
    }
  });

  it("forwards dialect headers but not identity headers to org Anthropic endpoints by default", async () => {
    const organizationId = "org_provider_anthropic_headers";
    const fixture = await setup(organizationId);
    const customAnthropic = await startAnthropicMock();

    try {
      await fixture.db.insert(providers).values({
        id: CUSTOM_ANTHROPIC_PROVIDER_ID,
        organizationId,
        slug: "anthropic",
        displayName: "Custom Anthropic",
        baseUrl: customAnthropic.url,
        authStyle: "none",
        endpoints: [{ dialect: "anthropic-messages", path: "/messages" }],
        defaultHeaders: {},
        forwardHarnessHeaders: false,
        enabled: true
      });

      const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: "Bearer proxy-token",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          "x-claude-code-session-id": "claude-private-session"
        },
        body: messageBody
      });

      expect(response.status).toBe(200);
      await response.text();

      const providerCall = customAnthropic.records.find((record) => record.path === "/messages");
      expect(providerCall?.headers["anthropic-version"]).toBe("2023-06-01");
      expect(providerCall?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
      expect(providerCall?.headers["x-claude-code-session-id"]).toBeUndefined();
      expect(fixture.anthropic.records.find((record) => record.path === "/messages")).toBeUndefined();
    } finally {
      await customAnthropic.close();
    }
  });

  it("does not follow redirects from org upstream providers", async () => {
    const organizationId = "org_provider_redirect";
    const fixture = await setup(organizationId);
    const redirectTarget = await startOpenAIMock();
    const redirectSource = await startOpenAIMock({ redirectProviderTo: redirectTarget.url });

    try {
      await fixture.db.insert(providers).values({
        id: REDIRECT_OPENAI_PROVIDER_ID,
        organizationId,
        slug: "openai",
        displayName: "Redirecting OpenAI",
        baseUrl: redirectSource.url,
        authStyle: "none",
        endpoints: [{ dialect: "openai-responses", path: "/responses" }],
        defaultHeaders: {},
        forwardHarnessHeaders: true,
        enabled: true
      });

      const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: "Bearer proxy-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "router-auto",
          input: "fix the failing auth test and find root cause",
          stream: true
        })
      });

      expect(response.status).toBe(302);
      expect(redirectTarget.records.find((record) => record.body.model === "gpt-5.5")).toBeUndefined();
    } finally {
      await redirectSource.close();
      await redirectTarget.close();
    }
  });

  it("falls back to the company key when no credential is bound", async () => {
    const fixture = await setup("org_byok_default");
    await sendMessage(fixture);
    const providerCall = fixture.anthropic.records.find((record) => record.path === "/messages");
    expect(providerCall?.headers["x-api-key"]).toBe("anthropic-upstream-key");
  });

  it("falls back to the company key after a binding is cleared", async () => {
    const fixture = await setup("org_byok_cleared");
    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Temp key", apiKey: CUSTOMER_KEY }
    });
    const accountId = created.data?.createProviderCredential.id;
    await gql(fixture, BIND, { apiKeyId: "org_byok_cleared:api-key:default", provider: "anthropic", providerAccountId: accountId });
    await sendMessage(fixture);
    expect(fixture.anthropic.records.at(-1)?.headers["x-api-key"]).toBe(CUSTOMER_KEY);

    await gql(fixture, BIND, { apiKeyId: "org_byok_cleared:api-key:default", provider: "anthropic", providerAccountId: null });

    await sendMessage(fixture);
    expect(fixture.anthropic.records.at(-1)?.headers["x-api-key"]).toBe("anthropic-upstream-key");
  });

  it("uses a binding created after an unbound request immediately", async () => {
    const fixture = await setup("org_byok_bind_after_miss");
    await sendMessage(fixture);
    expect(fixture.anthropic.records.at(-1)?.headers["x-api-key"]).toBe("anthropic-upstream-key");

    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Late key", apiKey: CUSTOMER_KEY }
    });
    const accountId = created.data?.createProviderCredential.id;
    const bound = await gql(fixture, BIND, {
      apiKeyId: "org_byok_bind_after_miss:api-key:default",
      provider: "anthropic",
      providerAccountId: accountId
    });
    expect(bound.errors).toBeUndefined();

    await sendMessage(fixture);
    expect(fixture.anthropic.records.at(-1)?.headers["x-api-key"]).toBe(CUSTOMER_KEY);
  });

  it("uses a newly bound credential immediately when a key rotates", async () => {
    const fixture = await setup("org_byok_rotate_binding");
    const first = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "First key", apiKey: CUSTOMER_KEY }
    });
    await gql(fixture, BIND, {
      apiKeyId: "org_byok_rotate_binding:api-key:default",
      provider: "anthropic",
      providerAccountId: first.data?.createProviderCredential.id
    });
    await sendMessage(fixture);
    expect(fixture.anthropic.records.at(-1)?.headers["x-api-key"]).toBe(CUSTOMER_KEY);

    const rotatedKey = "sk-ant-customer-rotated";
    const second = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Rotated key", apiKey: rotatedKey }
    });
    await gql(fixture, BIND, {
      apiKeyId: "org_byok_rotate_binding:api-key:default",
      provider: "anthropic",
      providerAccountId: second.data?.createProviderCredential.id
    });
    await sendMessage(fixture);
    expect(fixture.anthropic.records.at(-1)?.headers["x-api-key"]).toBe(rotatedKey);
  });

  it("falls back to the company key after a cached credential is revoked", async () => {
    const fixture = await setup("org_byok_revoke_cached");
    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Revoked key", apiKey: CUSTOMER_KEY }
    });
    const accountId = created.data?.createProviderCredential.id;
    await gql(fixture, BIND, {
      apiKeyId: "org_byok_revoke_cached:api-key:default",
      provider: "anthropic",
      providerAccountId: accountId
    });
    await sendMessage(fixture);
    expect(fixture.anthropic.records.at(-1)?.headers["x-api-key"]).toBe(CUSTOMER_KEY);

    const revoke = await gql(fixture, REVOKE, { id: accountId });
    expect(revoke.errors).toBeUndefined();

    await sendMessage(fixture);
    expect(fixture.anthropic.records.at(-1)?.headers["x-api-key"]).toBe("anthropic-upstream-key");
  });

  it("allows reusing a revoked credential's label", async () => {
    const fixture = await setup("org_byok_relabel");
    const first = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Acme key", apiKey: CUSTOMER_KEY }
    });
    const accountId = first.data?.createProviderCredential.id;

    const revoke = await gql(fixture, REVOKE, { id: accountId });
    expect(revoke.errors).toBeUndefined();

    const second = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Acme key", apiKey: "sk-ant-customer-rotated" }
    });
    expect(second.errors).toBeUndefined();

    const list = await gql(fixture, LIST);
    const named = (list.data?.providerAccounts ?? []).filter((row: { name: string }) => row.name === "Acme key");
    expect(named).toHaveLength(2);
    expect(named.filter((row: { status: string }) => row.status === "active")).toHaveLength(1);
  });

  async function setup(organizationId: string, envOverrides: Record<string, string> = {}) {
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: {
        PROVIDER_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY,
        ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8,10.0.0.0/8",
        ...envOverrides
      }
    });
    return activeFixture;
  }
});

describe("subscription oauth credentials", () => {
  const OAUTH_TOKEN = "sk-ant-oat01-fake-subscription-token";
  const OPENAI_OAUTH_TOKEN = "openai-chatgpt-access-token";
  const CHATGPT_ACCOUNT_ID = "chatgpt-account-test";

  let activeFixture: PromptTestFixture | undefined;
  const savedEnv = {
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    PROXY_CODEX_AUTH_FILE: process.env.PROXY_CODEX_AUTH_FILE,
    CODEX_HOME: process.env.CODEX_HOME
  };

  afterEach(async () => {
    restoreEnv("CLAUDE_CODE_OAUTH_TOKEN", savedEnv.CLAUDE_CODE_OAUTH_TOKEN);
    restoreEnv("PROXY_CODEX_AUTH_FILE", savedEnv.PROXY_CODEX_AUTH_FILE);
    restoreEnv("CODEX_HOME", savedEnv.CODEX_HOME);
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("stores an oauth credential with the flag on and never returns the token", async () => {
    const fixture = await setup("org_oauth_create", { SUBSCRIPTION_OAUTH_ENABLED: "true" });

    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "My Max sub", authType: "oauth", apiKey: OAUTH_TOKEN }
    });
    expect(created.errors).toBeUndefined();
    const account = created.data?.createProviderCredential;
    expect(account.authType).toBe("oauth");
    expect(account.secretHint.startsWith("••••")).toBe(true);
    expect(account.secretHint).not.toBe(OAUTH_TOKEN);
    expect(JSON.stringify(created)).not.toContain(OAUTH_TOKEN);

    const list = await gql(fixture, LIST);
    expect(JSON.stringify(list)).not.toContain(OAUTH_TOKEN);
    const listed = (list.data?.providerAccounts ?? []).find((row: { id: string }) => row.id === account.id);
    expect(listed?.authType).toBe("oauth");
  });

  it("rejects Anthropic oauth credentials when the flag is off", async () => {
    const fixture = await setup("org_oauth_disabled", { SUBSCRIPTION_OAUTH_ENABLED: "false" });

    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "My Max sub", authType: "oauth", apiKey: OAUTH_TOKEN }
    });
    expect(created.errors?.[0]?.message).toBe("subscription_oauth_disabled");
  });

  it("stores an OpenAI oauth credential when the flag is off", async () => {
    const fixture = await setup("org_oauth_openai_create_flag_off", { SUBSCRIPTION_OAUTH_ENABLED: "false" });

    const created = await gql(fixture, CREATE, {
      input: {
        provider: "openai",
        name: "My ChatGPT sub",
        authType: "oauth",
        apiKey: OPENAI_OAUTH_TOKEN,
        chatgptAccountId: CHATGPT_ACCOUNT_ID
      }
    });
    expect(created.errors).toBeUndefined();
    expect(created.data?.createProviderCredential.authType).toBe("oauth");
    expect(JSON.stringify(created)).not.toContain(OPENAI_OAUTH_TOKEN);
  });

  it("rejects oauth tokens without the setup-token prefix", async () => {
    const fixture = await setup("org_oauth_prefix", { SUBSCRIPTION_OAUTH_ENABLED: "true" });

    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "My Max sub", authType: "oauth", apiKey: "sk-ant-api03-not-a-subscription" }
    });
    expect(created.errors?.[0]?.message).toBe("invalid_subscription_token");
  });

  it("stores an OpenAI oauth credential with a ChatGPT account ID", async () => {
    const fixture = await setup("org_oauth_openai_create", { SUBSCRIPTION_OAUTH_ENABLED: "true" });

    const created = await gql(fixture, CREATE, {
      input: {
        provider: "openai",
        name: "My ChatGPT sub",
        authType: "oauth",
        apiKey: OPENAI_OAUTH_TOKEN,
        chatgptAccountId: CHATGPT_ACCOUNT_ID
      }
    });
    expect(created.errors).toBeUndefined();
    expect(created.data?.createProviderCredential.authType).toBe("oauth");
    expect(JSON.stringify(created)).not.toContain(OPENAI_OAUTH_TOKEN);
  });

  it("stores OpenAI auth JSON refresh tokens inside the encrypted token bundle", async () => {
    const fixture = await setup("org_oauth_openai_auth_json", { SUBSCRIPTION_OAUTH_ENABLED: "true" });

    const created = await gql(fixture, CREATE, {
      input: {
        provider: "openai",
        name: "My ChatGPT sub",
        authType: "oauth",
        apiKey: JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            access_token: OPENAI_OAUTH_TOKEN,
            refresh_token: "openai-refresh-token"
          },
          chatgpt_account_id: CHATGPT_ACCOUNT_ID
        })
      }
    });
    expect(created.errors).toBeUndefined();

    const [row] = await fixture.db
      .select({
        secretCiphertext: providerAccounts.secretCiphertext,
        settings: providerAccounts.settings
      })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, created.data?.createProviderCredential.id));
    expect(row).toBeTruthy();
    const secret = parseOpenAIChatGPTSecret(decryptSecret(row!.secretCiphertext ?? "", ENCRYPTION_KEY));
    expect(secret.kind).toBe("token_bundle");
    expect(secret.kind === "token_bundle" ? secret.bundle.accessToken : null).toBe(OPENAI_OAUTH_TOKEN);
    expect(secret.kind === "token_bundle" ? secret.bundle.refreshToken : null).toBe("openai-refresh-token");
    expect(JSON.stringify(row!.settings)).not.toContain("refresh");
  });

  it("imports a Claude subscription token from the proxy environment", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = OAUTH_TOKEN;
    const fixture = await setup("org_oauth_local_claude", { SUBSCRIPTION_OAUTH_ENABLED: "true" });

    const created = await gql(fixture, CREATE_LOCAL, {
      input: { provider: "anthropic", name: "Local Claude sub" }
    });
    expect(created.errors).toBeUndefined();
    expect(created.data?.createProviderCredentialFromLocalAuth.authType).toBe("oauth");
    expect(JSON.stringify(created)).not.toContain(OAUTH_TOKEN);

    const [row] = await fixture.db
      .select({
        secretCiphertext: providerAccounts.secretCiphertext,
        settings: providerAccounts.settings
      })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, created.data?.createProviderCredentialFromLocalAuth.id));
    expect(row).toBeTruthy();
    expect(decryptSecret(row!.secretCiphertext ?? "", ENCRYPTION_KEY)).toBe(OAUTH_TOKEN);
    expect(row!.settings).toEqual({ tokenKind: "claude_oauth", source: "setup-token" });
  });

  it("rejects Claude local auth import when subscription auth is disabled", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const fixture = await setup("org_oauth_local_claude_disabled", { SUBSCRIPTION_OAUTH_ENABLED: "false" });

    const created = await gql(fixture, CREATE_LOCAL, {
      input: { provider: "anthropic", name: "Local Claude sub" }
    });
    expect(created.errors?.[0]?.message).toBe("subscription_oauth_disabled");
  });

  it("imports Codex auth JSON from the proxy host with encrypted refresh tokens", async () => {
    const authDir = await mkdtemp(join(tmpdir(), "proxy-codex-auth-"));
    const authPath = join(authDir, "auth.json");
    await writeFile(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: OPENAI_OAUTH_TOKEN,
        refresh_token: "openai-refresh-token",
        account_id: CHATGPT_ACCOUNT_ID
      }
    }));
    process.env.PROXY_CODEX_AUTH_FILE = authPath;
    const fixture = await setup("org_oauth_local_openai", { SUBSCRIPTION_OAUTH_ENABLED: "false" });

    try {
      const created = await gql(fixture, CREATE_LOCAL, {
        input: { provider: "openai", name: "Local Codex auth" }
      });
      expect(created.errors).toBeUndefined();
      expect(created.data?.createProviderCredentialFromLocalAuth.authType).toBe("oauth");
      expect(JSON.stringify(created)).not.toContain(OPENAI_OAUTH_TOKEN);
      expect(JSON.stringify(created)).not.toContain("openai-refresh-token");

      const [row] = await fixture.db
        .select({
          secretCiphertext: providerAccounts.secretCiphertext,
          settings: providerAccounts.settings
        })
        .from(providerAccounts)
        .where(eq(providerAccounts.id, created.data?.createProviderCredentialFromLocalAuth.id));
      expect(row).toBeTruthy();
      const secret = parseOpenAIChatGPTSecret(decryptSecret(row!.secretCiphertext ?? "", ENCRYPTION_KEY));
      expect(secret.kind).toBe("token_bundle");
      expect(secret.kind === "token_bundle" ? secret.bundle.accessToken : null).toBe(OPENAI_OAUTH_TOKEN);
      expect(secret.kind === "token_bundle" ? secret.bundle.refreshToken : null).toBe("openai-refresh-token");
      expect(row!.settings).toEqual({
        tokenKind: "openai_chatgpt",
        source: "codex-auth-json",
        tokenStorage: "token_bundle",
        chatgptAccountId: CHATGPT_ACCOUNT_ID
      });
      expect(JSON.stringify(row!.settings)).not.toContain("refresh");
    } finally {
      await rm(authDir, { recursive: true, force: true });
    }
  });

  it("creates an OpenAI subscription credential through device-code auth", async () => {
    const fixture = await setup("org_oauth_openai_device", { SUBSCRIPTION_OAUTH_ENABLED: "false" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return jsonResponse({
          device_auth_id: "device-auth-1",
          user_code: "ABCD-1234",
          interval: "1"
        });
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return jsonResponse({
          authorization_code: "authorization-code-1",
          code_verifier: "code-verifier-1"
        });
      }
      if (url.endsWith("/oauth/token")) {
        return jsonResponse({
          access_token: OPENAI_OAUTH_TOKEN,
          refresh_token: "openai-refresh-token",
          expires_in: 3600,
          id_token: fakeJwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: CHATGPT_ACCOUNT_ID
            }
          })
        });
      }
      return new Response("not found", { status: 404 });
    });
    const oauth = new ProviderCredentialOAuthService(
      fixture.persistence.providerCredentialAdmin,
      fetchMock as unknown as typeof fetch
    );

    const started = await oauth.startOpenAICodexDeviceAuth({
      organizationId: "org_oauth_openai_device",
      actorUserId: "local-user",
      name: "Device Codex auth"
    });
    expect(started.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(started.userCode).toBe("ABCD-1234");
    expect(oauth.status(started.loginId, {
      organizationId: "other-org",
      actorUserId: "local-user"
    })).toBeNull();

    const status = await waitForOAuthCompletion(oauth, started.loginId, {
      organizationId: "org_oauth_openai_device",
      actorUserId: "local-user"
    });
    expect(status.status).toBe("completed");
    expect(status.providerAccountId).toBeTruthy();

    const [row] = await fixture.db
      .select({
        secretCiphertext: providerAccounts.secretCiphertext,
        settings: providerAccounts.settings
      })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, status.providerAccountId));
    const secret = parseOpenAIChatGPTSecret(decryptSecret(row!.secretCiphertext ?? "", ENCRYPTION_KEY));
    expect(secret.kind).toBe("token_bundle");
    expect(secret.kind === "token_bundle" ? secret.bundle.refreshToken : null).toBe("openai-refresh-token");
    expect(row!.settings).toEqual({
      tokenKind: "openai_chatgpt",
      source: "codex-device-auth",
      tokenStorage: "token_bundle",
      chatgptAccountId: CHATGPT_ACCOUNT_ID
    });
  });

  it("creates an Anthropic subscription credential through browser OAuth", async () => {
    const fixture = await setup("org_oauth_anthropic_browser", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://platform.claude.com/v1/oauth/token") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.grant_type).toBe("authorization_code");
        expect(body.code).toBe("anthropic-code-1");
        expect(body.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
        expect(body.redirect_uri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
        expect(body.code_verifier).toEqual(expect.any(String));
        expect(body.state).toEqual(expect.any(String));
        expect(body.expires_in).toBe(365 * 24 * 60 * 60);
        return jsonResponse({
          access_token: OAUTH_TOKEN,
          expires_in: 365 * 24 * 60 * 60,
          scope: "user:inference"
        });
      }
      return new Response("not found", { status: 404 });
    });
    const oauth = new ProviderCredentialOAuthService(
      fixture.persistence.providerCredentialAdmin,
      fetchMock as unknown as typeof fetch
    );

    const started = await oauth.startAnthropicClaudeCodeAuth({
      organizationId: "org_oauth_anthropic_browser",
      actorUserId: "local-user",
      name: "Browser Claude auth"
    });
    const verificationUrl = new URL(started.verificationUrl);
    expect(`${verificationUrl.origin}${verificationUrl.pathname}`).toBe("https://claude.com/cai/oauth/authorize");
    expect(verificationUrl.searchParams.get("scope")).toBe("user:inference");
    expect(verificationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(started.userCode).toBeNull();

    const redirectUri = verificationUrl.searchParams.get("redirect_uri");
    const state = verificationUrl.searchParams.get("state");
    if (!redirectUri || !state) throw new Error("Anthropic OAuth URL missing callback parameters");
    const browserRedirect = fetch(`${redirectUri}?code=anthropic-code-1&state=${state}`, { redirect: "manual" });
    const status = await waitForOAuthCompletion(oauth, started.loginId, {
      organizationId: "org_oauth_anthropic_browser",
      actorUserId: "local-user"
    });
    const browserResponse = await browserRedirect;

    expect(browserResponse.status).toBe(302);
    expect(browserResponse.headers.get("location")).toBe("https://platform.claude.com/oauth/code/success?app=claude-code");
    expect(status.status).toBe("completed");
    expect(status.providerAccountId).toBeTruthy();

    const [row] = await fixture.db
      .select({
        secretCiphertext: providerAccounts.secretCiphertext,
        settings: providerAccounts.settings
      })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, status.providerAccountId));
    expect(decryptSecret(row!.secretCiphertext ?? "", ENCRYPTION_KEY)).toBe(OAUTH_TOKEN);
    expect(row!.settings).toEqual({ tokenKind: "claude_oauth", source: "claude-browser-oauth" });
  });

  it("starts and cancels Anthropic browser OAuth through GraphQL", async () => {
    const fixture = await setup("org_oauth_anthropic_graphql", { SUBSCRIPTION_OAUTH_ENABLED: "true" });

    const started = await gql(fixture, START_OAUTH, {
      input: { provider: "anthropic", name: "GraphQL Claude auth" }
    });
    expect(started.errors).toBeUndefined();
    expect(started.data?.startProviderCredentialOAuth.userCode).toBeNull();
    expect(started.data?.startProviderCredentialOAuth.verificationUrl).toContain("https://claude.com/cai/oauth/authorize");

    const cancelled = await gql(fixture, CANCEL_OAUTH, {
      loginId: started.data?.startProviderCredentialOAuth.loginId
    });
    expect(cancelled.errors).toBeUndefined();
    expect(cancelled.data?.cancelProviderCredentialOAuth.status).toBe("failed");
    expect(cancelled.data?.cancelProviderCredentialOAuth.error).toBe("Claude sign-in cancelled.");
  });

  it("rejects Anthropic browser OAuth when subscription auth is disabled", async () => {
    const fixture = await setup("org_oauth_anthropic_graphql_disabled", { SUBSCRIPTION_OAUTH_ENABLED: "false" });

    const started = await gql(fixture, START_OAUTH, {
      input: { provider: "anthropic", name: "Disabled Claude auth" }
    });
    expect(started.errors?.[0]?.message).toBe("subscription_oauth_disabled");
  });

  it("cancels pending OpenAI device-code auth without creating a credential", async () => {
    const fixture = await setup("org_oauth_openai_device_cancel", { SUBSCRIPTION_OAUTH_ENABLED: "false" });
    let resolveTokenPoll: (response: Response) => void = () => {};
    const tokenPoll = new Promise<Response>((resolve) => {
      resolveTokenPoll = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return jsonResponse({
          device_auth_id: "device-auth-cancel",
          user_code: "CANCEL-1",
          interval: "1"
        });
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) return tokenPoll;
      if (url.endsWith("/oauth/token")) {
        return jsonResponse({
          access_token: OPENAI_OAUTH_TOKEN,
          refresh_token: "openai-refresh-token",
          expires_in: 3600,
          id_token: fakeJwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: CHATGPT_ACCOUNT_ID
            }
          })
        });
      }
      return new Response("not found", { status: 404 });
    });
    const oauth = new ProviderCredentialOAuthService(
      fixture.persistence.providerCredentialAdmin,
      fetchMock as unknown as typeof fetch
    );
    const scope = {
      organizationId: "org_oauth_openai_device_cancel",
      actorUserId: "local-user"
    };

    const started = await oauth.startOpenAICodexDeviceAuth({
      ...scope,
      name: "Cancelled Codex auth"
    });
    const cancelled = oauth.cancel(started.loginId, scope);
    resolveTokenPoll(jsonResponse({
      authorization_code: "authorization-code-cancel",
      code_verifier: "code-verifier-cancel"
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cancelled).toMatchObject({
      loginId: started.loginId,
      status: "failed",
      error: "OpenAI sign-in cancelled."
    });
    expect(oauth.status(started.loginId, scope)).toMatchObject({
      status: "failed",
      error: "OpenAI sign-in cancelled."
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/oauth/token"))).toBe(false);
    const rows = await fixture.db
      .select({ name: providerAccounts.name })
      .from(providerAccounts)
      .where(eq(providerAccounts.organizationId, "org_oauth_openai_device_cancel"));
    expect(rows.some((row) => row.name === "Cancelled Codex auth")).toBe(false);
  });

  it("rejects OpenAI oauth credentials without a ChatGPT account ID", async () => {
    const fixture = await setup("org_oauth_openai_account", { SUBSCRIPTION_OAUTH_ENABLED: "true" });

    const created = await gql(fixture, CREATE, {
      input: { provider: "openai", name: "My ChatGPT sub", authType: "oauth", apiKey: OPENAI_OAUTH_TOKEN }
    });
    expect(created.errors?.[0]?.message).toBe("invalid_subscription_account_id");
  });

  it("binds an oauth credential to a key owned by the credential creator", async () => {
    const fixture = await setup("org_oauth_bind_same", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createOauthCredential(fixture);

    const bound = await gql(fixture, BIND, {
      apiKeyId: "org_oauth_bind_same:api-key:default",
      provider: "anthropic",
      providerAccountId: accountId
    });
    expect(bound.errors).toBeUndefined();
    expect(bound.data?.assignApiKeyProviderAccount.providerCredentials).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "anthropic", providerAccountId: accountId })
    ]));
  });

  it("rejects binding an oauth credential to another user's key", async () => {
    const fixture = await setup("org_oauth_bind_other", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createOauthCredential(fixture);
    await insertKey(fixture, "org_oauth_bind_other", "other-key", "other-user");

    const bound = await gql(fixture, BIND, {
      apiKeyId: "other-key",
      provider: "anthropic",
      providerAccountId: accountId
    });
    expect(bound.errors?.[0]?.message).toBe("provider_credential_owner_mismatch");
  });

  it("rejects binding an oauth credential to an ownerless key", async () => {
    const fixture = await setup("org_oauth_bind_null", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createOauthCredential(fixture);
    await insertKey(fixture, "org_oauth_bind_null", "shared-key", null);

    const bound = await gql(fixture, BIND, {
      apiKeyId: "shared-key",
      provider: "anthropic",
      providerAccountId: accountId
    });
    expect(bound.errors?.[0]?.message).toBe("provider_credential_owner_mismatch");
  });

  it("rejects binding an oauth credential whose creator was deleted", async () => {
    const fixture = await setup("org_oauth_bind_orphan", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createOauthCredential(fixture);
    await fixture.db
      .update(providerAccounts)
      .set({ createdByUserId: null })
      .where(eq(providerAccounts.id, accountId));

    const bound = await gql(fixture, BIND, {
      apiKeyId: "org_oauth_bind_orphan:api-key:default",
      provider: "anthropic",
      providerAccountId: accountId
    });
    expect(bound.errors?.[0]?.message).toBe("provider_credential_owner_mismatch");
  });

  it("rejects rebinding an existing binding to an oauth credential the key owner does not own", async () => {
    const fixture = await setup("org_oauth_rebind", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    await insertKey(fixture, "org_oauth_rebind", "other-key", "other-user");
    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Shared key", apiKey: CUSTOMER_KEY }
    });
    const apiCredentialId = created.data?.createProviderCredential.id;
    const first = await gql(fixture, BIND, {
      apiKeyId: "other-key",
      provider: "anthropic",
      providerAccountId: apiCredentialId
    });
    expect(first.errors).toBeUndefined();

    const oauthAccountId = await createOauthCredential(fixture);
    const rebound = await gql(fixture, BIND, {
      apiKeyId: "other-key",
      provider: "anthropic",
      providerAccountId: oauthAccountId
    });
    expect(rebound.errors?.[0]?.message).toBe("provider_credential_owner_mismatch");
  });

  it("still binds api_key credentials to another user's key", async () => {
    const fixture = await setup("org_apikey_bind_other", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Shared key", apiKey: CUSTOMER_KEY }
    });
    const accountId = created.data?.createProviderCredential.id;
    await insertKey(fixture, "org_apikey_bind_other", "other-key", "other-user");

    const bound = await gql(fixture, BIND, {
      apiKeyId: "other-key",
      provider: "anthropic",
      providerAccountId: accountId
    });
    expect(bound.errors).toBeUndefined();
  });

  it("defaults to api_key when authType is omitted, with the flag on", async () => {
    const fixture = await setup("org_oauth_default", { SUBSCRIPTION_OAUTH_ENABLED: "true" });

    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Plain key", apiKey: CUSTOMER_KEY }
    });
    expect(created.errors).toBeUndefined();
    expect(created.data?.createProviderCredential.authType).toBe("api_key");
  });

  it("resolves an oauth credential with authType oauth when the flag is on", async () => {
    const fixture = await setup("org_oauth_resolve", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createBoundOauthCredential(fixture, "org_oauth_resolve");

    const credential = await fixture.persistence.providerCredentials.resolveForRequest({
      organizationId: "org_oauth_resolve",
      apiKeyId: "org_oauth_resolve:api-key:default",
      provider: "anthropic"
    });
    expect(credential).toMatchObject({
      provider: "anthropic",
      authType: "oauth",
      token: OAUTH_TOKEN,
      providerAccountId: accountId
    });
  });

  it("resolves an OpenAI oauth credential with the ChatGPT account ID", async () => {
    const fixture = await setup("org_oauth_openai_resolve", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createBoundOpenAIOauthCredential(fixture, "org_oauth_openai_resolve");

    const credential = await fixture.persistence.providerCredentials.resolveForRequest({
      organizationId: "org_oauth_openai_resolve",
      apiKeyId: "org_oauth_openai_resolve:api-key:default",
      provider: "openai"
    });
    expect(credential).toMatchObject({
      provider: "openai",
      authType: "oauth",
      token: OPENAI_OAUTH_TOKEN,
      providerAccountId: accountId,
      chatgptAccountId: CHATGPT_ACCOUNT_ID
    });
  });

  it("refreshes encrypted OpenAI oauth token bundles when resolving credentials", async () => {
    const fixture = await setup("org_oauth_openai_refresh", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = "org_oauth_openai_refresh:oauth-account";
    await fixture.db.insert(providerAccounts).values({
      id: accountId,
      organizationId: "org_oauth_openai_refresh",
      providerId: OPENAI_PROVIDER_ID,
      name: "My ChatGPT sub",
      authType: "oauth",
      secretCiphertext: encryptSecret(stringifyOpenAIChatGPTTokenBundle(openAIChatGPTTokenBundle({
        accessToken: "expired-openai-token",
        refreshToken: "openai-refresh-token",
        expiresAt: 1
      })), ENCRYPTION_KEY),
      secretHint: "••••oken",
      createdByUserId: "local-user",
      status: "active",
      settings: {
        tokenKind: "openai_chatgpt",
        source: "codex-auth-json",
        tokenStorage: "token_bundle",
        chatgptAccountId: CHATGPT_ACCOUNT_ID
      }
    });
    await fixture.db.insert(apiKeyProviderAccounts).values({
      organizationId: "org_oauth_openai_refresh",
      workspaceId: defaultWorkspaceId("org_oauth_openai_refresh"),
      apiKeyId: "org_oauth_openai_refresh:api-key:default",
      providerId: OPENAI_PROVIDER_ID,
      providerAccountId: accountId,
      createdByUserId: "local-user"
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: "refreshed-openai-token",
      refresh_token: "openai-refresh-token-2",
      expires_in: 3600
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const credentialStore = new ProviderCredentialStore(fixture.db, {
      encryptionKey: ENCRYPTION_KEY,
      subscriptionOAuthEnabled: true,
      allowedPrivateUpstreamCidrs: [],
      fetcher: fetchMock as unknown as typeof fetch
    });

    const credential = await credentialStore.resolveForRequest({
      organizationId: "org_oauth_openai_refresh",
      apiKeyId: "org_oauth_openai_refresh:api-key:default",
      provider: "openai"
    });
    expect(credential).toMatchObject({
      provider: "openai",
      authType: "oauth",
      token: "refreshed-openai-token",
      providerAccountId: accountId,
      chatgptAccountId: CHATGPT_ACCOUNT_ID
    });

    const [row] = await fixture.db
      .select({ secretCiphertext: providerAccounts.secretCiphertext })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    const secret = parseOpenAIChatGPTSecret(decryptSecret(row!.secretCiphertext ?? "", ENCRYPTION_KEY));
    expect(secret.kind).toBe("token_bundle");
    expect(secret.kind === "token_bundle" ? secret.bundle.accessToken : null).toBe("refreshed-openai-token");
    expect(secret.kind === "token_bundle" ? secret.bundle.refreshToken : null).toBe("openai-refresh-token-2");
  });

  it("uses an unexpired OpenAI oauth token when proactive refresh fails", async () => {
    const fixture = await setup("org_oauth_openai_refresh_soft_fail", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const now = Date.now();
    const accountId = "org_oauth_openai_refresh_soft_fail:oauth-account";
    await fixture.db.insert(providerAccounts).values({
      id: accountId,
      organizationId: "org_oauth_openai_refresh_soft_fail",
      providerId: OPENAI_PROVIDER_ID,
      name: "My ChatGPT sub",
      authType: "oauth",
      secretCiphertext: encryptSecret(stringifyOpenAIChatGPTTokenBundle(openAIChatGPTTokenBundle({
        accessToken: "still-valid-openai-token",
        refreshToken: "openai-refresh-token",
        expiresAt: now + 30_000
      })), ENCRYPTION_KEY),
      secretHint: "••••oken",
      createdByUserId: "local-user",
      status: "active",
      settings: {
        tokenKind: "openai_chatgpt",
        source: "codex-auth-json",
        tokenStorage: "token_bundle",
        chatgptAccountId: CHATGPT_ACCOUNT_ID
      }
    });
    await fixture.db.insert(apiKeyProviderAccounts).values({
      organizationId: "org_oauth_openai_refresh_soft_fail",
      workspaceId: defaultWorkspaceId("org_oauth_openai_refresh_soft_fail"),
      apiKeyId: "org_oauth_openai_refresh_soft_fail:api-key:default",
      providerId: OPENAI_PROVIDER_ID,
      providerAccountId: accountId,
      createdByUserId: "local-user"
    });
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const credentialStore = new ProviderCredentialStore(fixture.db, {
      encryptionKey: ENCRYPTION_KEY,
      subscriptionOAuthEnabled: true,
      allowedPrivateUpstreamCidrs: [],
      fetcher: fetchMock as unknown as typeof fetch
    });

    const credential = await credentialStore.resolveForRequest({
      organizationId: "org_oauth_openai_refresh_soft_fail",
      apiKeyId: "org_oauth_openai_refresh_soft_fail:api-key:default",
      provider: "openai"
    }, now);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(credential?.token).toBe("still-valid-openai-token");
  });

  it("resolves Anthropic oauth accounts to undefined when the flag is off", async () => {
    const fixture = await setup("org_oauth_resolve_off", { SUBSCRIPTION_OAUTH_ENABLED: "false" });
    await insertBoundOauthAccount(fixture, "org_oauth_resolve_off", encryptSecret(OAUTH_TOKEN, ENCRYPTION_KEY));

    const credential = await fixture.persistence.providerCredentials.resolveForRequest({
      organizationId: "org_oauth_resolve_off",
      apiKeyId: "org_oauth_resolve_off:api-key:default",
      provider: "anthropic"
    });
    expect(credential).toBeUndefined();
  });

  it("resolves OpenAI oauth credentials when the flag is off", async () => {
    const fixture = await setup("org_oauth_openai_resolve_off", { SUBSCRIPTION_OAUTH_ENABLED: "false" });
    const accountId = await createBoundOpenAIOauthCredential(fixture, "org_oauth_openai_resolve_off");

    const credential = await fixture.persistence.providerCredentials.resolveForRequest({
      organizationId: "org_oauth_openai_resolve_off",
      apiKeyId: "org_oauth_openai_resolve_off:api-key:default",
      provider: "openai"
    });
    expect(credential).toMatchObject({
      provider: "openai",
      authType: "oauth",
      token: OPENAI_OAUTH_TOKEN,
      providerAccountId: accountId,
      chatgptAccountId: CHATGPT_ACCOUNT_ID
    });
  });

  it("resolves an oauth account with null ciphertext to undefined", async () => {
    const fixture = await setup("org_oauth_resolve_null", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    await insertBoundOauthAccount(fixture, "org_oauth_resolve_null", null);

    const credential = await fixture.persistence.providerCredentials.resolveForRequest({
      organizationId: "org_oauth_resolve_null",
      apiKeyId: "org_oauth_resolve_null:api-key:default",
      provider: "anthropic"
    });
    expect(credential).toBeUndefined();
  });

  it("resolves api_key credentials with authType api_key", async () => {
    const fixture = await setup("org_apikey_resolve");
    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Acme key", apiKey: CUSTOMER_KEY }
    });
    const accountId = created.data?.createProviderCredential.id;
    await gql(fixture, BIND, {
      apiKeyId: "org_apikey_resolve:api-key:default",
      provider: "anthropic",
      providerAccountId: accountId
    });

    const credential = await fixture.persistence.providerCredentials.resolveForRequest({
      organizationId: "org_apikey_resolve",
      apiKeyId: "org_apikey_resolve:api-key:default",
      provider: "anthropic"
    });
    expect(credential).toMatchObject({ authType: "api_key", token: CUSTOMER_KEY });
  });

  it("forwards an oauth credential as a bearer token, never x-api-key", async () => {
    const fixture = await setup("org_oauth_forward", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    await createBoundOauthCredential(fixture, "org_oauth_forward");

    const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20"
      },
      body: messageBody
    });
    expect(response.status).toBe(200);
    await response.text();

    const providerCall = fixture.anthropic.records.find((record) => record.path === "/messages");
    expect(providerCall?.headers.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(providerCall?.headers["x-api-key"]).toBeUndefined();
    expect(providerCall?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(providerCall?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("stops forwarding a cached Anthropic oauth credential the moment the flag is off", async () => {
    const fixture = await setup("org_oauth_killswitch", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    await createBoundOauthCredential(fixture, "org_oauth_killswitch");

    await sendMessage(fixture);
    expect(fixture.anthropic.records.at(-1)?.headers.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);

    // The first request cached the decrypted credential for 30s; flipping the
    // running server's flag must still cut it off at forward time.
    fixture.config.subscriptionOAuthEnabled = false;
    await sendMessage(fixture);

    const providerCall = fixture.anthropic.records.at(-1);
    expect(providerCall?.headers["x-api-key"]).toBe("anthropic-upstream-key");
    expect(providerCall?.headers.authorization).toBeUndefined();
  });

  it("forwards count_tokens with the bearer token when oauth is bound", async () => {
    const fixture = await setup("org_oauth_count", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    await createBoundOauthCredential(fixture, "org_oauth_count");

    const response = await fetch(`${fixture.proxyUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "x-api-key": "proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-router-auto",
        messages: [{ role: "user", content: "debug auth" }]
      })
    });
    expect(response.status).toBe(200);

    const providerCall = fixture.anthropic.records.find((record) => record.path === "/messages/count_tokens");
    expect(providerCall?.headers.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(providerCall?.headers["x-api-key"]).toBeUndefined();
    expect(providerCall?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("forwards OpenAI oauth credentials to the Codex backend with a ChatGPT account header", async () => {
    const fixture = await setup("org_oauth_openai_forward", { SUBSCRIPTION_OAUTH_ENABLED: "true" }, {
      openAIChatGPTOptions: {}
    });
    await createBoundOpenAIOauthCredential(fixture, "org_oauth_openai_forward");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "x-api-key": "proxy-token",
        "content-type": "application/json",
        "x-codex-turn-state": "turn-state"
      },
      body: openAIResponseBody
    });
    expect(response.status).toBe(200);
    await response.text();

    const defaultProviderCall = fixture.openai.records.find((record) => record.body.model === "gpt-5.5");
    const providerCall = fixture.openaiChatgpt.records.find((record) => record.body.model === "gpt-5.5");
    expect(defaultProviderCall).toBeUndefined();
    expect(providerCall?.headers.authorization).toBe(`Bearer ${OPENAI_OAUTH_TOKEN}`);
    expect(providerCall?.headers["chatgpt-account-id"]).toBe(CHATGPT_ACCOUNT_ID);
    expect(providerCall?.headers["x-codex-turn-state"]).toBe("turn-state");
    expect(providerCall?.body.prompt_cache_retention).toBeUndefined();
    const forwarded = (await fixture.db.select().from(events))
      .find((event) => event.eventType === "provider.request_forwarded");
    expect(forwarded?.payload.forwardedRequestHash).toBe(requestBodyHash(providerCall?.body));
  });

  it("keeps forwarding a cached OpenAI oauth credential when the flag is off", async () => {
    const fixture = await setup("org_oauth_openai_killswitch", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    await createBoundOpenAIOauthCredential(fixture, "org_oauth_openai_killswitch");

    await sendOpenAIResponse(fixture);
    expect(fixture.openai.records.find((record) => record.body.model === "gpt-5.5")?.headers.authorization).toBe(`Bearer ${OPENAI_OAUTH_TOKEN}`);

    fixture.config.subscriptionOAuthEnabled = false;
    await sendOpenAIResponse(fixture);

    const providerCalls = fixture.openai.records.filter((record) => record.body.model === "gpt-5.5");
    const providerCall = providerCalls.at(-1);
    expect(providerCall?.headers.authorization).toBe(`Bearer ${OPENAI_OAUTH_TOKEN}`);
    expect(providerCall?.headers["chatgpt-account-id"]).toBe(CHATGPT_ACCOUNT_ID);
  });

  it("serves cached oauth credentials within the TTL without re-reading the row", async () => {
    const fixture = await setup("org_oauth_cache", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createBoundOauthCredential(fixture, "org_oauth_cache");

    const resolveInput = {
      organizationId: "org_oauth_cache",
      apiKeyId: "org_oauth_cache:api-key:default",
      provider: "anthropic"
    } as const;
    const first = await fixture.persistence.providerCredentials.resolveForRequest(resolveInput);
    expect(first?.authType).toBe("oauth");

    // A fresh read would reject the now-disabled row, so a credential here can
    // only come from the cache. SA-006's forward-time flag re-check exists
    // because of this window.
    await fixture.db
      .update(providerAccounts)
      .set({ status: "disabled" })
      .where(eq(providerAccounts.id, accountId));
    const second = await fixture.persistence.providerCredentials.resolveForRequest(resolveInput);
    expect(second?.providerAccountId).toBe(accountId);
  });

  it("does not reuse a cached credential for a different provider", async () => {
    const fixture = await setup("org_oauth_cache_provider", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createBoundOauthCredential(fixture, "org_oauth_cache_provider");

    const anthropic = await fixture.persistence.providerCredentials.resolveAccount({
      organizationId: "org_oauth_cache_provider",
      provider: "anthropic",
      providerAccountId: accountId
    });
    const openai = await fixture.persistence.providerCredentials.resolveAccount({
      organizationId: "org_oauth_cache_provider",
      provider: "openai",
      providerAccountId: accountId
    });

    expect(anthropic?.providerAccountId).toBe(accountId);
    expect(openai).toBeUndefined();
  });

  it("serves cached provider bindings until the binding TTL expires", async () => {
    const fixture = await setup("org_oauth_binding_cache", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createBoundOauthCredential(fixture, "org_oauth_binding_cache");
    const now = Date.now();

    const resolveInput = {
      organizationId: "org_oauth_binding_cache",
      apiKeyId: "org_oauth_binding_cache:api-key:default",
      provider: "anthropic"
    } as const;
    const first = await fixture.persistence.providerCredentials.resolveForRequest(resolveInput, now);
    expect(first?.providerAccountId).toBe(accountId);

    await fixture.db
      .delete(apiKeyProviderAccounts)
      .where(eq(apiKeyProviderAccounts.apiKeyId, "org_oauth_binding_cache:api-key:default"));
    const cachedBinding = await fixture.persistence.providerCredentials.resolveForRequest(resolveInput, now + 1_000);
    const afterExpiry = await fixture.persistence.providerCredentials.resolveForRequest(resolveInput, now + 6_000);

    expect(cachedBinding?.providerAccountId).toBe(accountId);
    expect(afterExpiry).toBeUndefined();
  });

  it("re-resolves an oauth account to undefined once the cache expires with the flag off", async () => {
    const fixture = await setup("org_oauth_expiry", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    await createBoundOauthCredential(fixture, "org_oauth_expiry");

    const resolveInput = {
      organizationId: "org_oauth_expiry",
      apiKeyId: "org_oauth_expiry:api-key:default",
      provider: "anthropic"
    } as const;
    const first = await fixture.persistence.providerCredentials.resolveForRequest(resolveInput);
    expect(first?.authType).toBe("oauth");

    fixture.config.subscriptionOAuthEnabled = false;
    const afterExpiry = await fixture.persistence.providerCredentials.resolveForRequest(
      resolveInput,
      Date.now() + 31_000
    );
    expect(afterExpiry).toBeUndefined();
  });

  async function setup(
    organizationId: string,
    envOverrides: Record<string, string> = {},
    options: Pick<NonNullable<Parameters<typeof captureFixture>[3]>, "openAIChatGPTOptions"> = {}
  ) {
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      ...options,
      envOverrides: { PROVIDER_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY, ...envOverrides }
    });
    return activeFixture;
  }

  async function createOauthCredential(fixture: PromptTestFixture) {
    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "My Max sub", authType: "oauth", apiKey: OAUTH_TOKEN }
    });
    expect(created.errors).toBeUndefined();
    return created.data?.createProviderCredential.id as string;
  }

  async function createBoundOauthCredential(fixture: PromptTestFixture, organizationId: string) {
    const accountId = await createOauthCredential(fixture);
    const bound = await gql(fixture, BIND, {
      apiKeyId: `${organizationId}:api-key:default`,
      provider: "anthropic",
      providerAccountId: accountId
    });
    expect(bound.errors).toBeUndefined();
    return accountId;
  }

  async function createBoundOpenAIOauthCredential(fixture: PromptTestFixture, organizationId: string) {
    const created = await gql(fixture, CREATE, {
      input: {
        provider: "openai",
        name: "My ChatGPT sub",
        authType: "oauth",
        apiKey: OPENAI_OAUTH_TOKEN,
        chatgptAccountId: CHATGPT_ACCOUNT_ID
      }
    });
    expect(created.errors).toBeUndefined();
    const accountId = created.data?.createProviderCredential.id as string;
    const bound = await gql(fixture, BIND, {
      apiKeyId: `${organizationId}:api-key:default`,
      provider: "openai",
      providerAccountId: accountId
    });
    expect(bound.errors).toBeUndefined();
    return accountId;
  }

  // Simulates rows created while the flag was on (create+bind are flag-gated,
  // so a flag-off fixture cannot mint them through the admin API).
  async function insertBoundOauthAccount(
    fixture: PromptTestFixture,
    organizationId: string,
    ciphertext: string | null
  ) {
    const accountId = `${organizationId}:oauth-account`;
    await fixture.db.insert(providerAccounts).values({
      id: accountId,
      organizationId,
      providerId: ANTHROPIC_PROVIDER_ID,
      name: "Pasted subscription",
      authType: "oauth",
      secretCiphertext: ciphertext,
      secretHint: "••••oken",
      createdByUserId: "local-user",
      status: "active"
    });
    await fixture.db.insert(apiKeyProviderAccounts).values({
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      apiKeyId: `${organizationId}:api-key:default`,
      providerId: ANTHROPIC_PROVIDER_ID,
      providerAccountId: accountId,
      createdByUserId: "local-user"
    });
    return accountId;
  }

  // Direct inserts: the admin API cannot mint keys for other users. These
  // minimal rows only feed the bind guardrail, which reads id + userId.
  async function insertKey(
    fixture: PromptTestFixture,
    organizationId: string,
    apiKeyId: string,
    userId: string | null
  ) {
    if (userId) {
      await fixture.db.insert(users).values({
        id: userId,
        email: `${userId}@example.com`,
        name: userId
      });
    }
    await fixture.db.insert(apiKeys).values({
      id: apiKeyId,
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      userId,
      keyHash: `hash-${apiKeyId}`,
      name: apiKeyId
    });
  }
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function gql(fixture: PromptTestFixture, query: string, variables?: Record<string, unknown>) {
  return adminGql(fixture.proxyUrl, fixture.adminHeaders, query, variables);
}

async function waitForOAuthCompletion(
  service: ProviderCredentialOAuthService,
  loginId: string | undefined,
  scope?: { organizationId: string; actorUserId: string }
) {
  expect(loginId).toBeTruthy();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = service.status(loginId ?? "", scope);
    if (status && status.status !== "pending") return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("OAuth flow did not finish");
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function fakeJwt(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

async function sendMessage(fixture: PromptTestFixture) {
  const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": "proxy-token",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01"
    },
    body: messageBody
  });
  expect(response.status).toBe(200);
  await response.text();
}

async function sendOpenAIResponse(fixture: PromptTestFixture) {
  const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "x-api-key": "proxy-token",
      "content-type": "application/json"
    },
    body: openAIResponseBody
  });
  expect(response.status).toBe(200);
  await response.text();
}
