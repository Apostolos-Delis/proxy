import type { GraphQLContext } from "./context.js";
import type { GatewayConfigCommand, GatewayConfigResource } from "../persistence/gatewayConfigAdmin.js";
import { gatewayResourceId } from "../persistence/gatewayConfigIds.js";
import { requireAdminRole } from "./authz.js";
import { builder } from "./builder.js";
import { notFoundError, mapAdminError } from "./errors.js";
import {
  GatewayAccessProfile,
  GatewayApiKeyAccessProfileAssignment,
  GatewayCanonicalModel,
  GatewayLogicalModel,
  GatewayLogicalModelTarget,
  GatewayModelCatalogEntry,
  GatewayModelDeployment,
  GatewayModelGrant,
  GatewayProviderConnection,
  GatewayWireBinding
} from "./types/gatewayConfig.js";

const CreateGatewayProviderConnectionInput = builder.inputType("CreateGatewayProviderConnectionInput", {
  fields: (t) => ({
    provider: t.string({ required: true }),
    slug: t.string({ required: true }),
    name: t.string({ required: true }),
    adapterKind: t.string({ required: true }),
    authStyle: t.string({ required: true }),
    baseUrl: t.string({ required: true }),
    region: t.string(),
    secretRef: t.string(),
    secret: t.string(),
    adapterConfig: t.field({ type: "JSON" }),
    defaultHeaders: t.field({ type: "JSON" }),
    capabilities: t.field({ type: "JSON" }),
    enabled: t.boolean()
  })
});

const UpdateGatewayProviderConnectionInput = builder.inputType("UpdateGatewayProviderConnectionInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    name: t.string(),
    authStyle: t.string(),
    baseUrl: t.string(),
    region: t.string(),
    secretRef: t.string(),
    secret: t.string(),
    clearSecret: t.boolean(),
    adapterConfig: t.field({ type: "JSON" }),
    defaultHeaders: t.field({ type: "JSON" }),
    capabilities: t.field({ type: "JSON" })
  })
});

const CreateGatewayCanonicalModelInput = builder.inputType("CreateGatewayCanonicalModelInput", {
  fields: (t) => ({
    slug: t.string({ required: true }),
    name: t.string({ required: true }),
    vendor: t.string({ required: true }),
    family: t.string({ required: true }),
    release: t.string(),
    capabilities: t.field({ type: "JSON" }),
    enabled: t.boolean()
  })
});

const UpdateGatewayCanonicalModelInput = builder.inputType("UpdateGatewayCanonicalModelInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    name: t.string()
  })
});

const CreateGatewayModelDeploymentInput = builder.inputType("CreateGatewayModelDeploymentInput", {
  fields: (t) => ({
    slug: t.string({ required: true }),
    name: t.string({ required: true }),
    canonicalModelId: t.id({ required: true }),
    providerConnectionId: t.id({ required: true }),
    upstreamModelId: t.string({ required: true }),
    region: t.string(),
    config: t.field({ type: "JSON" }),
    capabilities: t.field({ type: "JSON" }),
    pricing: t.field({ type: "JSON" }),
    enabled: t.boolean()
  })
});

const UpdateGatewayModelDeploymentInput = builder.inputType("UpdateGatewayModelDeploymentInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    name: t.string(),
    upstreamModelId: t.string(),
    region: t.string(),
    config: t.field({ type: "JSON" }),
    capabilities: t.field({ type: "JSON" }),
    pricing: t.field({ type: "JSON" })
  })
});

const CreateGatewayWireBindingInput = builder.inputType("CreateGatewayWireBindingInput", {
  fields: (t) => ({
    deploymentId: t.id({ required: true }),
    apiWireId: t.string({ required: true }),
    endpointPath: t.string(),
    requestConfig: t.field({ type: "JSON" }),
    adapterContractVersion: t.string(),
    enabled: t.boolean()
  })
});

const UpdateGatewayWireBindingInput = builder.inputType("UpdateGatewayWireBindingInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    endpointPath: t.string(),
    requestConfig: t.field({ type: "JSON" }),
    adapterContractVersion: t.string()
  })
});

