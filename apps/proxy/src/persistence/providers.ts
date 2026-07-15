import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

import { providers, type ProxyDbSession } from "@proxy/db";
import {
  providerCapabilitiesWithDefaults,
  type Dialect,
  type Provider,
  type ProviderAdapterKind,
  type ProviderAuthStyle,
  type ProviderCapabilities,
  type ProviderRegistryEndpoint as SchemaProviderRegistryEndpoint,
  type ProviderRegistryHttpEndpoint as SchemaProviderRegistryHttpEndpoint
} from "@proxy/schema";
import { and, eq, isNull } from "drizzle-orm";

import type { AppConfig } from "../config.js";
import type { PinnedUpstreamAddress } from "../types.js";

export type ProviderRegistryHttpEndpoint = SchemaProviderRegistryHttpEndpoint;
export type ProviderRegistryEndpoint = SchemaProviderRegistryEndpoint;

export type ProviderRegistryEntry = {
  id: string;
  organizationId: string | null;
  slug: Provider;
  baseUrl: string;
  adapterKind: ProviderAdapterKind;
  adapterConfig: Record<string, unknown>;
  authStyle: ProviderAuthStyle;
  endpoints: ProviderRegistryEndpoint[];
  defaultHeaders: Record<string, string>;
  capabilities: ProviderCapabilities;
  forwardHarnessHeaders: boolean;
  enabled: boolean;
  builtin: boolean;
  pinnedAddress?: PinnedUpstreamAddress;
};

export type ProviderRegistryResolver = {
  resolve(input: { organizationId: string; provider: Provider }): Promise<ProviderRegistryEntry | undefined>;
};

export function providerEndpointForDialect(provider: ProviderRegistryEntry, dialect: Dialect): ProviderRegistryHttpEndpoint | undefined {
  return provider.endpoints.find((endpoint): endpoint is ProviderRegistryHttpEndpoint =>
    "path" in endpoint && endpoint.dialect === dialect
  );
}

export function providerEndpointForAnyDialect(provider: ProviderRegistryEntry, dialect: Dialect): ProviderRegistryEndpoint | undefined {
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
        adapterKind: "generic-http-json" as const,
        adapterConfig: {},
        authStyle: "bearer" as const,
        endpoints: [
          { dialect: "openai-responses" as const, path: "/responses" },
          { dialect: "openai-chat" as const, path: "/chat/completions" }
        ],
        defaultHeaders: {},
        capabilities: providerCapabilitiesWithDefaults("openai", {
          efforts: ["low", "medium", "high", "xhigh"]
        }),
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
        adapterKind: "generic-http-json" as const,
        adapterConfig: {},
        authStyle: "x-api-key" as const,
        endpoints: [
          { dialect: "anthropic-messages" as const, path: "/messages" }
        ],
        defaultHeaders: {},
        capabilities: providerCapabilitiesWithDefaults("anthropic", {
          efforts: ["low", "medium", "high", "xhigh", "max", "ultracode"]
        }),
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
    adapterKind: row.adapterKind,
    adapterConfig: row.adapterConfig,
    authStyle: row.authStyle,
    endpoints: row.endpoints.filter(isProviderEndpoint),
    defaultHeaders: row.defaultHeaders,
    capabilities: providerCapabilitiesWithDefaults(row.slug, row.capabilities),
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
  "host",
  "aws-access-key-id",
  "aws-secret-access-key",
  "aws-session-token",
  "x-amz-content-sha256",
  "x-amz-credential",
  "x-amz-date",
  "x-amz-security-token",
  "x-amz-signature"
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
  const literal = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (ipaddr.isValid(literal)) return [canonicalPinnedAddress(literal)];
  try {
    return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => {
      pinnedFamily(entry.family);
      return canonicalPinnedAddress(entry.address);
    });
  } catch {
    throw new ProviderRegistryError("provider_base_url_unresolvable");
  }
}

function canonicalPinnedAddress(address: string): PinnedUpstreamAddress {
  let parsed = ipaddr.parse(address);
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }
  return {
    hostname: address,
    address: parsed.toString(),
    family: parsed.kind() === "ipv4" ? 4 : 6
  };
}

function pinnedFamily(family: number): 4 | 6 {
  if (family === 4 || family === 6) return family;
  throw new ProviderRegistryError("provider_base_url_unresolvable");
}

function isBlockedAddress(address: string) {
  const parsed = ipaddr.process(address);
  if (parsed.kind() === "ipv4" && (
    parsed.match(ipaddr.parseCIDR("168.63.129.16/32")) ||
    parsed.match(ipaddr.parseCIDR("100.100.100.200/32"))
  )) return true;
  return !new Set(["unicast", "private", "carrierGradeNat", "loopback", "uniqueLocal"])
    .has(parsed.range());
}

function isPrivateAddress(address: string) {
  return new Set(["private", "carrierGradeNat", "loopback", "uniqueLocal"])
    .has(ipaddr.process(address).range());
}

function isAllowedPrivateAddress(address: string, cidrs: readonly string[]) {
  return cidrs.some((cidr) => addressMatchesCidr(address, cidr));
}

function addressMatchesCidr(address: string, cidr: string) {
  try {
    const parsedAddress = ipaddr.process(address);
    const [range, bits] = ipaddr.parseCIDR(cidr);
    const parsedRange = range instanceof ipaddr.IPv6 && range.isIPv4MappedAddress()
      ? range.toIPv4Address()
      : range;
    return parsedAddress.kind() === parsedRange.kind() && parsedAddress.match(parsedRange, bits);
  } catch {
    return false;
  }
}

function isProviderEndpoint(value: {
  dialect?: unknown;
  path?: unknown;
  operation?: unknown;
}): value is ProviderRegistryEndpoint {
  if (
    (value.dialect === "anthropic-messages" || value.dialect === "openai-responses" || value.dialect === "openai-chat") &&
    typeof value.path === "string" &&
    value.path.startsWith("/")
  ) {
    return true;
  }
  return value.dialect === "bedrock-converse" &&
    (value.operation === "Converse" || value.operation === "ConverseStream");
}

export function trimProviderBaseUrl(value: string) {
  return value.replace(/\/+$/g, "");
}
