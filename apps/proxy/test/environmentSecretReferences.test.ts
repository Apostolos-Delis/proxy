import type { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createEnvironmentSecretReferenceResolver } from "../src/persistence/environmentSecretReferences.js";
import { parseGatewayConfigDocument } from "../src/persistence/gatewayConfigDocument.js";
import { planGatewayConfig } from "../src/persistence/gatewayConfigPlan.js";
import { createDatabasePersistence } from "../src/persistence/index.js";
import { setupGatewayConfig } from "./gatewayConfigTestSupport.js";

describe("environment secret references", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    const current = client;
    client = undefined;
    await current?.close();
  });

  it("binds built-in keys to configured origins without coupling them to resource slugs", () => {
    const resolve = createEnvironmentSecretReferenceResolver({
      openaiApiKey: "openai-secret",
      openaiBaseUrl: "https://api.openai.com/v1"
    }, {});

    expect(resolve({
      reference: "env:OPENAI_API_KEY",
      provider: "openai-production",
      baseUrl: "https://api.openai.com/v1/responses"
    })).toBe("openai-secret");
    expect(resolve({
      reference: "env:OPENAI_API_KEY",
      provider: "openai-production",
      baseUrl: "https://attacker.example/v1"
    })).toBeUndefined();
  });

  it("requires explicit origin allowlists for custom environment keys", () => {
    const resolve = createEnvironmentSecretReferenceResolver({}, {
      ACME_GATEWAY_KEY: "acme-secret",
      ACME_GATEWAY_KEY_ALLOWED_ORIGINS: "https://api.acme.example, https://backup.acme.example/v1"
    });

    expect(resolve({
      reference: "env:ACME_GATEWAY_KEY",
      provider: "acme-production",
      baseUrl: "https://backup.acme.example/v2"
    })).toBe("acme-secret");
    expect(resolve({
      reference: "env:ACME_GATEWAY_KEY",
      provider: "acme-production",
      baseUrl: "https://api.acme.example.attacker.test"
    })).toBeUndefined();
    expect(resolve({
      reference: "vault://tenant/acme",
      provider: "acme-production",
      baseUrl: "https://api.acme.example"
    })).toBeUndefined();
  });

  it("uses the origin-bound resolver in production persistence construction", async () => {
    const fixture = await setupGatewayConfig("org_environment_reference");
    client = fixture.client;
    const config = loadConfig({
      NODE_ENV: "test",
      DEFAULT_ORGANIZATION_ID: fixture.actor.organizationId,
      OPENAI_API_KEY: "openai-secret",
      OPENAI_BASE_URL: "http://10.1.2.3:8000/v1",
      ALLOWED_PRIVATE_UPSTREAM_CIDRS: "10.0.0.0/8"
    });
    const persistence = createDatabasePersistence(fixture.db, config, false);
    const document = parseGatewayConfigDocument(`
version = 1
[scope]
organization_id = "${fixture.actor.organizationId}"
workspace_id = "${fixture.actor.workspaceId}"
[[provider_connections]]
provider = "openai"
slug = "openai-production"
name = "OpenAI Production"
adapter_kind = "generic-http-json"
auth_style = "bearer"
base_url = "http://10.1.2.3:8000/v1"
secret_ref = "env:OPENAI_API_KEY"
enabled = true
`);

    await expect(planGatewayConfig(persistence.gatewayConfigAdmin, document)).resolves.toMatchObject({
      changes: [{ action: "create", resource: "providerConnection", reference: "openai-production" }]
    });
  });
});
