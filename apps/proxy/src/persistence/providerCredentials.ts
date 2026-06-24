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

const CACHE_TTL_MS = 30_000;
const OAUTH_REFRESH_SKEW_MS = 60_000;

export type ResolveCredentialInput = {
  organizationId: string;
  workspaceId?: string;
  apiKeyId?: string;
  provider: Provider;
};

export type ResolveProviderAccountCredentialInput = {
  organizationId: string;
  providerAccountId: string;
  providerId?: string;
};

export type ProviderCredentialOptions = {
  encryptionKey: string | undefined;
  subscriptionOAuthEnabled: boolean;
  allowedPrivateUpstreamCidrs: ProviderNetworkPolicy["allowedPrivateUpstreamCidrs"];
  fetcher?: typeof fetch;
};

export class ProviderCredentialStore {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: ProxyDbSession,
    private readonly options: ProviderCredentialOptions
  ) {}

  async resolveForRequest(input: ResolveCredentialInput, now = Date.now()): Promise<UpstreamCredential | undefined> {
    if (!input.apiKeyId) return undefined;
    const provider = await providerBySlug(this.db, input.organizationId, input.provider);
    if (!provider) return undefined;

    const [binding] = await this.db
      .select({ providerAccountId: apiKeyProviderAccounts.providerAccountId })
      .from(apiKeyProviderAccounts)
      .where(and(
        eq(apiKeyProviderAccounts.organizationId, input.organizationId),
        eq(apiKeyProviderAccounts.workspaceId, input.workspaceId ?? defaultWorkspaceId(input.organizationId)),
        eq(apiKeyProviderAccounts.apiKeyId, input.apiKeyId),
        eq(apiKeyProviderAccounts.providerId, provider.id)
      ))
      .limit(1);
    if (!binding) return undefined;

    const credential = await this.resolveAccount({
      organizationId: input.organizationId,
      providerAccountId: binding.providerAccountId,
      providerId: provider.id
    }, now);
    if (credential?.provider !== input.provider) return undefined;
    return credential;
  }

  async resolveAccount(input: ResolveProviderAccountCredentialInput, now = Date.now()): Promise<UpstreamCredential | undefined> {
    const cached = this.cache.get(input.providerAccountId);
    if (cached && cached.expiresAt > now) return cached.credential;

    const predicates = [
      eq(providerAccounts.organizationId, input.organizationId),
      eq(providerAccounts.id, input.providerAccountId)
    ];
    if (input.providerId) predicates.push(eq(providerAccounts.providerId, input.providerId));

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
      .where(and(...predicates))
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
    this.cache.set(account.id, { credential, expiresAt: now + CACHE_TTL_MS });

    await this.db
      .update(providerAccounts)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(providerAccounts.id, account.id));

    return credential;
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
