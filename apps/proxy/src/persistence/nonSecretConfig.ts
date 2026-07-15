export class NonSecretConfigError extends Error {
  constructor(readonly field: string) {
    super(`Configuration field '${field}' cannot contain credential material.`);
  }
}

const modelTokenFields = new Set([
  "bostoken",
  "cachedtokens",
  "clstoken",
  "completiontokens",
  "contexttokens",
  "eostoken",
  "inputtokens",
  "masktoken",
  "maxcompletiontokens",
  "maxinputtokens",
  "maxoutputtokens",
  "maxtokens",
  "mintokens",
  "outputtokens",
  "padtoken",
  "prompttokens",
  "reasoningtokens",
  "septoken",
  "specialtokens",
  "stoptokens",
  "tokens",
  "totaltokens",
  "unktoken",
  "unknowntoken"
]);
const tokenCountSuffixes = [
  "cachedtokens",
  "completiontokens",
  "contexttokens",
  "inputtokens",
  "outputtokens",
  "prompttokens",
  "reasoningtokens",
  "totaltokens"
];
const materialQualifierPattern = /(?:b64urls?|b64|base64urls?|base64|blobs?|bytes?|data|ders?|files?|json|jwks?|materials?|paths?|pems?|references?|refs?|texts?|values?)$/;

export function assertSafeNonSecretConfig(config: Record<string, unknown>) {
  visitNonSecretConfig(config);
}

export function isCredentialFieldName(value: string, entry?: unknown) {
  if (typeof entry === "boolean" && /^(supports|allows|requires|uses)(?:[A-Z_]|-)/.test(value)) return false;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const base = stripMaterialQualifiers(normalized);
  const qualifiedCredentialMaterial = base !== normalized && /^(?:x)?(?:auth|authentication|private|secret|signing)$/.test(base);
  const modelTokenField = modelTokenFields.has(base) ||
    tokenCountSuffixes.some((suffix) => base.endsWith(suffix)) ||
    (typeof entry === "number" && base.endsWith("tokens"));
  const tokenMaterial = /(?:api|access|auth|bearer|client|csrf|device|id|identity|oauth|refresh|security|session|verification|webhook)tokens?$/.test(base) ||
    ((base.endsWith("token") || base.endsWith("tokens")) && !modelTokenField);
  const keyMaterial = /(?:api|access|auth|encryption|private|secret|serviceaccount|signing|subscription)keys?$/.test(base) || /^keys?$/.test(base);
  const keyIdentifierMaterial = /(?:aws)?accesskeyids?$/.test(base);
  const namedMaterial = /(?:authorization|credentials?|passwords?|secrets?|cookies?|passphrases?|serviceaccounts?)$/.test(base);
  const containerMaterial = /(?:connectionstrings?|keystores?|p12|pfx|pkcs12)$/.test(base);
  return qualifiedCredentialMaterial || tokenMaterial || keyMaterial || keyIdentifierMaterial || namedMaterial || containerMaterial;
}

function stripMaterialQualifiers(value: string) {
  let base = value;
  while (true) {
    const match = base.match(materialQualifierPattern);
    if (!match || match[0].length === base.length) return base;
    base = base.slice(0, -match[0].length);
  }
}

function visitNonSecretConfig(value: unknown) {
  if (Array.isArray(value)) {
    for (const entry of value) visitNonSecretConfig(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (isCredentialFieldName(key, entry)) throw new NonSecretConfigError(key);
    visitNonSecretConfig(entry);
  }
}
