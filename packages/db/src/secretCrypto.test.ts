import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, secretHint, SecretCryptoError } from "./secretCrypto.js";

const key = randomBytes(32).toString("base64");

describe("secretCrypto", () => {
  it("round-trips a secret", () => {
    const secret = "sk-ant-api03-abcdef123456";
    const blob = encryptSecret(secret, key);
    expect(blob).not.toContain(secret);
    expect(blob.startsWith("v1:")).toBe(true);
    expect(decryptSecret(blob, key)).toBe(secret);
  });

  it("produces a distinct ciphertext each time (random IV)", () => {
    const secret = "sk-ant-api03-abcdef123456";
    expect(encryptSecret(secret, key)).not.toBe(encryptSecret(secret, key));
  });

  it("fails to decrypt with a different key", () => {
    const blob = encryptSecret("top-secret", key);
    expect(() => decryptSecret(blob, randomBytes(32).toString("base64"))).toThrow();
  });

  it("fails to decrypt tampered ciphertext", () => {
    const blob = encryptSecret("top-secret", key);
    const parts = blob.split(":");
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${Buffer.from("evil").toString("base64")}`;
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it("rejects a key of the wrong length", () => {
    expect(() => encryptSecret("x", Buffer.alloc(16).toString("base64"))).toThrow(SecretCryptoError);
  });

  it("rejects a missing key", () => {
    expect(() => encryptSecret("x", "")).toThrow(SecretCryptoError);
  });

  it("masks a secret to its last four characters", () => {
    expect(secretHint("sk-ant-api03-abcdef1234")).toBe("••••1234");
    expect(secretHint("ab")).toBe("••••");
  });
});
