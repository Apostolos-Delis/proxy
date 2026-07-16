import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

describe("AI gateway logical resource migration", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
  });

  it("enforces logical model, grant, and API-key scope", async () => {
    client = await migratedClient();
    await seedPhysicalFixtures(client);
    await client.exec(`
      insert into logical_models (
        id, organization_id, workspace_id, slug, name, resolution_kind, router_kind
      ) values
        ('logical_a_direct', 'org_logical_a', 'workspace_logical_a', 'fable', 'Fable', 'direct', null),
        ('logical_a_router', 'org_logical_a', 'workspace_logical_a', 'coding-auto', 'Coding Auto', 'router', 'classifier'),
        ('logical_a_secondary', 'org_logical_a', 'workspace_logical_a_secondary', 'secondary', 'Secondary', 'direct', null),
        ('logical_b_direct', 'org_logical_b', 'workspace_logical_b', 'fable', 'Fable', 'direct', null);
      insert into logical_model_targets (
        id, organization_id, workspace_id, logical_model_id, deployment_id, priority
      ) values
        ('target_a_direct', 'org_logical_a', 'workspace_logical_a', 'logical_a_direct', 'deployment_a', 0),
        ('target_a_router_0', 'org_logical_a', 'workspace_logical_a', 'logical_a_router', 'deployment_a', 0),
        ('target_a_router_1', 'org_logical_a', 'workspace_logical_a', 'logical_a_router', 'deployment_a_alt', 1),
        ('target_a_secondary', 'org_logical_a', 'workspace_logical_a_secondary', 'logical_a_secondary', 'deployment_a_secondary', 0);
      insert into access_profiles (
        id, organization_id, workspace_id, slug, name
      ) values
        ('profile_a', 'org_logical_a', 'workspace_logical_a', 'engineer', 'Engineer'),
        ('profile_a_secondary', 'org_logical_a', 'workspace_logical_a_secondary', 'secondary', 'Secondary'),
        ('profile_b', 'org_logical_b', 'workspace_logical_b', 'engineer', 'Engineer');
      insert into access_profile_model_grants (
        id, organization_id, workspace_id, access_profile_id, logical_model_id,
        allowed_operations, parameter_caps
      ) values (
        'grant_a', 'org_logical_a', 'workspace_logical_a', 'profile_a', 'logical_a_direct',
        array['text.generate', 'model.list'], '{"max_tokens":8192}'
      );
      insert into api_keys (
        id, organization_id, workspace_id, key_hash, name, access_profile_id
      ) values (
        'key_a', 'org_logical_a', 'workspace_logical_a', 'key-a-hash', 'Key A', 'profile_a'
      );
    `);

    const rows = await client.query<{ slug: string; operation: string }>(`
      select lm.slug, unnest(g.allowed_operations) as operation
      from access_profile_model_grants g
      join logical_models lm on lm.id = g.logical_model_id
      order by operation
    `);
    expect(rows.rows).toEqual([
      { slug: "fable", operation: "model.list" },
      { slug: "fable", operation: "text.generate" }
    ]);

    await expect(client.exec(`
      insert into logical_model_targets (
        id, organization_id, workspace_id, logical_model_id, deployment_id, priority
      ) values (
        'target_cross_workspace', 'org_logical_a', 'workspace_logical_a',
        'logical_a_direct', 'deployment_a_secondary', 2
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into logical_model_targets (
        id, organization_id, workspace_id, logical_model_id, deployment_id, priority
      ) values (
        'target_cross_org', 'org_logical_a', 'workspace_logical_a',
        'logical_a_direct', 'deployment_b', 2
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into access_profile_model_grants (
        id, organization_id, workspace_id, access_profile_id, logical_model_id, allowed_operations
      ) values (
        'grant_cross_workspace', 'org_logical_a', 'workspace_logical_a',
        'profile_a', 'logical_a_secondary', array['text.generate']
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into access_profile_model_grants (
        id, organization_id, workspace_id, access_profile_id, logical_model_id, allowed_operations
      ) values (
        'grant_cross_org', 'org_logical_a', 'workspace_logical_a',
        'profile_b', 'logical_a_direct', array['text.generate']
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      update api_keys set access_profile_id = 'profile_a_secondary' where id = 'key_a';
    `)).rejects.toThrow();

    await expect(client.exec(`
      update api_keys set access_profile_id = 'profile_b' where id = 'key_a';
    `)).rejects.toThrow();
  });

  it("rejects invalid logical resource values and protects dependent rows", async () => {
    client = await migratedClient();
    await seedPhysicalFixtures(client);
    await client.exec(`
      insert into logical_models (
        id, organization_id, workspace_id, slug, name, resolution_kind, router_kind
      ) values
        ('logical_valid', 'org_logical_a', 'workspace_logical_a', 'valid', 'Valid', 'direct', null),
        ('logical_disposable', 'org_logical_a', 'workspace_logical_a', 'disposable', 'Disposable', 'direct', null);
      insert into logical_model_targets (
        id, organization_id, workspace_id, logical_model_id, deployment_id, priority
      ) values
        ('target_valid', 'org_logical_a', 'workspace_logical_a', 'logical_valid', 'deployment_a', 0),
        ('target_disposable', 'org_logical_a', 'workspace_logical_a', 'logical_disposable', 'deployment_a', 0);
      insert into access_profiles (
        id, organization_id, workspace_id, slug, name
      ) values ('profile_valid', 'org_logical_a', 'workspace_logical_a', 'valid', 'Valid');
      insert into access_profile_model_grants (
        id, organization_id, workspace_id, access_profile_id, logical_model_id, allowed_operations
      ) values (
        'grant_disposable', 'org_logical_a', 'workspace_logical_a',
        'profile_valid', 'logical_disposable', array['text.generate']
      );
    `);

    await expect(client.exec(`
      insert into logical_models (
        id, organization_id, workspace_id, slug, name, resolution_kind, router_kind
      ) values (
        'logical_invalid_direct', 'org_logical_a', 'workspace_logical_a',
        'invalid-direct', 'Invalid', 'direct', 'classifier'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into logical_models (
        id, organization_id, workspace_id, slug, name, resolution_kind, router_kind
      ) values (
        'logical_invalid_router', 'org_logical_a', 'workspace_logical_a',
        'invalid-router', 'Invalid', 'router', null
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into logical_models (
        id, organization_id, workspace_id, slug, name, resolution_kind, status
      ) values (
        'logical_invalid_status', 'org_logical_a', 'workspace_logical_a',
        'invalid-status', 'Invalid', 'direct', 'retired'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into logical_models (
        id, organization_id, workspace_id, slug, name, resolution_kind
      ) values (
        'logical_duplicate_slug', 'org_logical_a', 'workspace_logical_a',
        'valid', 'Duplicate', 'direct'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into logical_model_targets (
        id, organization_id, workspace_id, logical_model_id, deployment_id, priority
      ) values (
        'target_negative', 'org_logical_a', 'workspace_logical_a',
        'logical_valid', 'deployment_a_alt', -1
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into access_profiles (
        id, organization_id, workspace_id, slug, name, limits
      ) values (
        'profile_negative_limit', 'org_logical_a', 'workspace_logical_a',
        'negative-limit', 'Invalid', '{"requests_per_minute":-1}'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into access_profiles (
        id, organization_id, workspace_id, slug, name, limits
      ) values (
        'profile_fractional_limit', 'org_logical_a', 'workspace_logical_a',
        'fractional-limit', 'Invalid', '{"requests_per_minute":1.5}'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into access_profiles (
        id, organization_id, workspace_id, slug, name, limits
      ) values (
        'profile_parameter_cap_limit', 'org_logical_a', 'workspace_logical_a',
        'parameter-cap-limit', 'Invalid', '{"max_tokens":8192}'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into access_profile_model_grants (
        id, organization_id, workspace_id, access_profile_id, logical_model_id,
        allowed_operations, parameter_caps
      ) values (
        'grant_invalid_operation', 'org_logical_a', 'workspace_logical_a',
        'profile_valid', 'logical_valid', array['embeddings.create'], '{}'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into access_profile_model_grants (
        id, organization_id, workspace_id, access_profile_id, logical_model_id,
        allowed_operations, parameter_caps
      ) values (
        'grant_negative_cap', 'org_logical_a', 'workspace_logical_a',
        'profile_valid', 'logical_valid', array['text.generate'], '{"max_tokens":-1}'
      );
    `)).rejects.toThrow();

    await expect(client.exec(`
      insert into access_profile_model_grants (
        id, organization_id, workspace_id, access_profile_id, logical_model_id,
        allowed_operations, parameter_caps
      ) values (
        'grant_unknown_cap', 'org_logical_a', 'workspace_logical_a',
        'profile_valid', 'logical_valid', array['text.generate'], '{"misspelled_max_tokens":8192}'
      );
    `)).rejects.toThrow();

    await client.exec("delete from logical_models where id = 'logical_disposable'");
    const dependents = await client.query<{ count: number }>(`
      select (
        (select count(*) from logical_model_targets where logical_model_id = 'logical_disposable') +
        (select count(*) from access_profile_model_grants where logical_model_id = 'logical_disposable')
      )::int as count
    `);
    expect(dependents.rows).toEqual([{ count: 0 }]);
  });
});