const CreateGatewayLogicalModelInitialTargetInput = builder.inputType(
  "CreateGatewayLogicalModelInitialTargetInput",
  {
    fields: (t) => ({
      deploymentId: t.id({ required: true }),
      priority: t.int({ required: true }),
      enabled: t.boolean({ required: true })
    })
  }
);

const CreateGatewayLogicalModelInput = builder.inputType("CreateGatewayLogicalModelInput", {
  fields: (t) => ({
    slug: t.string({ required: true }),
    name: t.string({ required: true }),
    description: t.string(),
    resolutionKind: t.string({ required: true }),
    routerConfig: t.field({ type: "JSON" }),
    enabled: t.boolean(),
    initialTarget: t.field({ type: CreateGatewayLogicalModelInitialTargetInput })
  })
});

const UpdateGatewayLogicalModelInput = builder.inputType("UpdateGatewayLogicalModelInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    name: t.string(),
    description: t.string(),
    resolutionKind: t.string(),
    routerConfig: t.field({ type: "JSON" })
  })
});

const CreateGatewayLogicalModelTargetInput = builder.inputType("CreateGatewayLogicalModelTargetInput", {
  fields: (t) => ({
    logicalModelId: t.id({ required: true }),
    deploymentId: t.id({ required: true }),
    priority: t.int({ required: true }),
    enabled: t.boolean()
  })
});

const UpdateGatewayLogicalModelTargetInput = builder.inputType("UpdateGatewayLogicalModelTargetInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    deploymentId: t.id(),
    priority: t.int()
  })
});

const CreateGatewayAccessProfileInput = builder.inputType("CreateGatewayAccessProfileInput", {
  fields: (t) => ({
    slug: t.string({ required: true }),
    name: t.string({ required: true }),
    description: t.string(),
    limits: t.field({ type: "JSON" }),
    enabled: t.boolean()
  })
});

const UpdateGatewayAccessProfileInput = builder.inputType("UpdateGatewayAccessProfileInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    name: t.string(),
    description: t.string(),
    limits: t.field({ type: "JSON" })
  })
});

const CreateGatewayModelGrantInput = builder.inputType("CreateGatewayModelGrantInput", {
  fields: (t) => ({
    accessProfileId: t.id({ required: true }),
    logicalModelId: t.id({ required: true }),
    allowedOperations: t.stringList({ required: true }),
    parameterCaps: t.field({ type: "JSON" }),
    enabled: t.boolean()
  })
});

const UpdateGatewayModelGrantInput = builder.inputType("UpdateGatewayModelGrantInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    allowedOperations: t.stringList(),
    parameterCaps: t.field({ type: "JSON" })
  })
});

