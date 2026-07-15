import type {
  ProxyDatabase,
  ProxyTransaction,
  ProxyTransactionalDatabase
} from "@proxy/db";

import { type CommittedTransactionEvent, EventService, jsonPayload } from "../events.js";
import type { JsonObject } from "../types.js";
import {
  assignApiKeyAccessProfile,
  createAccessProfile,
  createModelGrant,
  setAccessProfileEnabled,
  setModelGrantEnabled,
  updateAccessProfile,
  updateModelGrant
} from "./gatewayConfigAccessMutations.js";
import {
  createModelDeployment,
  createWireBinding,
  setModelDeploymentEnabled,
  setWireBindingEnabled,
  updateModelDeployment,
  updateWireBinding
} from "./gatewayConfigDeploymentMutations.js";
import {
  createLogicalModel,
  createLogicalModelTarget,
  setLogicalModelEnabled,
  setLogicalModelTargetEnabled,
  updateLogicalModel,
  updateLogicalModelTarget
} from "./gatewayConfigLogicalMutations.js";
import {
  createCanonicalModel,
  createProviderConnection,
  preflightProviderCommands,
  setCanonicalModelEnabled,
  setProviderConnectionEnabled,
  updateCanonicalModel,
  updateProviderConnection
} from "./gatewayConfigProviderMutations.js";
import {
  GatewayConfigQueryStore,
  mapGatewayConstraintError
} from "./gatewayConfigStore.js";
import {
  GatewayConfigAdminError,
  type GatewayConfigActor,
  type GatewayConfigAdminOptions,
  type GatewayConfigCommand,
  type GatewayConfigCommandResult,
  type GatewayConfigMutationContext,
  type GatewayConfigResource,
  type GatewayConfigScope
} from "./gatewayConfigTypes.js";

export {
  GatewayConfigAdminError,
  type GatewayConfigActor,
  type GatewayConfigAdminOptions,
  type GatewayConfigCommand,
  type GatewayConfigCommandResult,
  type GatewayConfigResource,
  type GatewayConfigScope
} from "./gatewayConfigTypes.js";

export class GatewayConfigAdminService {
  private readonly pendingEvents = new WeakMap<object, CommittedTransactionEvent[]>();
  private readonly queries: GatewayConfigQueryStore;

  constructor(
    db: ProxyDatabase,
    private readonly transactional: ProxyTransactionalDatabase,
    private readonly events: EventService,
    private readonly options: GatewayConfigAdminOptions
  ) {
    this.queries = new GatewayConfigQueryStore(db);
  }

  async applyCommands(input: GatewayConfigActor & { commands: GatewayConfigCommand[] }) {
    if (input.commands.length === 0) return [];
    if (input.commands.length > 1_000) {
      throw new GatewayConfigAdminError("gateway_config_command_limit_exceeded", 400);
    }
    await preflightProviderCommands(this.queries, this.options, input);
    const pendingEvents: CommittedTransactionEvent[] = [];
    let results: GatewayConfigCommandResult[];
    try {
      results = await this.transactional.transaction(async (tx) => {
        this.pendingEvents.set(tx, pendingEvents);
        try {
          const context = this.mutationContext(tx, input);
          const commandResults: GatewayConfigCommandResult[] = [];
          for (const command of input.commands) {
            commandResults.push(await this.executeCommand(context, command));
          }
          return commandResults;
        } finally {
          this.pendingEvents.delete(tx);
        }
      });
    } catch (error) {
      throw mapGatewayConstraintError(error);
    }
    await this.events.commitTransactionEvents(pendingEvents);
    return results;
  }

  providerConnections(scope: GatewayConfigScope) {
    return this.queries.providerConnections(scope);
  }

  providerConnection(scope: GatewayConfigScope, id: string) {
    return this.queries.providerConnection(scope, id);
  }

  canonicalModels(scope: GatewayConfigScope) {
    return this.queries.canonicalModels(scope);
  }

  canonicalModel(scope: GatewayConfigScope, id: string) {
    return this.queries.canonicalModel(scope, id);
  }

  modelDeployments(scope: GatewayConfigScope) {
    return this.queries.modelDeployments(scope);
  }

  modelDeployment(scope: GatewayConfigScope, id: string) {
    return this.queries.modelDeployment(scope, id);
  }

  wireBindings(scope: GatewayConfigScope) {
    return this.queries.wireBindings(scope);
  }

  wireBinding(scope: GatewayConfigScope, id: string) {
    return this.queries.wireBinding(scope, id);
  }

  logicalModels(scope: GatewayConfigScope) {
    return this.queries.logicalModels(scope);
  }

  logicalModel(scope: GatewayConfigScope, id: string) {
    return this.queries.logicalModel(scope, id);
  }

