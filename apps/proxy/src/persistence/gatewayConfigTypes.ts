import type { ProxyTransaction } from "@proxy/db";

import type { ProviderNetworkPolicy } from "./providers.js";
import { AdminMutationError } from "./adminErrors.js";

export type GatewayConfigResource =
  | "providerConnection"
  | "canonicalModel"
  | "modelDeployment"
  | "wireBinding"
  | "logicalModel"
  | "logicalModelTarget"
  | "accessProfile"
  | "modelGrant";

export type GatewayConfigCommand =
  | { resource: GatewayConfigResource; action: "create"; body: unknown; id?: string }
  | { resource: GatewayConfigResource; action: "update"; id: string; body: unknown }
  | { resource: GatewayConfigResource; action: "setEnabled"; id: string; enabled: boolean }
  | { resource: "providerConnection" | "modelDeployment"; action: "resetHealth"; id: string }
  | { resource: "apiKey"; action: "assignAccessProfile"; id: string; accessProfileId: string };

export type GatewayConfigCommandResult = {
  resource: GatewayConfigResource | "apiKey";
  id: string;
};

export type GatewayConfigActor = {
  organizationId: string;
  workspaceId: string;
  actorUserId: string;
};

export type GatewayConfigScope = Omit<GatewayConfigActor, "actorUserId">;

export type GatewayConfigAdminOptions = ProviderNetworkPolicy & {
  encryptionKey?: string;
  secretReferenceSupported?: (input: {
    reference: string;
    provider: string;
    baseUrl: string;
  }) => boolean;
};

export type GatewayConfigMutationContext = {
  tx: ProxyTransaction;
  actor: GatewayConfigActor;
  options: GatewayConfigAdminOptions;
  deferredLogicalModelIds: ReadonlySet<string>;
  appendEvent: (
    scopeType: string,
    scopeId: string,
    action: string,
    payload: Record<string, unknown>,
    createdAt?: Date
  ) => Promise<void>;
};

export class GatewayConfigAdminError extends AdminMutationError {}
