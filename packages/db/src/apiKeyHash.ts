import { createHash } from "node:crypto";

export function hashApiKey(secret: string) {
  return `sha256:${createHash("sha256").update(secret).digest("hex")}`;
}
