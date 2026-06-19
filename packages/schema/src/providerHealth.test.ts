import { describe, expect, it } from "vitest";

import {
  PROVIDER_HEALTH_MESSAGE_MAX_CHARS,
  PROVIDER_HEALTH_METADATA_MAX_KEYS,
  PROVIDER_HEALTH_METADATA_STRING_MAX_CHARS,
  providerHealthClassificationSchema
} from "./index.js";

const validClassification = {
  errorType: "rate_limited",
  source: "provider_header",
  confidence: "exact",
  retryable: true,
  scope: "provider_account",
  cooldownUntil: "2026-06-18T12:00:00.000Z",
  message: "Provider returned a retry-after window.",
  metadata: {
    retryAfterSeconds: 60,
    header: "retry-after"
  }
};

describe("providerHealthClassificationSchema", () => {
  it("accepts a capped typed health classification", () => {
    expect(providerHealthClassificationSchema.parse(validClassification)).toEqual(validClassification);
  });

  it("defaults metadata when omitted", () => {
    const { metadata: _metadata, ...withoutMetadata } = validClassification;

    expect(providerHealthClassificationSchema.parse(withoutMetadata).metadata).toEqual({});
  });

  it("rejects arbitrary health error strings", () => {
    const result = providerHealthClassificationSchema.safeParse({
      ...validClassification,
      errorType: "provider_was_weird"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["errorType"]);
  });

  it("rejects arbitrary scope strings", () => {
    const result = providerHealthClassificationSchema.safeParse({
      ...validClassification,
      scope: "somewhere_else"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["scope"]);
  });

  it("rejects oversized messages and metadata strings", () => {
    const messageResult = providerHealthClassificationSchema.safeParse({
      ...validClassification,
      message: "a".repeat(PROVIDER_HEALTH_MESSAGE_MAX_CHARS + 1)
    });
    const metadataResult = providerHealthClassificationSchema.safeParse({
      ...validClassification,
      metadata: {
        value: "a".repeat(PROVIDER_HEALTH_METADATA_STRING_MAX_CHARS + 1)
      }
    });

    expect(messageResult.success).toBe(false);
    expect(messageResult.error?.issues[0]?.path).toEqual(["message"]);
    expect(metadataResult.success).toBe(false);
    expect(metadataResult.error?.issues[0]?.path).toEqual(["metadata", "value"]);
  });

  it("rejects oversized metadata maps", () => {
    const metadata = Object.fromEntries(
      Array.from({ length: PROVIDER_HEALTH_METADATA_MAX_KEYS + 1 }, (_, index) => [`key_${index}`, index])
    );
    const result = providerHealthClassificationSchema.safeParse({
      ...validClassification,
      metadata
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["metadata"]);
  });
});
