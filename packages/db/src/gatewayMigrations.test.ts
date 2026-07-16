import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

describe("AI gateway physical resource migration", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
  });

  it("creates the physical resource tables and enforces tenant boundaries", async () => {
    client = await migratedClient();
    await client.exec(`
      insert into organizations (id, slug, name) values
        ('org_gateway_a', 'gateway-a', 'Gateway A'),
        ('org_gateway_b', 'gateway-b', 'Gateway B');
      insert into workspaces (id, organization_id, slug, name) values
        ('workspace_gateway_a', 'org_gateway_a', 'default', 'Default'),
        ('workspace_gateway_a_secondary', 'org_gateway_a', 'secondary', 'Secondary'),
        ('workspace_gateway_b', 'org_gateway_b', 'default', 'Default');
      insert into provider_connections (
        id, organization_id, workspace_id, provider, slug, name, adapter_kind, auth_style, base_url, secret_ref
      ) values
        (
          'connection_gateway_a', 'org_gateway_a', 'workspace_gateway_a', 'openai', 'openai', 'OpenAI',
          'generic-http-json', 'bearer', 'https://api.openai.com', 'op://openai/key'
        ),
        (
          'connection_gateway_a_alt', 'org_gateway_a', 'workspace_gateway_a', 'anthropic', 'anthropic', 'Anthropic',
          'generic-http-json', 'x-api-key', 'https://api.anthropic.com', 'op://anthropic/key'
        ),
        (
          'connection_gateway_a_bedrock', 'org_gateway_a', 'workspace_gateway_a', 'amazon-bedrock', 'bedrock', 'Bedrock',
          'aws-bedrock-converse', 'aws-sdk', 'https://bedrock-runtime.us-east-1.amazonaws.com', null
        ),
        (
          'connection_gateway_a_secondary', 'org_gateway_a', 'workspace_gateway_a_secondary', 'openai', 'openai', 'OpenAI',
          'generic-http-json', 'bearer', 'https://api.openai.com', 'op://openai/key'
        );
      insert into canonical_models (
        id, organization_id, workspace_id, slug, name, vendor, family, capabilities
      ) values
        (
          'canonical_gateway_a', 'org_gateway_a', 'workspace_gateway_a', 'gpt-5', 'GPT-5',
          'openai', 'gpt-5', '{"tools":true,"contextWindow":200000}'
        ),
        (
          'canonical_gateway_a_bedrock', 'org_gateway_a', 'workspace_gateway_a', 'claude-bedrock',
          'Claude on Bedrock', 'anthropic', 'claude', '{}'
        );
      insert into model_deployments (
        id, organization_id, workspace_id, slug, name, canonical_model_id,
        provider_connection_id, upstream_model_id, capabilities
      ) values
        (
          'deployment_gateway_a', 'org_gateway_a', 'workspace_gateway_a', 'gpt-5-primary', 'GPT-5 primary',
          'canonical_gateway_a', 'connection_gateway_a', 'gpt-5', '{"contextWindow":128000}'
        ),
        (
          'deployment_gateway_a_bedrock', 'org_gateway_a', 'workspace_gateway_a', 'claude-bedrock',
          'Claude Bedrock', 'canonical_gateway_a_bedrock', 'connection_gateway_a_bedrock',
          'anthropic.claude', '{}'
        );
      insert into deployment_wire_bindings (
        id, organization_id, workspace_id, deployment_id, provider_connection_id,
        api_wire_id, endpoint_path, adapter_contract_version
      ) values
        (
          'binding_gateway_a', 'org_gateway_a', 'workspace_gateway_a', 'deployment_gateway_a',
          'connection_gateway_a', 'openai-responses', '/v1/responses', '1'
        ),
        (
          'binding_gateway_a_bedrock', 'org_gateway_a', 'workspace_gateway_a',
          'deployment_gateway_a_bedrock', 'connection_gateway_a_bedrock', 'bedrock-converse',
          null, '1'
        );
    `);

    const rows = await client.query<{ deployment_id: string; api_wire_id: string }>(`
      select deployment_id, api_wire_id from deployment_wire_bindings order by deployment_id
    `);
    expect(rows.rows).toEqual([
      { deployment_id: "deployment_gateway_a", api_wire_id: "openai-responses" },
      { deployment_id: "deployment_gateway_a_bedrock", api_wire_id: "bedrock-converse" }
    ]);

    await expect(client.exec(`
      insert into model_deployments (
        id, organization_id, workspace_id, slug, name, canonical_model_id,
        provider_connection_id, upstream_model_id
      ) values (
        'deployment_gateway_b', 'org_gateway_b', 'workspace_gateway_b', 'cross-tenant', 'Cross tenant',
        'canonical_gateway_a', 'connection_gateway_a', 'gpt-5'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into model_deployments (
        id, organization_id, workspace_id, slug, name, canonical_model_id,
        provider_connection_id, upstream_model_id
      ) values (
        'deployment_gateway_a_secondary', 'org_gateway_a', 'workspace_gateway_a_secondary',
        'cross-workspace', 'Cross workspace', 'canonical_gateway_a',
        'connection_gateway_a_secondary', 'gpt-5'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into provider_connections (
        id, organization_id, workspace_id, provider, slug, name, adapter_kind, auth_style, base_url,
        secret_ref, secret_ciphertext
      ) values (
        'connection_invalid_secret', 'org_gateway_a', 'workspace_gateway_a', 'custom', 'invalid-secret', 'Invalid secret',
        'generic-http-json', 'bearer', 'https://example.com', 'op://secret', 'ciphertext'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into provider_connections (
        id, organization_id, workspace_id, provider, slug, name, adapter_kind, auth_style, base_url
      ) values (
        'connection_unknown_adapter', 'org_gateway_a', 'workspace_gateway_a', 'custom', 'unknown-adapter',
        'Unknown adapter', 'unknown', 'bearer', 'https://example.com'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into provider_connections (
        id, organization_id, workspace_id, provider, slug, name, adapter_kind, auth_style, base_url
      ) values (
        'connection_invalid_auth', 'org_gateway_a', 'workspace_gateway_a', 'custom', 'invalid-auth',
        'Invalid auth', 'aws-bedrock-converse', 'bearer', 'https://example.com'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into canonical_models (
        id, organization_id, workspace_id, slug, name, vendor, family
      ) values (
        'canonical_duplicate_slug', 'org_gateway_a', 'workspace_gateway_a', 'gpt-5', 'Duplicate',
        'openai', 'gpt-5'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into canonical_models (
        id, organization_id, workspace_id, slug, name, vendor, family, status
      ) values (
        'canonical_invalid_status', 'org_gateway_a', 'workspace_gateway_a', 'invalid-status',
        'Invalid status', 'openai', 'gpt-5', 'retired'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into model_deployments (
        id, organization_id, workspace_id, slug, name, canonical_model_id,
        provider_connection_id, upstream_model_id, capabilities
      ) values (
        'deployment_expanded', 'org_gateway_a', 'workspace_gateway_a', 'expanded', 'Expanded',
        'canonical_gateway_a', 'connection_gateway_a', 'gpt-5', '{"audio":true}'
      );
    `)).rejects.toThrow("model deployment capabilities must narrow canonical capabilities");

    await expect(client.exec(`
      update canonical_models
      set capabilities = '{"tools":true,"contextWindow":100000}'
      where id = 'canonical_gateway_a';
    `)).rejects.toThrow("canonical model capabilities are immutable");

    await expect(client.exec(`
      update provider_connections
      set adapter_kind = 'aws-bedrock-converse', auth_style = 'aws-sdk'
      where id = 'connection_gateway_a';
    `)).rejects.toThrow("provider connection adapter kind is immutable");

    await expect(client.exec(`
      insert into deployment_wire_bindings (
        id, organization_id, workspace_id, deployment_id, provider_connection_id,
        api_wire_id, endpoint_path, adapter_contract_version
      ) values (
        'binding_mismatched_connection', 'org_gateway_a', 'workspace_gateway_a', 'deployment_gateway_a',
        'connection_gateway_a_alt', 'openai-chat', '/v1/chat/completions', '1'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into deployment_wire_bindings (
        id, organization_id, workspace_id, deployment_id, provider_connection_id,
        api_wire_id, adapter_contract_version
      ) values (
        'binding_http_as_bedrock', 'org_gateway_a', 'workspace_gateway_a', 'deployment_gateway_a',
        'connection_gateway_a', 'bedrock-converse', '1'
      );
    `)).rejects.toThrow("deployment wire is incompatible with provider connection adapter");

    await expect(client.exec(`
      insert into deployment_wire_bindings (
        id, organization_id, workspace_id, deployment_id, provider_connection_id,
        api_wire_id, endpoint_path, adapter_contract_version
      ) values (
        'binding_bedrock_as_http', 'org_gateway_a', 'workspace_gateway_a',
        'deployment_gateway_a_bedrock', 'connection_gateway_a_bedrock',
        'openai-responses', '/v1/responses', '1'
      );
    `)).rejects.toThrow("deployment wire is incompatible with provider connection adapter");

    await expect(client.exec(`
      insert into deployment_wire_bindings (
        id, organization_id, workspace_id, deployment_id, provider_connection_id,
        api_wire_id, endpoint_path, adapter_contract_version
      ) values (
        'binding_unknown_wire', 'org_gateway_a', 'workspace_gateway_a', 'deployment_gateway_a',
        'connection_gateway_a', 'unknown-wire', '/v1/unknown', '1'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into deployment_wire_bindings (
        id, organization_id, workspace_id, deployment_id, provider_connection_id,
        api_wire_id, endpoint_path, adapter_contract_version
      ) values (
        'binding_relative_path', 'org_gateway_a', 'workspace_gateway_a', 'deployment_gateway_a',
        'connection_gateway_a', 'openai-chat', 'v1/chat/completions', '1'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into deployment_wire_bindings (
        id, organization_id, workspace_id, deployment_id, provider_connection_id,
        api_wire_id, endpoint_path, adapter_contract_version
      ) values (
        'binding_untrimmed_path', 'org_gateway_a', 'workspace_gateway_a', 'deployment_gateway_a',
        'connection_gateway_a', 'openai-chat', ' /v1/chat/completions', '1'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into deployment_wire_bindings (
        id, organization_id, workspace_id, deployment_id, provider_connection_id,
        api_wire_id, endpoint_path, adapter_contract_version
      ) values (
        'binding_unknown_version', 'org_gateway_a', 'workspace_gateway_a', 'deployment_gateway_a',
        'connection_gateway_a', 'openai-chat', '/v1/chat/completions', '2'
      );
    `)).rejects.toThrow();

    await client.exec("delete from model_deployments where id in ('deployment_gateway_a', 'deployment_gateway_a_bedrock')");
    const bindingsAfterDeploymentDelete = await client.query<{ count: number }>(`
      select count(*)::int as count from deployment_wire_bindings where deployment_id = 'deployment_gateway_a'
    `);
    expect(bindingsAfterDeploymentDelete.rows).toEqual([{ count: 0 }]);

    await client.exec("delete from workspaces where id = 'workspace_gateway_a'");
    const resourcesAfterWorkspaceDelete = await client.query<{ count: number }>(`
      select (
        (select count(*) from provider_connections where workspace_id = 'workspace_gateway_a') +
        (select count(*) from canonical_models where workspace_id = 'workspace_gateway_a')
      )::int as count
    `);
    expect(resourcesAfterWorkspaceDelete.rows).toEqual([{ count: 0 }]);
  });
});

async function migratedClient() {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  return client;
}
