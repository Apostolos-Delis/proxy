import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

describe("AI gateway resolution evidence migration", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
  });

  it("preserves historical rows and enforces scoped gateway identities", async () => {
    client = await migratedClient("0028_ai_gateway_logical_resources.sql");
    await seedFixtures(client);
    await client.exec(`
      insert into requests (
        id, organization_id, workspace_id, surface, idempotency_key,
        requested_model, input_hash, input_chars
      ) values (
        'request_legacy', 'org_evidence', 'workspace_evidence', 'openai-responses',
        'idem_legacy', 'legacy-model', 'sha256:legacy', 10
      );
    `);

    await applyMigration(client, "0029_ai_gateway_resolution_evidence.sql");

    const historical = await client.query<{
      ingress_wire_id: string | null;
      resolved_logical_model_id: string | null;
      deployment_id: string | null;
    }>(`
      select ingress_wire_id, resolved_logical_model_id, deployment_id
      from requests where id = 'request_legacy'
    `);
    expect(historical.rows).toEqual([{
      ingress_wire_id: null,
      resolved_logical_model_id: null,
      deployment_id: null
    }]);

    await client.exec(`
      insert into requests (
        id, organization_id, workspace_id, surface, idempotency_key,
        requested_model, input_hash, input_chars
      ) values (
        'request_secondary', 'org_evidence', 'workspace_evidence_secondary',
        'openai-responses', 'idem_secondary', 'fable', 'sha256:secondary', 1
      );
    `);

    await client.exec(`
      update requests set
        ingress_wire_id = 'openai-responses',
        operation_id = 'text.generate',
        requested_logical_model = 'fable',
        resolved_logical_model_id = 'logical_evidence',
        access_profile_id = 'profile_evidence',
        router_kind = null,
        deployment_id = 'deployment_evidence',
        provider_connection_id = 'connection_evidence',
        egress_wire_id = 'anthropic-messages',
        wire_adapter_version = '1'
      where id = 'request_legacy';

      insert into route_decisions (
        id, request_id, organization_id, workspace_id, requested_model, policy_version,
        ingress_wire_id, operation_id, requested_logical_model, resolved_logical_model_id,
        access_profile_id, router_kind, deployment_id, provider_connection_id,
        egress_wire_id, wire_adapter_version
      ) values (
        'decision_evidence', 'request_legacy', 'org_evidence', 'workspace_evidence',
        'fable', 'gateway-v1', 'openai-responses', 'text.generate', 'fable',
        'logical_evidence', 'profile_evidence', null, 'deployment_evidence',
        'connection_evidence', 'anthropic-messages', '1'
      );

      insert into provider_attempts (
        id, request_id, organization_id, workspace_id, surface, provider, model,
        deployment_id, provider_connection_id, egress_wire_id,
        provider_adapter_contract_version
      ) values (
        'attempt_evidence', 'request_legacy', 'org_evidence', 'workspace_evidence',
        'openai-responses', 'anthropic', 'claude-fable-5', 'deployment_evidence',
        'connection_evidence', 'anthropic-messages', '1'
      );
    `);

    const attempt = await client.query<{
      deployment_id: string;
      provider_connection_id: string;
      egress_wire_id: string;
      provider_adapter_contract_version: string;
    }>(`
      select deployment_id, provider_connection_id, egress_wire_id,
        provider_adapter_contract_version
      from provider_attempts where id = 'attempt_evidence'
    `);
    expect(attempt.rows).toEqual([{
      deployment_id: "deployment_evidence",
      provider_connection_id: "connection_evidence",
      egress_wire_id: "anthropic-messages",
      provider_adapter_contract_version: "1"
    }]);

    await expect(client.exec(`
      update requests set resolved_logical_model_id = 'logical_secondary'
      where id = 'request_legacy';
    `)).rejects.toThrow();
    await expect(client.exec(`
      update route_decisions set access_profile_id = 'profile_secondary'
      where id = 'decision_evidence';
    `)).rejects.toThrow();
    await expect(client.exec(`
      update requests set provider_connection_id = 'connection_secondary'
      where id = 'request_legacy';
    `)).rejects.toThrow();
    await expect(client.exec(`
      update provider_attempts set provider_connection_id = 'connection_secondary'
      where id = 'attempt_evidence';
    `)).rejects.toThrow();
    await expect(client.exec(`
      update provider_attempts set egress_wire_id = 'unknown-wire'
      where id = 'attempt_evidence';
    `)).rejects.toThrow();
    await expect(client.exec(`
      update requests set egress_wire_id = 'openai-chat'
      where id = 'request_legacy';
    `)).rejects.toThrow();
    await expect(client.exec(`
      update provider_attempts set egress_wire_id = 'openai-chat'
      where id = 'attempt_evidence';
    `)).rejects.toThrow();
    await expect(client.exec(`
      insert into requests (
        id, organization_id, workspace_id, surface, idempotency_key,
        requested_model, input_hash, input_chars, ingress_wire_id
      ) values (
        'request_partial', 'org_evidence', 'workspace_evidence', 'openai-responses',
        'idem_partial', 'fable', 'sha256:partial', 1, 'openai-responses'
      );
    `)).rejects.toThrow();
    await expect(client.exec(`
      update provider_attempts set provider_adapter_contract_version = null
      where id = 'attempt_evidence';
    `)).rejects.toThrow();
    await expect(client.exec(`
      insert into route_decisions (
        id, request_id, organization_id, workspace_id, requested_model, policy_version
      ) values (
        'decision_cross_workspace', 'request_secondary', 'org_evidence',
        'workspace_evidence', 'fable', 'gateway-v1'
      );
    `)).rejects.toThrow();
    await expect(client.exec(`
      insert into provider_attempts (
        id, request_id, organization_id, workspace_id, surface, provider, model
      ) values (
        'attempt_cross_workspace', 'request_secondary', 'org_evidence',
        'workspace_evidence', 'openai-responses', 'anthropic', 'claude-fable-5'
      );
    `)).rejects.toThrow();

    const unchanged = await client.query<{
      resolved_logical_model_id: string;
      provider_connection_id: string;
    }>(`
      select resolved_logical_model_id, provider_connection_id
      from requests where id = 'request_legacy'
    `);
    expect(unchanged.rows).toEqual([{
      resolved_logical_model_id: "logical_evidence",
      provider_connection_id: "connection_evidence"
    }]);
  });
});

