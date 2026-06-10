import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class SecretCryptoError extends Error {}

function loadKey(keyB64: string) {
  if (!keyB64) {
    throw new SecretCryptoError("provider_secret_encryption_key_missing");
  }
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new SecretCryptoError("provider_secret_encryption_key_invalid");
  }
  return key;
}

export function encryptSecret(plaintext: string, keyB64: string) {
  const key = loadKey(keyB64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(blob: string, keyB64: string) {
  const key = loadKey(keyB64);
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretCryptoError("provider_secret_ciphertext_invalid");
  }
  const [, ivB64, tagB64, ciphertextB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}

export function secretHint(plaintext: string) {
  const trimmed = plaintext.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}
