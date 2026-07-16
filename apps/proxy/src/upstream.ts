import type { LookupFunction } from "node:net";

import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

import type { ProviderRegistryEndpoint, ProviderRegistryEntry } from "./persistence/providers.js";
import type { PinnedUpstreamAddress, UpstreamCredential } from "./types.js";

const pinnedDispatchers = new Map<string, Dispatcher>();

export function providerRequestUrl(input: {
  provider: ProviderRegistryEntry;
  endpoint: ProviderRegistryEndpoint;
  path?: string;
  credential?: UpstreamCredential;
}) {
  return `${providerRequestBaseUrl(input)}${input.path ?? providerEndpointPath(input.endpoint)}`;
}

export function providerRequestPinnedAddress(input: {
  provider: ProviderRegistryEntry;
  credential?: UpstreamCredential;
}) {
  const credential = credentialForProvider(input.provider, input.credential);
  if (credential?.baseUrl) return credential.pinnedAddress;
  return input.provider.pinnedAddress;
}

export function providerRequestRedirect(): RequestRedirect {
  return "manual";
}

export async function fetchWithPinnedAddress(
  url: string,
  init: RequestInit,
  pinnedAddress?: PinnedUpstreamAddress
) {
  if (!pinnedAddress) return fetch(url, init);
  const pinnedInit = {
    ...init,
    dispatcher: dispatcherForPinnedAddress(pinnedAddress)
  } as unknown as NonNullable<Parameters<typeof undiciFetch>[1]> & { dispatcher: Dispatcher };
  return undiciFetch(url, pinnedInit) as unknown as Promise<Response>;
}

export function lookupForPinnedAddress(pinnedAddress: PinnedUpstreamAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pinnedAddress.address, family: pinnedAddress.family }]);
      return;
    }
    callback(null, pinnedAddress.address, pinnedAddress.family);
  };
}

function providerRequestBaseUrl(input: {
  provider: ProviderRegistryEntry;
  credential?: UpstreamCredential;
}) {
  const credential = credentialForProvider(input.provider, input.credential);
  return credential?.baseUrl ?? input.provider.baseUrl;
}

function credentialForProvider(
  provider: ProviderRegistryEntry,
  credential: UpstreamCredential | undefined
) {
  return credential?.provider === provider.slug ? credential : undefined;
}

function providerEndpointPath(endpoint: ProviderRegistryEndpoint) {
  if ("path" in endpoint) return endpoint.path;
  throw new Error("provider_endpoint_path_unavailable");
}

function dispatcherForPinnedAddress(pinnedAddress: PinnedUpstreamAddress) {
  const key = `${pinnedAddress.hostname}/${pinnedAddress.address}/${pinnedAddress.family}`;
  const existing = pinnedDispatchers.get(key);
  if (existing) return existing;
  const dispatcher = new Agent({
    connect: { lookup: lookupForPinnedAddress(pinnedAddress) }
  });
  pinnedDispatchers.set(key, dispatcher);
  return dispatcher;
}
