import type { ProviderName } from "./providers/data";

export const PROVIDER_OPTIONS: { value: ProviderName; label: string }[] = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai", label: "OpenAI" }
];

export const PROVIDER_ORDER: ProviderName[] = PROVIDER_OPTIONS.map((option) => option.value);
