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

export type ProviderCredentialOptions = {
  encryptionKey: string | undefined;
  subscriptionOAuthEnabled: boolean;
};

export class ProviderCredentialStore {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: PromptProxyDbSession,
    private readonly options: ProviderCredentialOptions
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
    if (!account.secretCiphertext) return undefined;
    // Fail closed on auth types this code predates: the column is plain text
    // and $type<> is compile-time only.
    if (account.authType !== "api_key" && account.authType !== "oauth") return undefined;
    // Cache-miss layer of the kill switch: disabled oauth accounts fall back
    // to the company key. headersFor re-checks the flag for cached credentials.
    if (account.authType === "oauth" && !this.options.subscriptionOAuthEnabled) return undefined;
    const chatgptAccountId = account.authType === "oauth" && account.provider === "openai"
      ? settingsString(account.settings, "chatgptAccountId")
      : undefined;
    if (account.authType === "oauth" && account.provider === "openai" && !chatgptAccountId) return undefined;
    if (!this.options.encryptionKey) {
      throw new Error("provider_secret_encryption_key_missing");
    }

    const token = decryptSecret(account.secretCiphertext, this.options.encryptionKey);
    const credential: UpstreamCredential = {
      provider: account.provider,
      token,
      providerAccountId: account.id,
      authType: account.authType,
      chatgptAccountId
    };
    this.cache.set(account.id, { credential, expiresAt: now + CACHE_TTL_MS });

    await this.db
      .update(providerAccounts)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(providerAccounts.id, account.id));

    return credential;
  }
}

function settingsString(settings: unknown, key: string) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;
  const value = (settings as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
