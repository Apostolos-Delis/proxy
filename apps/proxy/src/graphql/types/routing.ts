import { builder } from "../builder.js";
import type { ApiKeyAccessProfileRefModel, ApiKeyModel } from "../models.js";

export const ApiKeyAccessProfileRef = builder
  .objectRef<ApiKeyAccessProfileRefModel>("ApiKeyAccessProfileRef")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      name: t.exposeString("name", { nullable: true }),
      status: t.exposeString("status", { nullable: true })
    })
  });

export const ApiKey = builder.objectRef<ApiKeyModel>("ApiKey").implement({
  fields: (t) => ({
    id: t.exposeString("id"),
    organizationId: t.exposeString("organizationId"),
    userId: t.exposeString("userId", { nullable: true }),
    name: t.exposeString("name"),
    accessProfileId: t.exposeString("accessProfileId", { nullable: true }),
    accessProfile: t.field({
      type: ApiKeyAccessProfileRef,
      nullable: true,
      resolve: (key) => key.accessProfile
    }),
    createdAt: t.exposeString("createdAt"),
    expiresAt: t.exposeString("expiresAt", { nullable: true }),
    revokedAt: t.exposeString("revokedAt", { nullable: true }),
    lastUsedAt: t.exposeString("lastUsedAt", { nullable: true })
  })
});

export type CreateApiKeyResultModel = {
  apiKey: ApiKeyModel | null;
  secret: string;
};

export const CreateApiKeyResult = builder
  .objectRef<CreateApiKeyResultModel>("CreateApiKeyResult")
  .implement({
    fields: (t) => ({
      apiKey: t.field({ type: ApiKey, nullable: true, resolve: (result) => result.apiKey }),
      secret: t.exposeString("secret")
    })
  });
