import { describe, expect, it } from "vitest";

import { BedrockCredentialResolverError } from "../src/providerAdapters/bedrockCredentials.js";
import { classifyBedrockError, parseBedrockErrorBody } from "../src/providerAdapters/bedrockErrors.js";

describe("Bedrock error classification", () => {
  it.each([
    [
      "auth missing",
      { error: new BedrockCredentialResolverError("bedrock_credential_secret_missing") },
      "auth_denied",
      "auth_invalid",
      "auth_missing",
      "provider_connection"
    ],
    [
      "auth denied",
      { error: { name: "UnrecognizedClientException", message: "The security token included in the request is invalid." }, status: 403 },
      "auth_denied",
      "auth_invalid",
      "auth_denied",
      "provider_connection"
    ],
    [
      "model access denied",
      { error: { name: "AccessDeniedException", message: "You are not authorized to invoke this model." }, status: 403 },
      "auth_denied",
      "model_access_denied",
      "model_access_denied",
      "deployment"
    ],
    [
      "stream permission denied",
      {
        message: "User is not authorized to perform bedrock:InvokeModelWithResponseStream",
        status: 403,
        operation: "ConverseStream" as const
      },
      "auth_denied",
      "model_access_denied",
      "stream_permission_denied",
      "deployment"
    ],
    [
      "rate limited",
      { error: { name: "ThrottlingException", message: "Rate exceeded." }, status: 429 },
      "rate_limited",
      "rate_limited",
      "rate_limited",
      "provider_connection"
    ],
    [
      "quota exceeded",
      { error: { name: "ServiceQuotaExceededException", message: "Service quota exceeded." }, status: 400 },
      "quota_exceeded",
      "quota_exhausted",
      "quota_exceeded",
      "provider_connection"
    ],
    [
      "context too large",
      { error: { name: "ValidationException", message: "Input is too long for the model context window." }, status: 400 },
      "context_too_large",
      "context_overflow",
      "context_too_large",
      "request_only"
    ],
    [
      "unsupported request shape",
      { error: { name: "ValidationException", message: "Unsupported request field: previous_response_id." }, status: 400 },
      "unsupported_request_shape",
      "request_incompatible",
      "unsupported_request_shape",
      "request_only"
    ],
    [
      "region unavailable",
      { error: { name: "UnknownEndpoint", message: "Region eu-mars-1 is not supported for Bedrock." } },
      "upstream_unavailable",
      "provider_unavailable",
      "region_unavailable",
      "provider_connection"
    ],
    [
      "model unavailable",
      { error: { name: "ResourceNotFoundException", message: "Model is not found." } },
      "upstream_unavailable",
      "model_unavailable",
      "model_unavailable",
      "deployment"
    ],
    [
      "guardrail intervention",
      { error: { name: "ValidationException", message: "Guardrail intervened and blocked the request." }, status: 400 },
      "unsupported_request_shape",
      "request_incompatible",
      "guardrail_intervention",
      "request_only"
    ],
    [
      "upstream timeout",
      { error: new Error("TimeoutError"), timedOut: true },
      "upstream_timeout",
      "unknown_transient",
      "upstream_timeout",
      "provider_connection"
    ]
  ])("classifies %s", (_name, input, category, errorType, bedrockErrorKind, scope) => {
    const result = classifyBedrockError({
      ...input,
      region: "us-east-1",
      model: "amazon.nova-pro-v1:0"
    });

    expect(result).toMatchObject({
      category,
      errorType,
      scope,
      metadata: {
        bedrockErrorKind,
        region: "us-east-1",
        model: "amazon.nova-pro-v1:0"
      }
    });
  });

  it("parses OpenAI-style and Bedrock-style error response bodies", () => {
    expect(parseBedrockErrorBody(JSON.stringify({
      error: {
        code: "ThrottlingException",
        message: "Rate exceeded."
      }
    }))).toEqual({
      name: "ThrottlingException",
      message: "Rate exceeded."
    });
    expect(parseBedrockErrorBody(JSON.stringify({
      __type: "ValidationException",
      message: "Unsupported request field."
    }))).toEqual({
      name: "ValidationException",
      message: "Unsupported request field."
    });
  });

  it("does not expose credential material for resolver errors", () => {
    const result = classifyBedrockError({
      error: new BedrockCredentialResolverError("bedrock_sdk_credential_resolution_failed"),
      region: "us-east-1"
    });

    expect(JSON.stringify(result)).not.toContain("AKIA");
    expect(JSON.stringify(result)).not.toContain("secretAccessKey");
  });
});
