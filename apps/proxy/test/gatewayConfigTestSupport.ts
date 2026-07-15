import { Buffer } from "node:buffer";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import {
  createPgliteDatabase,
  createTransactionalDatabase,
  defaultWorkspaceId
} from "@proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@proxy/db/seed";
import { EventService } from "../src/events.js";
import { DatabaseEventSink } from "../src/persistence/eventSink.js";
import {
  GatewayConfigAdminService,
  type GatewayConfigActor,
  type GatewayConfigResource
} from "../src/persistence/gatewayConfigAdmin.js";

export type GatewayConfigFixture = Awaited<ReturnType<typeof setupGatewayConfig>>;

export async function createGatewayConfig(
  fixture: GatewayConfigFixture,
  resource: GatewayConfigResource,
  body: unknown
) {
  const [result] = await fixture.service.applyCommands({
    ...fixture.actor,
    commands: [{ resource, action: "create", body }]
  });
  return result!.id;
}

export async function updateGatewayConfig(
  fixture: GatewayConfigFixture,
  resource: GatewayConfigResource,
  id: string,
  body: unknown
) {
  await fixture.service.applyCommands({
    ...fixture.actor,
    commands: [{ resource, action: "update", id, body }]
  });
}

export async function setGatewayConfigEnabled(
  fixture: GatewayConfigFixture,
  resource: GatewayConfigResource,
  id: string,
  value: boolean
) {
  await fixture.service.applyCommands({
    ...fixture.actor,
    commands: [{ resource, action: "setEnabled", id, enabled: value }]
  });
}

export async function setupGatewayConfig(
  organizationId: string,
  secretReferenceSupported?: (input: { reference: string; provider: string; baseUrl: string }) => boolean
) {
  const client = await migratedClient();
  const db = createPgliteDatabase(client);
  await seedDatabase(db, seedOptionsFromEnv({
    DEFAULT_ORGANIZATION_ID: organizationId,
    SEED_USER_ID: `user_${organizationId}`,
    PROXY_TOKEN: `token_${organizationId}`
  }));
  const actor: GatewayConfigActor = {
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    actorUserId: `user_${organizationId}`
  };
  const transactional = createTransactionalDatabase(db);
  const eventService = new EventService(
    undefined,
    undefined,
    new DatabaseEventSink(transactional, false),
    organizationId
  );
  return {
    actor,
    client,
    db,
    eventService,
    service: new GatewayConfigAdminService(db, transactional, eventService, {
      allowedPrivateUpstreamCidrs: ["10.0.0.0/8"],
      encryptionKey: Buffer.alloc(32, 7).toString("base64"),
      secretReferenceSupported
    })
  };
}

async function migratedClient() {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  return client;
}
