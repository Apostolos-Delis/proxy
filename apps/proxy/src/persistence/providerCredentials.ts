import {
  apiKeyProviderAccounts,
  defaultWorkspaceId,
  decryptSecret,
  encryptSecret,
  providers,
  providerAccounts,
  type ProxyDbSession
} from "@proxy/db";
import { PROVIDER_ACCOUNT_STATUSES, PROVIDERS } from "@proxy/schema";
import { and, eq, isNull } from "drizzle-orm";

import type { Provider, UpstreamCredential } from "../types.js";
import {
  parseOpenAIChatGPTSecret,
  refreshOpenAIChatGPTTokenBundle,
  stringifyOpenAIChatGPTTokenBundle
} from "../openAIChatGPTAuth.js";
import {
  validateProviderBaseUrl,
  type ProviderNetworkPolicy
} from "./providers.js";

type CacheEntry = {
  credential: UpstreamCredential;
  expiresAt: number;
};

type BindingCacheEntry = {
  providerAccountId: string | null;
  expiresAt: number;
};

const CREDENTIAL_CACHE_TTL_MS = 30_000;
const BINDING_CACHE_TTL_MS = 5_000;
const MAX_CACHE_ENTRIES = 1000;
const OAUTH_REFRESH_SKEW_MS = 60_000;

export type ResolveCredentialInput = {
  organizationId: string;
  workspaceId?: string;
  apiKeyId?: string;
  provider: Provider;
};

export type ResolveProviderAccountCredentialInput = {
  organizationId: string;
  provider?: Provider;
  providerAccountId: string;
};

export type ProviderCredentialOptions = {
  encryptionKey: string | undefined;
  subscriptionOAuthEnabled: boolean;
  allowedPrivateUpstreamCidrs: ProviderNetworkPolicy["allowedPrivateUpstreamCidrs"];
  fetcher?: typeof fetch;
};

export class ProviderCredentialStore {
  private readonly credentialCache = new Map<string, CacheEntry>();
  private readonly bindingCache = new Map<string, BindingCacheEntry>();

  constructor(
    private readonly db: ProxyDbSession,
    private readonly options: ProviderCredentialOptions
  ) {}

  clearCache() {
    this.credentialCache.clear();
    this.bindingCache.clear();
  }

  async resolveForRequest(input: ResolveCredentialInput, now = Date.now()): Promise<UpstreamCredential | undefined> {
    const apiKeyId = input.apiKeyId;
    if (!apiKeyId) return undefined;

    const provider = await providerBySlug(this.db, input.organizationId, input.provider);
    if (!provider) return undefined;

    const providerAccountId = await this.providerAccountId({ ...input, apiKeyId, providerId: provider.id }, now);
    if (!providerAccountId) return undefined;

    return this.resolveAccount({
      organizationId: input.organizationId,
      provider: input.provider,
      providerAccountId
    }, now);
  }

  async resolveAccount(
    input: ResolveProviderAccountCredentialInput,
    now = Date.now()
  ): Promise<UpstreamCredential | undefined> {
    const cached = this.credentialCache.get(input.providerAccountId);
    if (cached && cached.expiresAt > now && (!input.provider || cached.credential.provider === input.provider)) {
      return { ...cached.credential };
    }
    if (cached) this.credentialCache.delete(input.providerAccountId);

    const [account] = await this.db
      .select({
        id: providerAccounts.id,
        providerId: providerAccounts.providerId,
        provider: providers.slug,
        baseUrl: providerAccounts.baseUrl,
        status: providerAccounts.status,
        authType: providerAccounts.authType,
        settings: providerAccounts.settings,
        secretCiphertext: providerAccounts.secretCiphertext
      })
      .from(providerAccounts)
      .innerJoin(providers, eq(providers.id, providerAccounts.providerId))
      .where(and(
        eq(providerAccounts.organizationId, input.organizationId),
        eq(providerAccounts.id, input.providerAccountId),
        input.provider ? eq(providers.slug, input.provider) : undefined
      ))
      .limit(1);
    if (!account) return undefined;
    if (account.status !== PROVIDER_ACCOUNT_STATUSES.ACTIVE) return undefined;
    if (!account.secretCiphertext) return undefined;
    // Fail closed on auth types this code predates: the column is plain text
    // and $type<> is compile-time only.
    if (account.authType !== "api_key" && account.authType !== "oauth") return undefined;
    // Cache-miss layer of the Anthropic kill switch: disabled oauth accounts
    // fall back to the company key. headersFor re-checks the flag for cached
    // credentials.
    if (
      account.authType === "oauth" &&
      account.provider === PROVIDERS.ANTHROPIC &&
      !this.options.subscriptionOAuthEnabled
    ) return undefined;
    const chatgptAccountId = account.authType === "oauth" && account.provider === PROVIDERS.OPENAI
      ? settingsString(account.settings, "chatgptAccountId")
      : undefined;
    if (account.authType === "oauth" && account.provider === PROVIDERS.OPENAI && !chatgptAccountId) return undefined;
    if (!this.options.encryptionKey) {
      throw new Error("provider_secret_encryption_key_missing");
    }

    let token = decryptSecret(account.secretCiphertext, this.options.encryptionKey);
    if (account.authType === "oauth" && account.provider === PROVIDERS.OPENAI) {
      token = await this.openAIChatGPTAccessToken({
        providerAccountId: account.id,
        encryptedSecret: account.secretCiphertext,
        decryptedSecret: token,
        now
      });
    }
    const baseUrl = account.baseUrl ? trimTrailingSlash(account.baseUrl) : undefined;
    const pinnedAddress = baseUrl
      ? await validateProviderBaseUrl(baseUrl, this.options)
      : undefined;
    const credential: UpstreamCredential = {
      provider: account.provider as Provider,
      token,
      providerAccountId: account.id,
      authType: account.authType,
      chatgptAccountId,
      baseUrl,
      pinnedAddress
    };
    setCacheEntry(this.credentialCache, account.id, {
      credential: { ...credential },
      expiresAt: now + CREDENTIAL_CACHE_TTL_MS
    });

    await this.db
      .update(providerAccounts)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(providerAccounts.id, account.id));

