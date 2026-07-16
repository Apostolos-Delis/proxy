import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

import {
  type Dialect,
  type Provider,
  type ProviderAdapterKind,
  type ProviderAuthStyle,
  type ProviderCapabilities,
  type ProviderRegistryEndpoint as SchemaProviderRegistryEndpoint,
  type ProviderRegistryHttpEndpoint as SchemaProviderRegistryHttpEndpoint
} from "@proxy/schema";

import type { AppConfig } from "../config.js";
import { isProviderAdapterConfigValid } from "../providerAdapters/config.js";
import type { PinnedUpstreamAddress } from "../types.js";
import { isCredentialFieldName } from "./nonSecretConfig.js";

export type ProviderRegistryHttpEndpoint = SchemaProviderRegistryHttpEndpoint;
export type ProviderRegistryEndpoint = SchemaProviderRegistryEndpoint;

export type ProviderRegistryEntry = {
  id: string;
  organizationId: string | null;
  provider: Provider;
  slug: string;
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

export function providerEndpointForDialect(provider: ProviderRegistryEntry, dialect: Dialect): ProviderRegistryHttpEndpoint | undefined {
  return provider.endpoints.find((endpoint): endpoint is ProviderRegistryHttpEndpoint =>
    "path" in endpoint && endpoint.dialect === dialect
  );
}

export function providerEndpointForAnyDialect(provider: ProviderRegistryEntry, dialect: Dialect): ProviderRegistryEndpoint | undefined {
  return provider.endpoints.find((endpoint) => endpoint.dialect === dialect);
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

const authHeaderNames = new Set([
  "auth",
  "authentication",
  "authorization",
  "api-key",
  "apikey",
  "x-api-key",
  "x-auth",
  "x-authentication",
  "x-goog-api-key",
  "ocp-apim-subscription-key",
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
const reservedHeaderNames = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "expect",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export function assertProviderAdapterConfig(
  adapterKind: ProviderAdapterKind,
  adapterConfig: Record<string, unknown>
) {
  if (!isProviderAdapterConfigValid(adapterKind, adapterConfig)) {
    throw new ProviderRegistryError(
      "provider_adapter_config_invalid",
      "Adapter configuration contains fields not owned by the installed adapter."
    );
  }
}

export function assertSafeDefaultHeaders(headers: Record<string, string>) {
  try {
    new Headers(headers);
  } catch {
    throw new ProviderRegistryError(
      "provider_default_header_invalid",
      "Default headers must use valid HTTP names and values."
    );
  }
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (authHeaderNames.has(normalizedKey) || reservedHeaderNames.has(normalizedKey) || isCredentialFieldName(key, value)) {
      throw new ProviderRegistryError("provider_default_header_forbidden", `Default header '${key}' is not allowed.`);
    }
  }
}

export function validateProviderBaseUrlShape(baseUrl: string) {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProviderRegistryError("provider_base_url_invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderRegistryError("provider_base_url_scheme_forbidden");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderRegistryError("provider_base_url_credentials_forbidden");
  }
  return url;
}

export async function validateProviderBaseUrl(
  baseUrl: string,
  policy: ProviderNetworkPolicy
) {
  const url = validateProviderBaseUrlShape(baseUrl);

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

export function trimProviderBaseUrl(value: string) {
  return value.replace(/\/+$/g, "");
}
