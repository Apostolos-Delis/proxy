import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { providers, type ProxyDbSession } from "@proxy/db";
import type { Dialect, Provider } from "@proxy/schema";
import { and, eq, isNull } from "drizzle-orm";

import type { AppConfig } from "../config.js";
import type { PinnedUpstreamAddress } from "../types.js";

export type ProviderRegistryEndpoint = {
  dialect: Dialect;
  path: string;
};

export type ProviderRegistryEntry = {
  id: string;
  organizationId: string | null;
  slug: Provider;
  baseUrl: string;
  authStyle: "bearer" | "x-api-key" | "none";
  endpoints: ProviderRegistryEndpoint[];
  defaultHeaders: Record<string, string>;
  capabilities: Record<string, unknown>;
  forwardHarnessHeaders: boolean;
  enabled: boolean;
  builtin: boolean;
  pinnedAddress?: PinnedUpstreamAddress;
};

export type ProviderRegistryResolver = {
  resolve(input: { organizationId: string; provider: Provider }): Promise<ProviderRegistryEntry | undefined>;
};

export function providerEndpointForDialect(provider: ProviderRegistryEntry, dialect: Dialect) {
  return provider.endpoints.find((endpoint) => endpoint.dialect === dialect);
}

export function operatorTokenForProvider(
  provider: Provider,
  config: Pick<AppConfig, "openaiApiKey" | "anthropicApiKey">
) {
  if (provider === "openai") return config.openaiApiKey;
  if (provider === "anthropic") return config.anthropicApiKey;
  return undefined;
}

export class ProviderRegistryError extends Error {
  constructor(
    readonly code: string,
    message = code
  ) {
    super(message);
  }
}

export type ProviderNetworkPolicy = Pick<AppConfig, "allowedPrivateUpstreamCidrs">;

export class ProviderRegistryStore implements ProviderRegistryResolver {
  constructor(
    private readonly db: ProxyDbSession,
    private readonly networkPolicy: ProviderNetworkPolicy
  ) {}

  async resolve(input: { organizationId: string; provider: Provider }) {
    const [orgProvider] = await this.db
      .select()
      .from(providers)
      .where(and(
        eq(providers.organizationId, input.organizationId),
        eq(providers.slug, input.provider)
      ))
      .limit(1);
    if (orgProvider) {
      const entry = providerEntry(orgProvider);
      assertSafeDefaultHeaders(entry.defaultHeaders);
      const pinnedAddress = await validateProviderBaseUrl(entry.baseUrl, this.networkPolicy);
      return { ...entry, pinnedAddress };
    }

    const [builtinProvider] = await this.db
      .select()
      .from(providers)
      .where(and(
        eq(providers.slug, input.provider),
        isNull(providers.organizationId)
      ))
      .limit(1);
    return builtinProvider ? providerEntry(builtinProvider) : undefined;
  }
}

export class ConfigProviderRegistry implements ProviderRegistryResolver {
  constructor(private readonly config: AppConfig) {}