    return { ...credential };
  }

  private async providerAccountId(input: ResolveCredentialInput & { apiKeyId: string; providerId: string }, now: number) {
    const key = bindingCacheKey(input);
    const cached = this.bindingCache.get(key);
    if (cached && cached.expiresAt > now) return cached.providerAccountId ?? undefined;
    if (cached) this.bindingCache.delete(key);

    const [binding] = await this.db
      .select({ providerAccountId: apiKeyProviderAccounts.providerAccountId })
      .from(apiKeyProviderAccounts)
      .where(and(
        eq(apiKeyProviderAccounts.organizationId, input.organizationId),
        eq(apiKeyProviderAccounts.workspaceId, input.workspaceId ?? defaultWorkspaceId(input.organizationId)),
        eq(apiKeyProviderAccounts.apiKeyId, input.apiKeyId),
        eq(apiKeyProviderAccounts.providerId, input.providerId)
      ))
      .limit(1);

    const providerAccountId = binding?.providerAccountId ?? null;
    setCacheEntry(this.bindingCache, key, {
      providerAccountId,
      expiresAt: now + BINDING_CACHE_TTL_MS
    });
    return providerAccountId ?? undefined;
  }

  private async openAIChatGPTAccessToken(input: {
    providerAccountId: string;
    encryptedSecret: string;
    decryptedSecret: string;
    now: number;
  }) {
    const parsed = parseOpenAIChatGPTSecret(input.decryptedSecret);
    if (parsed.kind === "access_token") return parsed.accessToken;
    if (parsed.bundle.expiresAt > input.now + OAUTH_REFRESH_SKEW_MS) {
      return parsed.bundle.accessToken;
    }

    let refreshed;
    try {
      refreshed = await refreshOpenAIChatGPTTokenBundle({
        bundle: parsed.bundle,
        now: input.now,
        fetcher: this.options.fetcher
      });
    } catch (error) {
      if (parsed.bundle.expiresAt > input.now) return parsed.bundle.accessToken;
      throw error;
    }
    const ciphertext = encryptSecret(stringifyOpenAIChatGPTTokenBundle(refreshed), this.options.encryptionKey!);
    await this.db
      .update(providerAccounts)
      .set({ secretCiphertext: ciphertext, updatedAt: new Date(input.now) })
      .where(and(
        eq(providerAccounts.id, input.providerAccountId),
        eq(providerAccounts.secretCiphertext, input.encryptedSecret)
      ));
    return refreshed.accessToken;
  }
}

function settingsString(settings: unknown, key: string) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;
  const value = (settings as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

async function providerBySlug(db: ProxyDbSession, organizationId: string, slug: string) {
  const [orgProvider] = await db
    .select({ id: providers.id, slug: providers.slug })
    .from(providers)
    .where(and(
      eq(providers.organizationId, organizationId),
      eq(providers.slug, slug)
    ))
    .limit(1);
  if (orgProvider) return orgProvider;
  const [builtinProvider] = await db
    .select({ id: providers.id, slug: providers.slug })
    .from(providers)
    .where(and(
      eq(providers.slug, slug),
      isNull(providers.organizationId)
    ))
    .limit(1);
  return builtinProvider;
}

function bindingCacheKey(input: ResolveCredentialInput & { providerId?: string }) {
  return JSON.stringify([
    input.organizationId,
    input.workspaceId ?? defaultWorkspaceId(input.organizationId),
    input.apiKeyId ?? null,
    input.providerId ?? input.provider
  ]);
}

function setCacheEntry<Value>(
  cache: Map<string, Value>,
  key: string,
  value: Value
) {
  if (!cache.has(key) && cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, value);
}
