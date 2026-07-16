import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { EventService } from "../src/events.js";
import type { ProviderRegistryEntry } from "../src/persistence/providers.js";
import { GenericHttpProviderAdapter } from "../src/providerAdapters/genericHttp.js";
import type { ProviderForwardInput } from "../src/providerAdapters/types.js";
import { startOpenAIMock } from "./helpers.js";
import { testEnv } from "./promptTestFixture.js";

describe("provider event scoping", () => {
  it("preserves an explicit non-default tenant after request scope eviction", async () => {
    const upstream = await startOpenAIMock({ responsesJsonProvider: true });
    try {
      const events = new EventService(
        undefined,
        undefined,
        undefined,
        "org_default",
        undefined,
        { scopeLimit: 1 }
      );
      await events.append({
        tenantId: "org_target",
        workspaceId: "workspace_target",
        scopeType: "request",
        scopeId: "request_target",
        producer: "test",
        eventType: "test.request_started"
      });
      await events.append({
        tenantId: "org_other",
        workspaceId: "workspace_other",
        scopeType: "request",
        scopeId: "request_evicting",
        producer: "test",
        eventType: "test.request_started"
      });

      const endpoint = { dialect: "openai-responses", path: "/responses" } as const;
      const provider: ProviderRegistryEntry = {
        id: "connection_target",
        organizationId: "org_target",
        provider: "openai",
        slug: "openai",
        baseUrl: upstream.url,
        adapterKind: "generic-http-json",
        adapterConfig: {},
        authStyle: "none",
        endpoints: [endpoint],
        defaultHeaders: {},
        capabilities: {},
        forwardHarnessHeaders: false,
        enabled: true,
        builtin: false
      };
      const adapter = new GenericHttpProviderAdapter(loadConfig(testEnv()), events);
      const input: ProviderForwardInput = {
        requestId: "request_target",
        idempotencyKey: "idem_target",
        organizationId: "org_target",
        workspaceId: "workspace_target",
        surface: "openai-responses",
        target: {
          resolution: {
            outcome: "resolved",
            accessProfileId: "profile_target",
            logicalModelId: "logical_model_target",
            logicalModelSlug: "logical-test",
            routerKind: null,
            deploymentId: "deployment_target",
            upstreamModelId: "gpt-test",
            providerConnectionId: provider.id,
            bindingId: "binding_target",
            egressWireId: "openai-responses",
            endpointPath: endpoint.path,
            providerAdapterKind: provider.adapterKind,
            providerAdapterContractVersion: "1",
            wireAdapterId: null,
            wireAdapterVersion: null,
            routerDecisionId: null,
            routerDecision: null,
            parameterCaps: {}
          },
          provider: provider.slug,
          upstreamModelId: "gpt-test",
          deploymentId: "deployment_target",
          providerConnectionId: provider.id,
          requestConfig: {},
          deploymentConfig: {},
          capabilities: {},
          providerEntry: provider,
          endpoint
        },
        body: { model: "gpt-test", input: "scope this request" },
        headers: {},
        reply: {} as never
      };

      const response = await adapter.fetchWithRateLimitRetries({
        input,
        providerAttemptId: "attempt_target",
        provider,
        endpoint,
        signal: new AbortController().signal
      });
      await response.text();

      expect(events.listEvents().find((event) => event.eventType === "provider.request_forwarded"))
        .toEqual(expect.objectContaining({
          tenantId: "org_target",
          workspaceId: "workspace_target",
          scopeId: "request_target"
        }));
    } finally {
      await upstream.close();
    }
  });
});
