import {
  apiKeyProviderAccounts,
  decryptSecret,
  providerAccounts,
  type PromptProxyDbSession
} from "@prompt-proxy/db";
import { PROVIDER_ACCOUNT_STATUSES } from "@prompt-proxy/schema";
import { and, eq } from "drizzle-orm";

import type { Provider, UpstreamCredential } from "../types.js";

type CacheEntry = {
  credential: UpstreamCredential;
  expiresAt: number;
};

const CACHE_TTL_MS = 30_000;

export type ResolveCredentialInput = {
  organizationId: string;
  apiKeyId?: string;
  provider: Provider;
};

export class ProviderCredentialStore {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: PromptProxyDbSession,
    private readonly encryptionKey: string | undefined
  ) {}

  async resolveForRequest(input: ResolveCredentialInput, now = Date.now()): Promise<UpstreamCredential | undefined> {
    if (!input.apiKeyId) return undefined;

    const [binding] = await this.db
      .select({ providerAccountId: apiKeyProviderAccounts.providerAccountId })
      .from(apiKeyProviderAccounts)
      .where(and(
        eq(apiKeyProviderAccounts.organizationId, input.organizationId),
        eq(apiKeyProviderAccounts.apiKeyId, input.apiKeyId),
        eq(apiKeyProviderAccounts.provider, input.provider)
      ))
      .limit(1);
    if (!binding) return undefined;

    const cached = this.cache.get(binding.providerAccountId);
    if (cached && cached.expiresAt > now) return cached.credential;

    const [account] = await this.db
      .select()
      .from(providerAccounts)
      .where(and(
        eq(providerAccounts.organizationId, input.organizationId),
        eq(providerAccounts.id, binding.providerAccountId)
      ))
      .limit(1);
    if (!account) return undefined;
    if (account.status !== PROVIDER_ACCOUNT_STATUSES.ACTIVE) return undefined;
    if (account.provider !== input.provider) return undefined;
    if (account.authType !== "api_key" || !account.secretCiphertext) return undefined;
    if (!this.encryptionKey) {
      throw new Error("provider_secret_encryption_key_missing");
    }

    const token = decryptSecret(account.secretCiphertext, this.encryptionKey);
    const credential: UpstreamCredential = {
      provider: account.provider,
      token,
      providerAccountId: account.id
    };
    this.cache.set(account.id, { credential, expiresAt: now + CACHE_TTL_MS });

    await this.db
      .update(providerAccounts)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(providerAccounts.id, account.id));

    return credential;
  }
}