async function migratedClient(through: string) {
  const client = new PGlite();
  for (const file of await migrationFiles()) {
    await client.exec(await readFile(join(migrationsDirectory(), file), "utf8"));
    if (file === through) return client;
  }
  throw new Error(`Migration ${through} was not found.`);
}

async function applyMigration(client: PGlite, file: string) {
  await client.exec(await readFile(join(migrationsDirectory(), file), "utf8"));
}

async function migrationFiles() {
  return (await readdir(migrationsDirectory())).filter((file) => file.endsWith(".sql")).sort();
}

function migrationsDirectory() {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}

async function seedFixtures(client: PGlite) {
  await client.exec(`
    insert into organizations (id, slug, name) values
      ('org_evidence', 'evidence', 'Evidence');
    insert into workspaces (id, organization_id, slug, name) values
      ('workspace_evidence', 'org_evidence', 'default', 'Default'),
      ('workspace_evidence_secondary', 'org_evidence', 'secondary', 'Secondary');
    insert into provider_connections (
      id, organization_id, workspace_id, slug, name, adapter_kind, auth_style, base_url
    ) values
      ('connection_evidence', 'org_evidence', 'workspace_evidence', 'anthropic',
        'Anthropic', 'generic-http-json', 'x-api-key', 'https://api.anthropic.com/v1'),
      ('connection_secondary', 'org_evidence', 'workspace_evidence_secondary', 'anthropic',
        'Anthropic', 'generic-http-json', 'x-api-key', 'https://api.anthropic.com/v1');
    insert into canonical_models (
      id, organization_id, workspace_id, slug, name, vendor, family
    ) values
      ('canonical_evidence', 'org_evidence', 'workspace_evidence', 'fable',
        'Fable', 'anthropic', 'claude'),
      ('canonical_secondary', 'org_evidence', 'workspace_evidence_secondary', 'fable',
        'Fable', 'anthropic', 'claude');
    insert into model_deployments (
      id, organization_id, workspace_id, slug, name, canonical_model_id,
      provider_connection_id, upstream_model_id
    ) values
      ('deployment_evidence', 'org_evidence', 'workspace_evidence', 'fable',
        'Fable', 'canonical_evidence', 'connection_evidence', 'claude-fable-5'),
      ('deployment_secondary', 'org_evidence', 'workspace_evidence_secondary', 'fable',
        'Fable', 'canonical_secondary', 'connection_secondary', 'claude-fable-5');
    insert into deployment_wire_bindings (
      id, organization_id, workspace_id, deployment_id, provider_connection_id,
      api_wire_id, endpoint_path, adapter_contract_version
    ) values
      ('binding_evidence', 'org_evidence', 'workspace_evidence', 'deployment_evidence',
        'connection_evidence', 'anthropic-messages', '/v1/messages', '1'),
      ('binding_secondary', 'org_evidence', 'workspace_evidence_secondary', 'deployment_secondary',
        'connection_secondary', 'anthropic-messages', '/v1/messages', '1');
    insert into logical_models (
      id, organization_id, workspace_id, slug, name, resolution_kind
    ) values
      ('logical_evidence', 'org_evidence', 'workspace_evidence', 'fable', 'Fable', 'direct'),
      ('logical_secondary', 'org_evidence', 'workspace_evidence_secondary', 'fable', 'Fable', 'direct');
    insert into access_profiles (
      id, organization_id, workspace_id, slug, name
    ) values
      ('profile_evidence', 'org_evidence', 'workspace_evidence', 'engineer', 'Engineer'),
      ('profile_secondary', 'org_evidence', 'workspace_evidence_secondary', 'engineer', 'Engineer');
  `);
}