builder.queryFields((t) => ({
  gatewayProviderConnections: t.field({
    type: [GatewayProviderConnection],
    resolve: (_root, _args, context) => gatewayAdmin(context).providerConnections(gatewayScope(context))
  }),
  gatewayProviderConnection: t.field({
    type: GatewayProviderConnection,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args, context) => gatewayAdmin(context).providerConnection(gatewayScope(context), String(args.id))
  }),
  gatewayCanonicalModels: t.field({
    type: [GatewayCanonicalModel],
    resolve: (_root, _args, context) => gatewayAdmin(context).canonicalModels(gatewayScope(context))
  }),
  gatewayCanonicalModel: t.field({
    type: GatewayCanonicalModel,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args, context) => gatewayAdmin(context).canonicalModel(gatewayScope(context), String(args.id))
  }),
  gatewayModelDeployments: t.field({
    type: [GatewayModelDeployment],
    resolve: (_root, _args, context) => gatewayAdmin(context).modelDeployments(gatewayScope(context))
  }),
  gatewayModelCatalogEntries: t.field({
    type: [GatewayModelCatalogEntry],
    resolve: (_root, _args, context) => gatewayAdmin(context).modelCatalogEntries(gatewayScope(context))
  }),
  gatewayModelCatalogEntry: t.field({
    type: GatewayModelCatalogEntry,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args, context) => gatewayAdmin(context).modelCatalogEntry(gatewayScope(context), String(args.id))
  }),
  gatewayModelDeployment: t.field({
    type: GatewayModelDeployment,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args, context) => gatewayAdmin(context).modelDeployment(gatewayScope(context), String(args.id))
  }),
  gatewayWireBindings: t.field({
    type: [GatewayWireBinding],
    resolve: (_root, _args, context) => gatewayAdmin(context).wireBindings(gatewayScope(context))
  }),
  gatewayWireBinding: t.field({
    type: GatewayWireBinding,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args, context) => gatewayAdmin(context).wireBinding(gatewayScope(context), String(args.id))
  }),
  gatewayLogicalModels: t.field({
    type: [GatewayLogicalModel],
    resolve: (_root, _args, context) => gatewayAdmin(context).logicalModels(gatewayScope(context))
  }),
  gatewayLogicalModel: t.field({
    type: GatewayLogicalModel,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args, context) => gatewayAdmin(context).logicalModel(gatewayScope(context), String(args.id))
  }),
  gatewayLogicalModelTargets: t.field({
    type: [GatewayLogicalModelTarget],
    resolve: (_root, _args, context) => gatewayAdmin(context).logicalModelTargets(gatewayScope(context))
  }),
  gatewayLogicalModelTarget: t.field({
    type: GatewayLogicalModelTarget,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args, context) => gatewayAdmin(context).logicalModelTarget(gatewayScope(context), String(args.id))
  }),
  gatewayAccessProfiles: t.field({
    type: [GatewayAccessProfile],
    resolve: (_root, _args, context) => gatewayAdmin(context).accessProfiles(gatewayScope(context))
  }),
  gatewayAccessProfile: t.field({
    type: GatewayAccessProfile,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args, context) => gatewayAdmin(context).accessProfile(gatewayScope(context), String(args.id))
  }),
  gatewayModelGrants: t.field({
    type: [GatewayModelGrant],
    resolve: (_root, _args, context) => gatewayAdmin(context).modelGrants(gatewayScope(context))
  }),
  gatewayModelGrant: t.field({
    type: GatewayModelGrant,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args, context) => gatewayAdmin(context).modelGrant(gatewayScope(context), String(args.id))
  })
}));

