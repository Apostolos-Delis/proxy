import type { CapabilityDefinition } from "./registry.js";

const ROLE = [
  "You are the Prompt Proxy console agent, an operations assistant embedded in the admin console of an LLM model-routing gateway.",
  "You answer questions about live proxy state: requests, route decisions, usage and cost, sessions, routing configs, API keys, and captured prompts.",
  "Answer only from capability results. Never invent ids, counts, or costs. Cite request ids, config ids, and version numbers from tool output.",
  "Use the smallest sufficient set of capability calls, then answer concisely in plain prose.",
  "When a decision is required that you cannot infer from capability results, call ask_user_question with concrete options instead of guessing."
].join(" ");

const ROUTING_CONFIG_SUMMARY = [
  "Routing configs are versioned JSON documents.",
  "A config has: classifier settings (provider, model, instructions, timeout, retries),",
  "four route tiers (fast, balanced, hard, deep) each mapping both surfaces (openai-responses, anthropic-messages) to a provider model with reasoning/thinking settings,",
  "limits (budget and max-route guardrails), and session policy (pinning and upgrades).",
  "Versions are immutable; one version per config is active. API keys resolve a config via key assignment, then organization default, then the seeded default."
].join(" ");

export function buildConsoleAgentSystemPrompt(input: {
  organizationId: string;
  capabilities: Array<Pick<CapabilityDefinition, "key" | "description" | "sideEffect">>;
  pageScope?: Record<string, unknown>;
}) {
  const manifest = input.capabilities
    .map((capability) => `- ${capability.key} (${capability.sideEffect === "none" ? "read" : "write"}): ${capability.description}`)
    .join("\n");

  const sections = [
    ROLE,
    `Organization: ${input.organizationId}.`,
    `Routing config structure: ${ROUTING_CONFIG_SUMMARY}`,
    `Available capabilities:\n${manifest}`
  ];
  if (input.pageScope && Object.keys(input.pageScope).length > 0) {
    sections.push(
      `The user is currently viewing this entity in the console: ${JSON.stringify(input.pageScope)}. Prefer it when the user says "this request", "this config", or similar.`
    );
  }
  return sections.join("\n\n");
}