  logicalModelTargets(scope: GatewayConfigScope) {
    return this.queries.logicalModelTargets(scope);
  }

  logicalModelTarget(scope: GatewayConfigScope, id: string) {
    return this.queries.logicalModelTarget(scope, id);
  }

  accessProfiles(scope: GatewayConfigScope) {
    return this.queries.accessProfiles(scope);
  }

  accessProfile(scope: GatewayConfigScope, id: string) {
    return this.queries.accessProfile(scope, id);
  }

  modelGrants(scope: GatewayConfigScope) {
    return this.queries.modelGrants(scope);
  }

  modelGrant(scope: GatewayConfigScope, id: string) {
    return this.queries.modelGrant(scope, id);
  }

  private mutationContext(tx: ProxyTransaction, actor: GatewayConfigActor): GatewayConfigMutationContext {
    return {
      tx,
      actor,
      options: this.options,
      appendEvent: (scopeType, scopeId, action, payload, createdAt) =>
        this.appendGatewayEvent(tx, actor, scopeType, scopeId, action, payload, createdAt)
    };
  }

  private async executeCommand(
    context: GatewayConfigMutationContext,
    command: GatewayConfigCommand
  ): Promise<GatewayConfigCommandResult> {
    if (command.resource === "apiKey") {
      return assignApiKeyAccessProfile(context, command.id, command.accessProfileId);
    }
    if (command.action === "create") return this.createResource(context, command.resource, command.body);
    if (command.action === "update") return this.updateResource(context, command.resource, command.id, command.body);
    return this.setResourceEnabled(context, command.resource, command.id, command.enabled);
  }

  private createResource(context: GatewayConfigMutationContext, resource: GatewayConfigResource, body: unknown) {
    switch (resource) {
      case "providerConnection": return createProviderConnection(context, body);
      case "canonicalModel": return createCanonicalModel(context, body);
      case "modelDeployment": return createModelDeployment(context, body);
      case "wireBinding": return createWireBinding(context, body);
      case "logicalModel": return createLogicalModel(context, body);
      case "logicalModelTarget": return createLogicalModelTarget(context, body);
      case "accessProfile": return createAccessProfile(context, body);
      case "modelGrant": return createModelGrant(context, body);
    }
  }

  private updateResource(
    context: GatewayConfigMutationContext,
    resource: GatewayConfigResource,
    id: string,
    body: unknown
  ) {
    switch (resource) {
      case "providerConnection": return updateProviderConnection(context, id, body);
      case "canonicalModel": return updateCanonicalModel(context, id, body);
      case "modelDeployment": return updateModelDeployment(context, id, body);
      case "wireBinding": return updateWireBinding(context, id, body);
      case "logicalModel": return updateLogicalModel(context, id, body);
      case "logicalModelTarget": return updateLogicalModelTarget(context, id, body);
      case "accessProfile": return updateAccessProfile(context, id, body);
      case "modelGrant": return updateModelGrant(context, id, body);
    }
  }

  private setResourceEnabled(
    context: GatewayConfigMutationContext,
    resource: GatewayConfigResource,
    id: string,
    enabled: boolean
  ) {
    switch (resource) {
      case "providerConnection": return setProviderConnectionEnabled(context, id, enabled);
      case "canonicalModel": return setCanonicalModelEnabled(context, id, enabled);
      case "modelDeployment": return setModelDeploymentEnabled(context, id, enabled);
      case "wireBinding": return setWireBindingEnabled(context, id, enabled);
      case "logicalModel": return setLogicalModelEnabled(context, id, enabled);
      case "logicalModelTarget": return setLogicalModelTargetEnabled(context, id, enabled);
      case "accessProfile": return setAccessProfileEnabled(context, id, enabled);
      case "modelGrant": return setModelGrantEnabled(context, id, enabled);
    }
  }

  private async appendGatewayEvent(
    tx: ProxyTransaction,
    actor: GatewayConfigActor,
    scopeType: string,
    scopeId: string,
    action: string,
    payload: Record<string, unknown>,
    createdAt?: Date
  ) {
    const pending = this.pendingEvents.get(tx);
    if (!pending) throw new Error("gateway_config_event_transaction_missing");
    pending.push(await this.events.appendInTransaction(tx, {
      tenantId: actor.organizationId,
      workspaceId: actor.workspaceId,
      scopeType,
      scopeId,
      correlationId: scopeId,
      actor: { type: "user", id: actor.actorUserId },
      producer: "proxy.admin.gateway-config",
      eventType: `gateway_config.${scopeType}.${action}`,
      payload: jsonPayload(payload) as JsonObject,
      createdAt: createdAt?.toISOString()
    }));
  }
}