  async resolve(input: { provider: Provider }) {
    if (input.provider === "openai") {
      return {
        id: "00000000-0000-0000-0000-000000000001",
        organizationId: null,
        slug: "openai",
        baseUrl: this.config.openaiBaseUrl,
        authStyle: "bearer" as const,
        endpoints: [
          { dialect: "openai-responses" as const, path: "/responses" },
          { dialect: "openai-chat" as const, path: "/chat/completions" }
        ],
        defaultHeaders: {},
        capabilities: { efforts: ["low", "medium", "high", "xhigh"] },
        forwardHarnessHeaders: true,
        enabled: true,
        builtin: true
      };
    }
    if (input.provider === "anthropic") {
      return {
        id: "00000000-0000-0000-0000-000000000002",
        organizationId: null,
        slug: "anthropic",
        baseUrl: this.config.anthropicBaseUrl,
        authStyle: "x-api-key" as const,
        endpoints: [
          { dialect: "anthropic-messages" as const, path: "/messages" }
        ],
        defaultHeaders: {},
        capabilities: { efforts: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
        forwardHarnessHeaders: true,
        enabled: true,
        builtin: true
      };
    }
    return undefined;
  }
}

function providerEntry(row: typeof providers.$inferSelect): ProviderRegistryEntry {
  return {
    id: row.id,
    organizationId: row.organizationId,
    slug: row.slug,
    baseUrl: trimProviderBaseUrl(row.baseUrl),
    authStyle: row.authStyle,
    endpoints: row.endpoints.filter(isProviderEndpoint),
    defaultHeaders: row.defaultHeaders,
    capabilities: row.capabilities,
    forwardHarnessHeaders: row.forwardHarnessHeaders,
    enabled: row.enabled,
    builtin: row.organizationId === null
  };
}

const authHeaderNames = new Set([
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "cookie",
  "host"
]);

export function assertSafeDefaultHeaders(headers: Record<string, string>) {
  for (const key of Object.keys(headers)) {
    if (authHeaderNames.has(key.toLowerCase())) {
      throw new ProviderRegistryError("provider_default_header_forbidden", `Default header '${key}' is not allowed.`);
    }
  }
}

export async function validateProviderBaseUrl(
  baseUrl: string,
  policy: ProviderNetworkPolicy
) {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProviderRegistryError("provider_base_url_invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderRegistryError("provider_base_url_scheme_forbidden");
  }

  const addresses = await addressesForHostname(url.hostname);
  if (addresses.length === 0) throw new ProviderRegistryError("provider_base_url_unresolvable");
  for (const address of addresses) {
    if (isBlockedAddress(address.address)) {
      throw new ProviderRegistryError("provider_base_url_blocked");
    }
    if (isPrivateAddress(address.address) && !isAllowedPrivateAddress(address.address, policy.allowedPrivateUpstreamCidrs)) {
      throw new ProviderRegistryError("provider_base_url_private");
    }
  }
  return {
    hostname: url.hostname,
    address: addresses[0].address,
    family: addresses[0].family
  } satisfies PinnedUpstreamAddress;
}

async function addressesForHostname(hostname: string) {
  const ipFamily = isIP(hostname);
  if (ipFamily) return [{ address: hostname, family: pinnedFamily(ipFamily) }];
  try {
    return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => ({
      address: entry.address,
      family: pinnedFamily(entry.family)
    }));
  } catch {
    throw new ProviderRegistryError("provider_base_url_unresolvable");
  }
}

function pinnedFamily(family: number): 4 | 6 {
  if (family === 4 || family === 6) return family;
  throw new ProviderRegistryError("provider_base_url_unresolvable");
}

function isBlockedAddress(address: string) {
  const version = isIP(address);
  if (version === 4) {
    return inIpv4Cidr(address, "169.254.0.0/16") ||
      inIpv4Cidr(address, "168.63.129.16/32") ||
      inIpv4Cidr(address, "100.100.100.200/32");
  }
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized.startsWith("fe80:");
}

function isPrivateAddress(address: string) {
  const version = isIP(address);
  if (version === 4) {
    return inIpv4Cidr(address, "10.0.0.0/8") ||
      inIpv4Cidr(address, "172.16.0.0/12") ||
      inIpv4Cidr(address, "192.168.0.0/16") ||
      inIpv4Cidr(address, "127.0.0.0/8") ||
      inIpv4Cidr(address, "100.64.0.0/10");
  }
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd");
}

function isAllowedPrivateAddress(address: string, cidrs: readonly string[]) {
  return cidrs.some((cidr) => addressMatchesCidr(address, cidr));
}

function addressMatchesCidr(address: string, cidr: string) {
  if (isIP(address) === 4) return inIpv4Cidr(address, cidr);
  return cidr === address;
}

function inIpv4Cidr(address: string, cidr: string) {
  const [range, bitsValue] = cidr.split("/");
  if (!range || isIP(range) !== 4 || isIP(address) !== 4) return false;
  const bits = bitsValue === undefined ? 32 : Number(bitsValue);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(range) & mask);
}

function ipv4ToInt(address: string) {
  return address.split(".").reduce((value, part) => ((value << 8) + Number(part)) >>> 0, 0);
}

function isProviderEndpoint(value: { dialect: string; path: string }): value is ProviderRegistryEndpoint {
  return (
    (value.dialect === "anthropic-messages" || value.dialect === "openai-responses" || value.dialect === "openai-chat") &&
    value.path.startsWith("/")
  );
}

export function trimProviderBaseUrl(value: string) {
  return value.replace(/\/+$/g, "");
}