builder.mutationFields((t) => ({
  createGatewayProviderConnection: t.field({
    type: GatewayProviderConnection,
    args: { input: t.arg({ type: CreateGatewayProviderConnectionInput, required: true }) },
    resolve: async (_root, args, context) => {
      const body = defined({
        provider: args.input.provider,
        slug: args.input.slug,
        name: args.input.name,
        adapterKind: args.input.adapterKind,
        authStyle: args.input.authStyle,
        baseUrl: args.input.baseUrl,
        region: args.input.region ?? undefined,
        secretRef: args.input.secretRef ?? undefined,
        secret: args.input.secret ?? undefined,
        adapterConfig: args.input.adapterConfig ?? undefined,
        defaultHeaders: args.input.defaultHeaders ?? undefined,
        capabilities: args.input.capabilities ?? undefined,
        enabled: args.input.enabled ?? undefined
      });
      const id = await applyGatewayCommand(context, { resource: "providerConnection", action: "create", body });
      return requiredResult(await gatewayAdmin(context).providerConnection(gatewayScope(context), id));
    }
  }),
  updateGatewayProviderConnection: t.field({
    type: GatewayProviderConnection,
    args: { input: t.arg({ type: UpdateGatewayProviderConnectionInput, required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.input.id);
      const body = defined({
        name: args.input.name ?? undefined,
        authStyle: args.input.authStyle ?? undefined,
        baseUrl: args.input.baseUrl ?? undefined,
        region: args.input.region,
        secretRef: args.input.secretRef ?? undefined,
        secret: args.input.secret ?? undefined,
        clearSecret: args.input.clearSecret ?? undefined,
        adapterConfig: args.input.adapterConfig ?? undefined,
        defaultHeaders: args.input.defaultHeaders ?? undefined,
        capabilities: args.input.capabilities ?? undefined
      });
      await applyGatewayCommand(context, { resource: "providerConnection", action: "update", id, body });
      return requiredResult(await gatewayAdmin(context).providerConnection(gatewayScope(context), id));
    }
  }),
  resetGatewayProviderConnectionHealth: t.field({
    type: GatewayProviderConnection,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await applyGatewayCommand(context, { resource: "providerConnection", action: "resetHealth", id });
      return requiredResult(await gatewayAdmin(context).providerConnection(gatewayScope(context), id));
    }
  }),
  createGatewayCanonicalModel: t.field({
    type: GatewayCanonicalModel,
    args: { input: t.arg({ type: CreateGatewayCanonicalModelInput, required: true }) },
    resolve: async (_root, args, context) => {
      const body = defined({
        slug: args.input.slug,
        name: args.input.name,
        vendor: args.input.vendor,
        family: args.input.family,
        release: args.input.release ?? undefined,
        capabilities: args.input.capabilities ?? undefined,
        enabled: args.input.enabled ?? undefined
      });
      const id = await applyGatewayCommand(context, { resource: "canonicalModel", action: "create", body });
      return requiredResult(await gatewayAdmin(context).canonicalModel(gatewayScope(context), id));
    }
  }),
  updateGatewayCanonicalModel: t.field({
    type: GatewayCanonicalModel,
    args: { input: t.arg({ type: UpdateGatewayCanonicalModelInput, required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.input.id);
      await applyGatewayCommand(context, {
        resource: "canonicalModel",
        action: "update",
        id,
        body: defined({ name: args.input.name ?? undefined })
      });
      return requiredResult(await gatewayAdmin(context).canonicalModel(gatewayScope(context), id));
    }
  }),
  createGatewayModelDeployment: t.field({
    type: GatewayModelDeployment,
    args: { input: t.arg({ type: CreateGatewayModelDeploymentInput, required: true }) },
    resolve: async (_root, args, context) => {
      const body = defined({
        slug: args.input.slug,
        name: args.input.name,
        canonicalModelId: String(args.input.canonicalModelId),
        providerConnectionId: String(args.input.providerConnectionId),
        upstreamModelId: args.input.upstreamModelId,
        region: args.input.region ?? undefined,
        config: args.input.config ?? undefined,
        capabilities: args.input.capabilities ?? undefined,
        pricing: args.input.pricing ?? undefined,
        enabled: args.input.enabled ?? undefined
      });
      const id = await applyGatewayCommand(context, { resource: "modelDeployment", action: "create", body });
      return requiredResult(await gatewayAdmin(context).modelDeployment(gatewayScope(context), id));
    }
  }),
  updateGatewayModelDeployment: t.field({
    type: GatewayModelDeployment,
    args: { input: t.arg({ type: UpdateGatewayModelDeploymentInput, required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.input.id);
      const body = defined({
        name: args.input.name ?? undefined,
        upstreamModelId: args.input.upstreamModelId ?? undefined,
        region: args.input.region,
        config: args.input.config ?? undefined,
        capabilities: args.input.capabilities ?? undefined,
        pricing: args.input.pricing ?? undefined
      });
      await applyGatewayCommand(context, { resource: "modelDeployment", action: "update", id, body });
      return requiredResult(await gatewayAdmin(context).modelDeployment(gatewayScope(context), id));
    }
  }),
  resetGatewayModelDeploymentHealth: t.field({
    type: GatewayModelDeployment,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await applyGatewayCommand(context, { resource: "modelDeployment", action: "resetHealth", id });
      return requiredResult(await gatewayAdmin(context).modelDeployment(gatewayScope(context), id));
    }
  }),
  createGatewayWireBinding: t.field({
    type: GatewayWireBinding,
    args: { input: t.arg({ type: CreateGatewayWireBindingInput, required: true }) },
    resolve: async (_root, args, context) => {
      const body = defined({
        deploymentId: String(args.input.deploymentId),
        apiWireId: args.input.apiWireId,
        endpointPath: args.input.endpointPath,
        requestConfig: args.input.requestConfig ?? undefined,
        adapterContractVersion: args.input.adapterContractVersion ?? undefined,
        enabled: args.input.enabled ?? undefined
      });
      const id = await applyGatewayCommand(context, { resource: "wireBinding", action: "create", body });
      return requiredResult(await gatewayAdmin(context).wireBinding(gatewayScope(context), id));
    }
  }),
  updateGatewayWireBinding: t.field({
    type: GatewayWireBinding,
    args: { input: t.arg({ type: UpdateGatewayWireBindingInput, required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.input.id);
      const body = defined({
        endpointPath: args.input.endpointPath,
        requestConfig: args.input.requestConfig ?? undefined,
        adapterContractVersion: args.input.adapterContractVersion ?? undefined
      });
      await applyGatewayCommand(context, { resource: "wireBinding", action: "update", id, body });
      return requiredResult(await gatewayAdmin(context).wireBinding(gatewayScope(context), id));
    }
  }),
  createGatewayLogicalModel: t.field({
    type: GatewayLogicalModel,
    args: { input: t.arg({ type: CreateGatewayLogicalModelInput, required: true }) },
    resolve: async (_root, args, context) => {
      const body = defined({
        slug: args.input.slug,
        name: args.input.name,
        description: args.input.description,
        resolutionKind: args.input.resolutionKind,
        routerConfig: args.input.routerConfig ?? undefined,
        enabled: args.input.enabled ?? undefined
      });
      let id: string;
      if (args.input.initialTarget) {
        id = gatewayResourceId("logicalModel");
        const targetId = gatewayResourceId("logicalModelTarget");
        await applyGatewayCommands(context, [
          { resource: "logicalModel", action: "create", id, body },
          {
            resource: "logicalModelTarget",
            action: "create",
            id: targetId,
            body: {
              logicalModelId: id,
              deploymentId: String(args.input.initialTarget.deploymentId),
              priority: args.input.initialTarget.priority,
              enabled: args.input.initialTarget.enabled
            }
          }
        ]);
      } else {
        id = await applyGatewayCommand(context, { resource: "logicalModel", action: "create", body });
      }
      return requiredResult(await gatewayAdmin(context).logicalModel(gatewayScope(context), id));
    }
  }),
  updateGatewayLogicalModel: t.field({
    type: GatewayLogicalModel,
    args: { input: t.arg({ type: UpdateGatewayLogicalModelInput, required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.input.id);
      const body = defined({
        name: args.input.name ?? undefined,
        description: args.input.description,
        resolutionKind: args.input.resolutionKind ?? undefined,
        routerConfig: args.input.routerConfig ?? undefined
      });
      await applyGatewayCommand(context, { resource: "logicalModel", action: "update", id, body });
      return requiredResult(await gatewayAdmin(context).logicalModel(gatewayScope(context), id));
    }
  }),
  createGatewayLogicalModelTarget: t.field({
    type: GatewayLogicalModelTarget,
    args: { input: t.arg({ type: CreateGatewayLogicalModelTargetInput, required: true }) },
    resolve: async (_root, args, context) => {
      const body = defined({
        logicalModelId: String(args.input.logicalModelId),
        deploymentId: String(args.input.deploymentId),
        priority: args.input.priority,
        enabled: args.input.enabled ?? undefined
      });
      const id = await applyGatewayCommand(context, { resource: "logicalModelTarget", action: "create", body });
      return requiredResult(await gatewayAdmin(context).logicalModelTarget(gatewayScope(context), id));
    }
  }),
  updateGatewayLogicalModelTarget: t.field({
    type: GatewayLogicalModelTarget,
    args: { input: t.arg({ type: UpdateGatewayLogicalModelTargetInput, required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.input.id);
      const body = defined({
        deploymentId: args.input.deploymentId ? String(args.input.deploymentId) : undefined,
        priority: args.input.priority ?? undefined
      });
      await applyGatewayCommand(context, { resource: "logicalModelTarget", action: "update", id, body });
      return requiredResult(await gatewayAdmin(context).logicalModelTarget(gatewayScope(context), id));
    }
  }),
  createGatewayAccessProfile: t.field({
    type: GatewayAccessProfile,
    args: { input: t.arg({ type: CreateGatewayAccessProfileInput, required: true }) },
    resolve: async (_root, args, context) => {
      const body = defined({
        slug: args.input.slug,
        name: args.input.name,
        description: args.input.description,
        limits: args.input.limits ?? undefined,
        enabled: args.input.enabled ?? undefined
      });
      const id = await applyGatewayCommand(context, { resource: "accessProfile", action: "create", body });
      return requiredResult(await gatewayAdmin(context).accessProfile(gatewayScope(context), id));
    }
  }),
  updateGatewayAccessProfile: t.field({
    type: GatewayAccessProfile,
    args: { input: t.arg({ type: UpdateGatewayAccessProfileInput, required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.input.id);
      const body = defined({
        name: args.input.name ?? undefined,
        description: args.input.description,
        limits: args.input.limits ?? undefined
      });
      await applyGatewayCommand(context, { resource: "accessProfile", action: "update", id, body });
      return requiredResult(await gatewayAdmin(context).accessProfile(gatewayScope(context), id));
    }
  }),
  createGatewayModelGrant: t.field({
    type: GatewayModelGrant,
    args: { input: t.arg({ type: CreateGatewayModelGrantInput, required: true }) },
    resolve: async (_root, args, context) => {
      const body = defined({
        accessProfileId: String(args.input.accessProfileId),
        logicalModelId: String(args.input.logicalModelId),
        allowedOperations: args.input.allowedOperations,
        parameterCaps: args.input.parameterCaps ?? undefined,
        enabled: args.input.enabled ?? undefined
      });
      const id = await applyGatewayCommand(context, { resource: "modelGrant", action: "create", body });
      return requiredResult(await gatewayAdmin(context).modelGrant(gatewayScope(context), id));
    }
  }),
  updateGatewayModelGrant: t.field({
    type: GatewayModelGrant,
    args: { input: t.arg({ type: UpdateGatewayModelGrantInput, required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.input.id);
      const body = defined({
        allowedOperations: args.input.allowedOperations ?? undefined,
        parameterCaps: args.input.parameterCaps ?? undefined
      });
      await applyGatewayCommand(context, { resource: "modelGrant", action: "update", id, body });
      return requiredResult(await gatewayAdmin(context).modelGrant(gatewayScope(context), id));
    }
  }),
  enableGatewayProviderConnection: t.field({
    type: GatewayProviderConnection,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "providerConnection", id, true);
      return requiredResult(await gatewayAdmin(context).providerConnection(gatewayScope(context), id));
    }
  }),
  disableGatewayProviderConnection: t.field({
    type: GatewayProviderConnection,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "providerConnection", id, false);
      return requiredResult(await gatewayAdmin(context).providerConnection(gatewayScope(context), id));
    }
  }),
  enableGatewayCanonicalModel: t.field({
    type: GatewayCanonicalModel,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "canonicalModel", id, true);
      return requiredResult(await gatewayAdmin(context).canonicalModel(gatewayScope(context), id));
    }
  }),
  disableGatewayCanonicalModel: t.field({
    type: GatewayCanonicalModel,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "canonicalModel", id, false);
      return requiredResult(await gatewayAdmin(context).canonicalModel(gatewayScope(context), id));
    }
  }),
  enableGatewayModelDeployment: t.field({
    type: GatewayModelDeployment,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "modelDeployment", id, true);
      return requiredResult(await gatewayAdmin(context).modelDeployment(gatewayScope(context), id));
    }
  }),
  disableGatewayModelDeployment: t.field({
    type: GatewayModelDeployment,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "modelDeployment", id, false);
      return requiredResult(await gatewayAdmin(context).modelDeployment(gatewayScope(context), id));
    }
  }),
  enableGatewayWireBinding: t.field({
    type: GatewayWireBinding,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "wireBinding", id, true);
      return requiredResult(await gatewayAdmin(context).wireBinding(gatewayScope(context), id));
    }
  }),
  disableGatewayWireBinding: t.field({
    type: GatewayWireBinding,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "wireBinding", id, false);
      return requiredResult(await gatewayAdmin(context).wireBinding(gatewayScope(context), id));
    }
  }),
  enableGatewayLogicalModel: t.field({
    type: GatewayLogicalModel,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "logicalModel", id, true);
      return requiredResult(await gatewayAdmin(context).logicalModel(gatewayScope(context), id));
    }
  }),
  disableGatewayLogicalModel: t.field({
    type: GatewayLogicalModel,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "logicalModel", id, false);
      return requiredResult(await gatewayAdmin(context).logicalModel(gatewayScope(context), id));
    }
  }),
  enableGatewayLogicalModelTarget: t.field({
    type: GatewayLogicalModelTarget,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "logicalModelTarget", id, true);
      return requiredResult(await gatewayAdmin(context).logicalModelTarget(gatewayScope(context), id));
    }
  }),
  disableGatewayLogicalModelTarget: t.field({
    type: GatewayLogicalModelTarget,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "logicalModelTarget", id, false);
      return requiredResult(await gatewayAdmin(context).logicalModelTarget(gatewayScope(context), id));
    }
  }),
  enableGatewayAccessProfile: t.field({
    type: GatewayAccessProfile,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "accessProfile", id, true);
      return requiredResult(await gatewayAdmin(context).accessProfile(gatewayScope(context), id));
    }
  }),
  disableGatewayAccessProfile: t.field({
    type: GatewayAccessProfile,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "accessProfile", id, false);
      return requiredResult(await gatewayAdmin(context).accessProfile(gatewayScope(context), id));
    }
  }),
  enableGatewayModelGrant: t.field({
    type: GatewayModelGrant,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "modelGrant", id, true);
      return requiredResult(await gatewayAdmin(context).modelGrant(gatewayScope(context), id));
    }
  }),
  disableGatewayModelGrant: t.field({
    type: GatewayModelGrant,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const id = String(args.id);
      await setGatewayResourceEnabled(context, "modelGrant", id, false);
      return requiredResult(await gatewayAdmin(context).modelGrant(gatewayScope(context), id));
    }
  }),
  assignGatewayApiKeyAccessProfile: t.field({
    type: GatewayApiKeyAccessProfileAssignment,
    args: {
      apiKeyId: t.arg.id({ required: true }),
      accessProfileId: t.arg.id({ required: true })
    },
    resolve: async (_root, args, context) => {
      const apiKeyId = String(args.apiKeyId);
      const accessProfileId = String(args.accessProfileId);
      await applyGatewayCommand(context, {
        resource: "apiKey",
        action: "assignAccessProfile",
        id: apiKeyId,
        accessProfileId
      });
      return { apiKeyId, accessProfileId };
    }
  })
}));

