import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { ProxyTransaction } from "@proxy/db";
import { updateProviderConnection } from "../src/persistence/gatewayConfigProviderMutations.js";

describe("gateway configuration concurrency", () => {
  it("locks provider rows before deriving updates so rotated credentials survive unrelated writes", async () => {
    const rotatedCredential = "v1:rotated-ciphertext";
    const current = {
      id: "connection_acme",
      organizationId: "org_acme",
      workspaceId: "workspace_acme",
      slug: "acme",
      name: "Acme",
      adapterKind: "generic-http-json" as const,
      authStyle: "bearer" as const,
      baseUrl: "https://api.acme.example/v1",
      region: null,
      secretRef: null,
      secretCiphertext: rotatedCredential,
      secretHint: "rotated",
      adapterConfig: {},
      defaultHeaders: {},
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    };
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const limit = vi.fn().mockResolvedValue([current]);
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit }))
      }))
    }));
    let updatedValues: Record<string, unknown> | undefined;
    const update = vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updatedValues = values;
        return { where: vi.fn().mockResolvedValue([]) };
      })
    }));
    const appendEvent = vi.fn().mockResolvedValue(undefined);

    await updateProviderConnection({
      tx: { execute, select, update } as unknown as ProxyTransaction,
      actor: {
        organizationId: current.organizationId,
        workspaceId: current.workspaceId,
        actorUserId: "user_acme"
      },
      options: { allowedPrivateUpstreamCidrs: [] },
      appendEvent
    }, current.id, { name: "Acme Production" });

    const lockQuery = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]).sql;
    expect(lockQuery.toLowerCase()).toContain("for update");
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(select.mock.invocationCallOrder[0]!);
    expect(updatedValues).toMatchObject({
      name: "Acme Production",
      secretCiphertext: rotatedCredential,
      secretHint: "rotated"
    });
    expect(appendEvent).toHaveBeenCalledWith(
      "provider_connection",
      current.id,
      "updated",
      expect.objectContaining({ credential: "encrypted", name: "Acme Production" }),
      expect.any(Date)
    );
  });
});
