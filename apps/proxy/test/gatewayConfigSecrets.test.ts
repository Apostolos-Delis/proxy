import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { events, providerConnections } from "@proxy/db";
import { parseGatewayConfigDocument } from "../src/persistence/gatewayConfigDocument.js";
import { applyGatewayConfig } from "../src/persistence/gatewayConfigPlan.js";
import {
  createGatewayConfig as create,
  setupGatewayConfig as setup,
  updateGatewayConfig as update
} from "./gatewayConfigTestSupport.js";

const providerBaseUrl = "http://10.1.2.3:8000/v1";

describe("gateway configuration secret boundaries", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
  });

  it("rejects credentials and unsafe values in transport fields", async () => {
    const fixture = await setup("org_gateway_transport_secrets");
    client = fixture.client;
    const providerCases: Array<{
      slug: string;
      body: Record<string, unknown>;
      error: string;
    }> = [
      {
        slug: "url-secret",
        body: { baseUrl: "http://user:sk-secret@10.1.2.3:8000/v1" },
        error: "provider_base_url_credentials_forbidden"
      },
      {
        slug: "query-secret",
        body: { baseUrl: `${providerBaseUrl}?api_key=sk-secret` },
        error: "provider_base_url_credentials_forbidden"
      },
      {
        slug: "api-key-header",
        body: { defaultHeaders: { "api-key": "sk-secret" } },
        error: "provider_default_header_forbidden"
      },
      {
        slug: "auth-header",
        body: { defaultHeaders: { "x-auth": "sk-auth-header-leak" } },
        error: "provider_default_header_forbidden"
      },
      {
        slug: "authentication-header",
        body: { defaultHeaders: { "x-authentication": "sk-authentication-header-leak" } },
        error: "provider_default_header_forbidden"
      },
      {
        slug: "auth-token-header",
        body: { defaultHeaders: { "x-auth-token": "sk-header-token-leak" } },
        error: "provider_default_header_forbidden"
      },
      {
        slug: "auth-key-header",
        body: { defaultHeaders: { "x-auth-key": "sk-header-auth-key-leak" } },
        error: "provider_default_header_forbidden"
      },
      {
        slug: "api-token-header",
        body: { defaultHeaders: { "x-api-token": "sk-header-api-token-leak" } },
        error: "provider_default_header_forbidden"
      },
      {
        slug: "reserved-header",
        body: { defaultHeaders: { "transfer-encoding": "chunked" } },
        error: "provider_default_header_forbidden"
      },
      {
        slug: "invalid-header-name",
        body: { defaultHeaders: { "bad header": "value" } },
        error: "provider_default_header_invalid"
      },
      {
        slug: "invalid-header-value",
        body: { defaultHeaders: { "x-region": "iad\r\nx-evil: value" } },
        error: "provider_default_header_invalid"
      }
    ];

    for (const testCase of providerCases) {
      await expect(create(fixture, "providerConnection", providerInput(testCase.slug, testCase.body)))
        .rejects.toThrow(testCase.error);
    }

    const workspaceId = fixture.actor.workspaceId;
    const deploymentId = await create(fixture, "modelDeployment", {
      slug: "transport-endpoint-deployment",
      name: "Transport Endpoint Deployment",
      canonicalModelId: `${workspaceId}:canonical:openai:gpt-5.4-mini`,
      providerConnectionId: `${workspaceId}:connection:openai`,
      upstreamModelId: "transport-endpoint-deployment"
    });
    for (const endpointPath of [
      "/responses?api_key=sk-wire-endpoint-leak",
      "//other-origin.example/responses",
      "/\\other-origin.example/responses"
    ]) {
      await expect(create(fixture, "wireBinding", {
        deploymentId,
        apiWireId: "openai-responses",
        endpointPath
      })).rejects.toThrow("wire_binding_endpoint_invalid");
    }
    expect(await fixture.service.wireBindings(fixture.actor)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ deploymentId })
    ]));
  });

  it("rejects credential aliases in arbitrary JSON while allowing model metadata", async () => {
    const fixture = await setup("org_gateway_json_secrets");
    client = fixture.client;
    const workspaceId = fixture.actor.workspaceId;
    const canonicalModelId = `${workspaceId}:canonical:openai:gpt-5.4-mini`;
    const providerConnectionId = `${workspaceId}:connection:openai`;
    const deploymentId = await create(fixture, "modelDeployment", {
      slug: "safe-deployment",
      name: "Safe Deployment",
      canonicalModelId,
      providerConnectionId,
      upstreamModelId: "safe-deployment"
    });
    await expect(create(fixture, "providerConnection", providerInput("unowned-adapter-config", {
      adapterConfig: { timeoutMs: 5_000 }
    }))).rejects.toThrow("provider_adapter_config_invalid");
    await expect(create(fixture, "providerConnection", providerInput("unnormalized-bedrock-config", {
      adapterKind: "aws-bedrock-converse",
      authStyle: "aws-sdk",
      secret: "bedrock-test-credential",
      adapterConfig: { defaultRegion: " us-east-1 " }
    }))).rejects.toThrow("provider_adapter_config_invalid");

    const credentialCases: Array<[string, Record<string, unknown>]> = [
      ["nested-credentials", { credentials: { apiKey: "sk-nested-credential-leak" } }],
      ["access-token", { accessToken: "sk-access-token-leak" }],
      ["token-value", { tokenValue: "sk-token-value-leak" }],
      ["api-token", { apiToken: "sk-api-token-leak" }],
      ["api-tokens", { apiTokens: ["sk-api-tokens-leak"] }],
      ["capability-string", { supportsApiKey: "sk-capability-string-leak" }],
      ["numeric-api-key", { apiKey: 12345 }],
      ["numeric-api-tokens", { apiTokens: 12345 }],
      ["boolean-access-token", { accessToken: true }],
      ["array-auth-key", { authKey: ["sk-array-auth-key-leak"] }],
      ["private-key-pem", { privateKeyPem: "sk-private-key-pem-leak" }],
      ["service-account-json", { serviceAccountJson: "sk-service-account-json-leak" }],
      ["passphrase", { passphrase: "sk-passphrase-leak" }],
      ["api-keys-file", { apiKeysFile: "sk-api-keys-file-leak" }],
      ["api-tokens-json", { apiTokensJson: "sk-api-tokens-json-leak" }],
      ["client-credentials", { clientCredentials: "sk-client-credentials-leak" }],
      ["credentials-path", { credentialsPath: "sk-credentials-path-leak" }],
      ["provider-credentials", { providerCredentials: "sk-provider-credentials-leak" }],
      ["service-account-file", { serviceAccountFile: "sk-service-account-file-leak" }],
      ["service-account-key-json", { serviceAccountKeyJson: "sk-service-account-key-json-leak" }],
      ["auth-value", { authValue: "sk-auth-value-leak" }],
      ["authentication-value", { authenticationValue: "sk-authentication-value-leak" }],
      ["auth-material", { authMaterial: "sk-auth-material-leak" }],
      ["private-jwk", { privateJwk: { kty: "OKP", d: "sk-private-jwk-leak" } }],
      ["signing-jwk", { signingJwk: { kty: "OKP", d: "sk-signing-jwk-leak" } }],
      ["private-key-base64-url", { privateKeyBase64Url: "sk-private-key-base64-url-leak" }],
      ["secret-b64", { secretB64: "sk-secret-b64-leak" }],
      ["access-key-id", { accessKeyId: "sk-access-key-id-leak" }],
      ["aws-access-key-id", { awsAccessKeyId: "sk-aws-access-key-id-leak" }],
      ["connection-string", { connectionString: "sk-connection-string-leak" }],
      ["pfx", { pfx: "sk-pfx-leak" }],
      ["p12", { p12: "sk-p12-leak" }],
      ["pkcs12", { pkcs12: "sk-pkcs12-leak" }],
      ["key-store", { keyStore: "sk-key-store-leak" }],
      ["key-store-path", { keystorePath: "sk-key-store-path-leak" }]
    ];
    for (const [, config] of credentialCases) {
      await expect(update(fixture, "modelDeployment", deploymentId, { config }))
        .rejects.toThrow("gateway_config_secret_forbidden");
    }

    const metadata = {
      allowsCredentialForwarding: false,
      auth: "bearer",
      bosToken: "<s>",
      cacheCreationInputTokens: 50,
      cachedInputTokens: 100,
      eosToken: "</s>",
      estimatedInputTokens: 150,
      maxTokens: "8192",
      requiresApiKey: true,
      savedEstimatedTokens: 25,
      stopTokens: ["<stop>"],
      supportsApiKey: true,
      supportsCookieAuth: true,
      supportsPrivateKey: true,
      tokenizationStrategy: "byte-pair",
      tokenizers: ["o200k"],
      tokenUnit: "million",
      unkToken: "<unk>",
      usesBearerToken: true
    };
    await update(fixture, "modelDeployment", deploymentId, { config: metadata });
    expect(await fixture.service.modelDeployment(fixture.actor, deploymentId))
      .toMatchObject({ config: metadata });

    await expect(create(fixture, "canonicalModel", {
      slug: "canonical-secret",
      name: "Canonical Secret",
      vendor: "acme",
      family: "secret",
      capabilities: { accessToken: ["sk-canonical-capability-leak"] }
    })).rejects.toThrow("gateway_config_secret_forbidden");
    await expect(create(fixture, "modelDeployment", {
      slug: "deployment-secret",
      name: "Deployment Secret",
      canonicalModelId,
      providerConnectionId,
      upstreamModelId: "deployment-secret",
      config: { accessToken: "sk-deployment-create-leak" }
    })).rejects.toThrow("gateway_config_secret_forbidden");
    await expect(create(fixture, "modelDeployment", {
      slug: "deployment-pricing-secret",
      name: "Deployment Pricing Secret",
      canonicalModelId,
      providerConnectionId,
      upstreamModelId: "deployment-pricing-secret",
      pricing: { apiKey: "sk-deployment-pricing-create-leak" }
    })).rejects.toThrow("gateway_config_secret_forbidden");

    await expect(update(fixture, "modelDeployment", deploymentId, {
      config: { privateKey: "sk-deployment-update-leak" }
    })).rejects.toThrow("gateway_config_secret_forbidden");
    await expect(update(fixture, "modelDeployment", deploymentId, {
      pricing: { authKey: "sk-deployment-pricing-update-leak" }
    })).rejects.toThrow("gateway_config_secret_forbidden");
    expect(await fixture.service.modelDeployment(fixture.actor, deploymentId)).toMatchObject({ config: metadata, pricing: {} });

    await expect(create(fixture, "wireBinding", {
      deploymentId,
      apiWireId: "openai-responses",
      endpointPath: "/responses",
      requestConfig: { refresh_token: "sk-binding-create-leak" }
    })).rejects.toThrow("gateway_config_secret_forbidden");
    const bindingId = await create(fixture, "wireBinding", {
      deploymentId,
      apiWireId: "openai-responses",
      endpointPath: "/responses"
    });
    await expect(update(fixture, "wireBinding", bindingId, {
      requestConfig: { sessionToken: "sk-binding-update-leak" }
    })).rejects.toThrow("gateway_config_secret_forbidden");
    expect(await fixture.service.wireBinding(fixture.actor, bindingId)).toMatchObject({ requestConfig: {} });
  });

  it("enforces secret-reference and authentication state transitions", async () => {
    const fixture = await setup("org_gateway_secret_transitions", supportsSecretReference);
    client = fixture.client;

    await expect(create(fixture, "providerConnection", providerInput("raw-secret-ref", {
      authStyle: "bearer",
      secretRef: "sk-live-secret"
    }))).rejects.toThrow("invalid_provider_connection");
    await expect(create(fixture, "providerConnection", providerInput("disabled-unsupported-ref", {
      authStyle: "bearer",
      secretRef: "unsupported-store://tenant/acme?version=1"
    }))).rejects.toThrow("provider_connection_secret_reference_unsupported");

    const disabledBearerId = await create(fixture, "providerConnection", providerInput("disabled-bearer", {
      authStyle: "bearer"
    }));
    await expect(update(fixture, "providerConnection", disabledBearerId, {
      secretRef: "unsupported-store://tenant/acme?version=2"
    })).rejects.toThrow("provider_connection_secret_reference_unsupported");
    expect(await fixture.service.providerConnection(fixture.actor, disabledBearerId)).toMatchObject({
      credentialConfigured: false,
      secretRef: null,
      status: "disabled"
    });

    const noneConnectionId = await create(fixture, "providerConnection", providerInput("none-auth"));
    await expect(update(fixture, "providerConnection", noneConnectionId, {
      secret: "sk-none-auth-secret-leak"
    })).rejects.toThrow("provider_connection_credential_forbidden");
    await expect(update(fixture, "providerConnection", noneConnectionId, {
      secretRef: "unsupported-secret-store://tenant/acme?version=1"
    })).rejects.toThrow("provider_connection_credential_forbidden");
    expect(await fixture.service.providerConnection(fixture.actor, noneConnectionId)).toMatchObject({
      authStyle: "none",
      credentialConfigured: false
    });

    const connectionId = await create(fixture, "providerConnection", providerInput("acme", {
      authStyle: "bearer",
      secretRef: "env:ACME_API_KEY",
      enabled: true
    }));
    const secretManagerRef = "aws-secretsmanager://arn:aws:secretsmanager:us-east-1:123456789012:secret:acme?versionId=version-1";
    const secretManagerConnectionId = await create(fixture, "providerConnection", providerInput("acme-secret-manager", {
      authStyle: "bearer",
      secretRef: secretManagerRef,
      enabled: true
    }));
    expect(await fixture.service.providerConnection(fixture.actor, secretManagerConnectionId)).toMatchObject({
      secretRef: secretManagerRef,
      credentialConfigured: true
    });
    await expect(update(fixture, "providerConnection", secretManagerConnectionId, {
      authStyle: "none",
      secretRef: secretManagerRef
    })).rejects.toThrow("provider_connection_credential_forbidden");
    await expect(update(fixture, "providerConnection", connectionId, {
      secretRef: "sk-update-secret"
    })).rejects.toThrow("invalid_provider_connection");
    await expect(update(fixture, "providerConnection", connectionId, {
      baseUrl: "http://10.2.3.4:8000/v1"
    })).rejects.toThrow("provider_connection_origin_credential_replacement_required");
    expect(await fixture.service.providerConnection(fixture.actor, connectionId)).toMatchObject({
      baseUrl: providerBaseUrl,
      secretRef: "env:ACME_API_KEY"
    });

    for (const [slug, body] of [
      ["unknown-ref", { secretRef: "env:UNKNOWN_API_KEY" }],
      ["wrong-origin-ref", { baseUrl: "http://10.9.8.7:8000/v1", secretRef: "env:ACME_API_KEY" }],
      ["wrong-provider-ref", { secretRef: "env:ACME_API_KEY" }]
    ] as const) {
      await expect(create(fixture, "providerConnection", providerInput(slug, {
        authStyle: "bearer",
        enabled: true,
        ...body
      }))).rejects.toThrow("provider_connection_secret_reference_unsupported");
    }
  });

  it("can disable and clear a connection after its secret reference becomes unavailable", async () => {
    let secretAvailable = true;
    const fixture = await setup("org_gateway_secret_emergency_disable", () => secretAvailable);
    client = fixture.client;
    await create(fixture, "providerConnection", providerInput("emergency-provider", {
      authStyle: "bearer",
      secretRef: "env:EMERGENCY_PROVIDER_KEY",
      enabled: true
    }));
    secretAvailable = false;

    const plan = await applyGatewayConfig(
      fixture.service,
      parseGatewayConfigDocument(`
version = 1
[scope]
organization_id = "${fixture.actor.organizationId}"
workspace_id = "${fixture.actor.workspaceId}"
[[provider_connections]]
provider = "emergency-provider"
slug = "emergency-provider"
name = "emergency-provider"
adapter_kind = "generic-http-json"
auth_style = "bearer"
base_url = "${providerBaseUrl}"
clear_secret = true
enabled = false
`),
      fixture.actor.actorUserId
    );
    expect(plan.commands.map((command) => command.action)).toEqual(["setEnabled", "update"]);
    expect(await bySlug(fixture.service.providerConnections(fixture.actor), "emergency-provider"))
      .toMatchObject({ status: "disabled", credentialConfigured: false, secretRef: null });
  });

  it("never exposes raw credentials through reads, rows, or audit events", async () => {
    const fixture = await setup("org_gateway_secret_non_exposure", supportsSecretReference);
    client = fixture.client;
    const rawSecret = "sk-persisted-control-plane-secret";
    const rejectedConfigSecret = "sk-rejected-config-secret";
    const rejectedPrivateJwkSecret = "sk-rejected-private-jwk-secret";
    const rejectedUrlSecret = "sk-rejected-url-secret";
    const connectionId = await create(fixture, "providerConnection", providerInput("encrypted-secret", {
      authStyle: "bearer",
      secret: rawSecret,
      enabled: true
    }));
    await create(fixture, "providerConnection", providerInput("acme", {
      authStyle: "bearer",
      secretRef: "env:ACME_API_KEY",
      enabled: true
    }));
    const workspaceId = fixture.actor.workspaceId;
    const deploymentId = await create(fixture, "modelDeployment", {
      slug: "non-exposure-deployment",
      name: "Non-exposure Deployment",
      canonicalModelId: `${workspaceId}:canonical:openai:gpt-5.4-mini`,
      providerConnectionId: `${workspaceId}:connection:openai`,
      upstreamModelId: "non-exposure-deployment"
    });
    await expect(update(fixture, "modelDeployment", deploymentId, {
      config: { authValue: rejectedConfigSecret }
    })).rejects.toThrow("gateway_config_secret_forbidden");
    await expect(update(fixture, "modelDeployment", deploymentId, {
      config: { privateJwk: { kty: "OKP", d: rejectedPrivateJwkSecret } }
    })).rejects.toThrow("gateway_config_secret_forbidden");
    await expect(create(fixture, "providerConnection", providerInput("rejected-url-secret", {
      baseUrl: `${providerBaseUrl}?api_key=${rejectedUrlSecret}`
    }))).rejects.toThrow("provider_base_url_credentials_forbidden");

    const detail = await fixture.service.providerConnection(fixture.actor, connectionId);
    const list = await fixture.service.providerConnections(fixture.actor);
    const readsJson = JSON.stringify({ detail, list });
    expect(readsJson).not.toContain(rawSecret);
    expect(detail).not.toHaveProperty("secretCiphertext");
    expect(detail).toMatchObject({ credentialConfigured: true });

    const [stored] = await fixture.db.select({ ciphertext: providerConnections.secretCiphertext })
      .from(providerConnections).where(eq(providerConnections.id, connectionId));
    expect(stored?.ciphertext).toMatch(/^v1:/);
    expect(stored?.ciphertext).not.toContain(rawSecret);

    const auditEvents = await fixture.db.select({ payload: events.payload })
      .from(events).where(eq(events.producer, "proxy.admin.gateway-config"));
    const auditJson = JSON.stringify(auditEvents);
    expect(auditJson).not.toContain(stored?.ciphertext);
    for (const secret of [rawSecret, rejectedConfigSecret, rejectedPrivateJwkSecret, rejectedUrlSecret]) {
      expect(auditJson).not.toContain(secret);
    }
  });
});

function providerInput(slug: string, body: Record<string, unknown> = {}) {
  return {
    provider: slug,
    slug,
    name: slug,
    adapterKind: "generic-http-json",
    authStyle: "none",
    baseUrl: providerBaseUrl,
    ...body
  };
}

function supportsSecretReference(input: { reference: string; provider: string; baseUrl: string }) {
  const referenceSupported = (
    input.reference === "env:ACME_API_KEY" && input.provider === "acme"
  ) || (
    input.reference === "aws-secretsmanager://arn:aws:secretsmanager:us-east-1:123456789012:secret:acme?versionId=version-1" &&
    input.provider === "acme-secret-manager"
  );
  return referenceSupported && input.baseUrl === providerBaseUrl;
}

async function bySlug<T extends { slug: string }>(rows: Promise<T[]>, slug: string) {
  return (await rows).find((row) => row.slug === slug);
}
