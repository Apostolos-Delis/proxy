export type EnvironmentSecretReferenceConfig = {
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
};

export type SecretReferenceInput = {
  reference: string;
  provider: string;
  baseUrl: string;
};

export function createEnvironmentSecretReferenceResolver(
  config: EnvironmentSecretReferenceConfig,
  environment: Record<string, string | undefined> = process.env
) {
  return (input: SecretReferenceInput) => {
    const name = input.reference.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
    const targetOrigin = urlOrigin(input.baseUrl);
    if (!name || !targetOrigin) return undefined;

    const builtIn = builtInSecret(name, config);
    if (builtIn?.value && urlOrigin(builtIn.baseUrl) === targetOrigin) return builtIn.value;

    const value = environment[name];
    const allowedOrigins = environment[`${name}_ALLOWED_ORIGINS`];
    if (!value || !allowedOrigins) return undefined;
    const allowed = allowedOrigins.split(",")
      .map((entry) => urlOrigin(entry.trim()))
      .filter((entry): entry is string => Boolean(entry));
    return allowed.includes(targetOrigin) ? value : undefined;
  };
}

function builtInSecret(name: string, config: EnvironmentSecretReferenceConfig) {
  if (name === "OPENAI_API_KEY") {
    return { value: config.openaiApiKey, baseUrl: config.openaiBaseUrl };
  }
  if (name === "ANTHROPIC_API_KEY") {
    return { value: config.anthropicApiKey, baseUrl: config.anthropicBaseUrl };
  }
  return undefined;
}

function urlOrigin(value: string | undefined) {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