function gatewayAdmin(context: GraphQLContext) {
  if (!context.persistence) throw notFoundError("gateway_config_not_found");
  return context.persistence.gatewayConfigAdmin;
}

function gatewayScope(context: GraphQLContext) {
  const identity = requireAdminRole(context);
  return {
    organizationId: identity.organizationId,
    workspaceId: identity.workspaceId
  };
}

async function applyGatewayCommand(context: GraphQLContext, command: GatewayConfigCommand) {
  const [result] = await applyGatewayCommands(context, [command]);
  if (!result) throw new Error("gateway_config_command_result_missing");
  return result.id;
}

async function applyGatewayCommands(context: GraphQLContext, commands: GatewayConfigCommand[]) {
  const identity = requireAdminRole(context);
  try {
    return await gatewayAdmin(context).applyCommands({
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId,
      actorUserId: identity.userId,
      commands
    });
  } catch (error) {
    mapAdminError(error);
  }
}

function setGatewayResourceEnabled(
  context: GraphQLContext,
  resource: GatewayConfigResource,
  id: string,
  enabled: boolean
) {
  return applyGatewayCommand(context, { resource, action: "setEnabled", id, enabled });
}

function requiredResult<T>(value: T | null): T {
  if (!value) throw notFoundError("gateway_config_not_found");
  return value;
}

function defined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
