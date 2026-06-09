import { afterEach, describe, expect, it } from "vitest";

import {
  organizations,
  routingConfigs
} from "@prompt-proxy/db";
import type { RoutingConfig } from "@prompt-proxy/schema";

import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("routing config admin APIs", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("requires browser admin sessions", async () => {
    const fixture = await setup("org_routing_config_auth");

    const list = await fetch(`${fixture.proxyUrl}/admin/routing-configs`);
    const detail = await fetch(`${fixture.proxyUrl}/admin/routing-configs/org_routing_config_auth:routing-config:default`);

    expect(list.status).toBe(401);
    expect(detail.status).toBe(401);
  });

  it("lists org-scoped routing configs with active version and key counts", async () => {
    const fixture = await setup("org_routing_config_list");
    await fixture.db.insert(routingConfigs).values({
      id: "org_routing_config_list:routing-config:archived",
      organizationId: "org_routing_config_list",
      name: "Archived routing config",
      slug: "archived",
      status: "archived"
    });
    await fixture.db.insert(organizations).values({
      id: "org_routing_config_other",
      slug: "org-routing-config-other",
      name: "Other Org"
    });
    await fixture.db.insert(routingConfigs).values({
      id: "org_routing_config_other:routing-config:default",
      organizationId: "org_routing_config_other",
      name: "Other routing config",
      slug: "default"
    });

    const response = await fetch(`${fixture.proxyUrl}/admin/routing-configs`, {
      headers: fixture.adminHeaders
    });
    const body = await response.json();
    const ids = body.data.map((item: any) => item.id);
    const seeded = body.data.find((item: any) => item.id === "org_routing_config_list:routing-config:default");
    const archived = body.data.find((item: any) => item.id === "org_routing_config_list:routing-config:archived");
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(ids).toContain("org_routing_config_list:routing-config:default");
    expect(ids).toContain("org_routing_config_list:routing-config:archived");
    expect(ids).not.toContain("org_routing_config_other:routing-config:default");
    expect(seeded).toEqual(expect.objectContaining({
      organizationId: "org_routing_config_list",
      name: "Default routing config",
      status: "active",
      activeVersionId: "org_routing_config_list:routing-config:default:v1",
      assignedApiKeyCount: 1,
      activeVersion: expect.objectContaining({
        id: "org_routing_config_list:routing-config:default:v1",
        version: 1,
        status: "active",
        active: true,
        configHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    }));
    expect(archived).toEqual(expect.objectContaining({
      status: "archived",
      activeVersion: null,
      assignedApiKeyCount: 0
    }));
    expect(serialized).not.toContain("openai-upstream-key");
    expect(serialized).not.toContain("anthropic-upstream-key");
    expect(serialized).not.toContain("keyHash");
  });

  it("serves routing config detail with version history", async () => {
    const fixture = await setup("org_routing_config_detail");

    await fixture.db.insert(organizations).values({
      id: "org_routing_config_detail_other",
      slug: "org-routing-config-detail-other",
      name: "Other Org"
    });
    await fixture.db.insert(routingConfigs).values({
      id: "org_routing_config_detail_other:routing-config:default",
      organizationId: "org_routing_config_detail_other",
      name: "Other routing config",
      slug: "default"
    });

    const response = await fetch(
      `${fixture.proxyUrl}/admin/routing-configs/org_routing_config_detail:routing-config:default`,
      { headers: fixture.adminHeaders }
    );
    const body = await response.json();
    const crossOrg = await fetch(
      `${fixture.proxyUrl}/admin/routing-configs/org_routing_config_detail_other:routing-config:default`,
      { headers: fixture.adminHeaders }
    );
    const missing = await fetch(`${fixture.proxyUrl}/admin/routing-configs/missing_config`, {
      headers: fixture.adminHeaders
    });
    const versionConfig = body.versions[0].config as RoutingConfig;

    expect(response.status).toBe(200);
    expect(body.config).toEqual(expect.objectContaining({
      id: "org_routing_config_detail:routing-config:default",
      assignedApiKeyCount: 1,
      activeVersion: expect.objectContaining({
        id: "org_routing_config_detail:routing-config:default:v1",
        active: true
      })
    }));
    expect(body.versions).toEqual([
      expect.objectContaining({
        id: "org_routing_config_detail:routing-config:default:v1",
        routingConfigId: "org_routing_config_detail:routing-config:default",
        version: 1,
        status: "active",
        active: true,
        configHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        config: expect.any(Object)
      })
    ]);
    expect(versionConfig.routes.hard.openai?.model).toBe("gpt-5.5");
    expect(versionConfig.routes.hard.anthropic?.model).toBe("claude-sonnet-4-5");
    expect(JSON.stringify(body)).not.toContain("openai-upstream-key");
    expect(JSON.stringify(body)).not.toContain("anthropic-upstream-key");
    expect(crossOrg.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});