async function migratedClient() {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  return client;
}

async function seedPhysicalFixtures(client: PGlite) {
  await client.exec(`
    insert into organizations (id, slug, name) values
      ('org_logical_a', 'logical-a', 'Logical A'),
      ('org_logical_b', 'logical-b', 'Logical B');
    insert into workspaces (id, organization_id, slug, name) values
      ('workspace_logical_a', 'org_logical_a', 'default', 'Default'),
      ('workspace_logical_a_secondary', 'org_logical_a', 'secondary', 'Secondary'),
      ('workspace_logical_b', 'org_logical_b', 'default', 'Default');
    insert into provider_connections (
      id, organization_id, workspace_id, provider, slug, name, adapter_kind, auth_style, base_url
    ) values
      ('connection_a', 'org_logical_a', 'workspace_logical_a', 'openai', 'openai', 'OpenAI', 'generic-http-json', 'bearer', 'https://api.openai.com/v1'),
      ('connection_a_secondary', 'org_logical_a', 'workspace_logical_a_secondary', 'openai', 'openai', 'OpenAI', 'generic-http-json', 'bearer', 'https://api.openai.com/v1'),
      ('connection_b', 'org_logical_b', 'workspace_logical_b', 'openai', 'openai', 'OpenAI', 'generic-http-json', 'bearer', 'https://api.openai.com/v1');
    insert into canonical_models (
      id, organization_id, workspace_id, slug, name, vendor, family
    ) values
      ('canonical_a', 'org_logical_a', 'workspace_logical_a', 'gpt-a', 'GPT A', 'openai', 'gpt'),
      ('canonical_a_alt', 'org_logical_a', 'workspace_logical_a', 'gpt-a-alt', 'GPT A Alt', 'openai', 'gpt'),
      ('canonical_a_secondary', 'org_logical_a', 'workspace_logical_a_secondary', 'gpt-secondary', 'GPT Secondary', 'openai', 'gpt'),
      ('canonical_b', 'org_logical_b', 'workspace_logical_b', 'gpt-b', 'GPT B', 'openai', 'gpt');
    insert into model_deployments (
      id, organization_id, workspace_id, slug, name, canonical_model_id,
      provider_connection_id, upstream_model_id
    ) values
      ('deployment_a', 'org_logical_a', 'workspace_logical_a', 'gpt-a', 'GPT A', 'canonical_a', 'connection_a', 'gpt-a'),
      ('deployment_a_alt', 'org_logical_a', 'workspace_logical_a', 'gpt-a-alt', 'GPT A Alt', 'canonical_a_alt', 'connection_a', 'gpt-a-alt'),
      ('deployment_a_secondary', 'org_logical_a', 'workspace_logical_a_secondary', 'gpt-secondary', 'GPT Secondary', 'canonical_a_secondary', 'connection_a_secondary', 'gpt-secondary'),
      ('deployment_b', 'org_logical_b', 'workspace_logical_b', 'gpt-b', 'GPT B', 'canonical_b', 'connection_b', 'gpt-b');
  `);
}
