import { describe, expect, it } from "vitest";

import {
  classifyGenericHttpFetchError,
  classifyGenericHttpMalformedResponse,
  classifyGenericHttpResponse
} from "../src/providerAdapters/genericHttp.js";

describe("generic HTTP adapter classification", () => {
  it("classifies auth denied responses", () => {
    const unauthorized = classifyGenericHttpResponse({
      status: 401,
      headers: new Headers(),
      bodyText: JSON.stringify({ error: { message: "invalid api key" } })
    });
    const forbidden = classifyGenericHttpResponse({
      status: 403,
      headers: new Headers(),
      bodyText: JSON.stringify({ error: { message: "permission denied" } })
    });

    expect(unauthorized).toEqual(expect.objectContaining({
      category: "auth_denied",
      errorType: "auth_invalid",
      retryable: false,
      fatal: true,
      scope: "provider_connection"
    }));
    expect(forbidden).toEqual(expect.objectContaining({
      category: "auth_denied",
      errorType: "auth_invalid",
      retryable: false,
      fatal: true,
      scope: "provider_connection"
    }));
  });

  it("classifies rate limits and quota exhaustion", () => {
    const rateLimit = classifyGenericHttpResponse({
      status: 429,
      headers: new Headers({ "retry-after": "2" }),
      bodyText: JSON.stringify({ error: { message: "too many requests" } })
    });
    const quota = classifyGenericHttpResponse({
      status: 429,
      headers: new Headers(),
      bodyText: JSON.stringify({ error: { message: "insufficient_quota" } })
    });

    expect(rateLimit).toEqual(expect.objectContaining({
      category: "rate_limited",
      errorType: "rate_limited",
      retryable: true,
      fatal: false,
      cooldownMs: 2000
    }));
    expect(quota).toEqual(expect.objectContaining({
      category: "quota_exceeded",
      errorType: "quota_exhausted",
      retryable: true,
      fatal: false,
      scope: "provider_connection"
    }));
  });

  it("classifies provider 5xx failures", () => {
    const result = classifyGenericHttpResponse({
      status: 503,
      headers: new Headers(),
      bodyText: "upstream unavailable"
    });

    expect(result).toEqual(expect.objectContaining({
      category: "upstream_unavailable",
      errorType: "provider_unavailable",
      retryable: true,
      fatal: false,
      scope: "provider_connection"
    }));
  });

  it("classifies request shape failures", () => {
    const context = classifyGenericHttpResponse({
      status: 400,
      headers: new Headers(),
      bodyText: JSON.stringify({ error: { message: "context_length_exceeded" } })
    });
    const unsupported = classifyGenericHttpResponse({
      status: 400,
      headers: new Headers(),
      bodyText: JSON.stringify({ error: { message: "unsupported_parameter: temperature" } })
    });

    expect(context).toEqual(expect.objectContaining({
      category: "context_too_large",
      errorType: "context_overflow",
      retryable: false,
      fatal: true,
      scope: "request_only"
    }));
    expect(unsupported).toEqual(expect.objectContaining({
      category: "unsupported_request_shape",
      errorType: "request_incompatible",
      retryable: false,
      fatal: true,
      scope: "request_only"
    }));
  });

  it("classifies timeout and malformed upstream responses", () => {
    const timeout = classifyGenericHttpFetchError({
      error: new Error("Provider request cancelled."),
      timedOut: true
    });
    const malformed = classifyGenericHttpMalformedResponse({
      message: "SSE observer could not parse event data."
    });

    expect(timeout).toEqual(expect.objectContaining({
      category: "upstream_timeout",
      errorType: "unknown_transient",
      retryable: true,
      fatal: false,
      scope: "provider_connection"
    }));
    expect(malformed).toEqual(expect.objectContaining({
      category: "malformed_upstream_response",
      errorType: "stream_failed",
      retryable: true,
      fatal: false,
      scope: "request_only"
    }));
  });
});
