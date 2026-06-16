import { describe, expect, it } from "vitest";

import {
  authTypeForMode,
  canVisitStep,
  credentialBlockerMessage,
  initialProviderCredentialDraft,
  nextStepId,
  prevStepId,
  stepBlockerMessage,
  stepRailState,
  withCredentialMode,
  withCredentialSource,
  type CreateProviderCredentialDraft
} from "./createCredentialWizard";

function draftAt(
  stepId: CreateProviderCredentialDraft["stepId"],
  overrides: Partial<CreateProviderCredentialDraft> = {}
): CreateProviderCredentialDraft {
  return {
    ...initialProviderCredentialDraft(),
    stepId,
    name: "My credential",
    apiKey: "sk-ant-api03-secret",
    ...overrides
  };
}

describe("initialProviderCredentialDraft", () => {
  it("starts with the API key flow on the type step", () => {
    const draft = initialProviderCredentialDraft();
    expect(draft.stepId).toBe("type");
    expect(draft.mode).toBe("api_key");
    expect(draft.provider).toBe("anthropic");
    expect(draft.name).toBe("");
  });
});

describe("withCredentialMode", () => {
  it("pins Claude subscription credentials to Anthropic", () => {
    const next = withCredentialMode(draftAt("type", { provider: "openai" }), "claude_subscription");
    expect(next.provider).toBe("anthropic");
    expect(next.source).toBe("local_auth");
    expect(authTypeForMode(next.mode)).toBe("oauth");
  });

  it("pins Codex subscription credentials to OpenAI", () => {
    const next = withCredentialMode(draftAt("type"), "codex_subscription");
    expect(next.provider).toBe("openai");
    expect(next.source).toBe("openai_oauth");
    expect(authTypeForMode(next.mode)).toBe("oauth");
  });

  it("clears subscription-only state when returning to API keys", () => {
    const next = withCredentialMode(draftAt("type", {
      mode: "codex_subscription",
      source: "openai_oauth",
      apiKey: "codex-token",
      chatgptAccountId: "acct_1"
    }), "api_key");
    expect(next.apiKey).toBe("");
    expect(next.chatgptAccountId).toBe("");
    expect(next.source).toBe("manual");
  });

  it("preserves source when switching between subscription modes", () => {
    const next = withCredentialMode(draftAt("type", {
      mode: "codex_subscription",
      source: "manual"
    }), "claude_subscription");
    expect(next.source).toBe("manual");
  });

  it("clears stale secrets when switching credential modes", () => {
    const next = withCredentialMode(draftAt("type", {
      mode: "api_key",
      apiKey: "sk-ant-api03-secret"
    }), "codex_subscription");
    expect(next.apiKey).toBe("");
    expect(next.chatgptAccountId).toBe("");
  });
});

describe("withCredentialSource", () => {
  it("clears pasted subscription secrets when switching to local auth", () => {
    const next = withCredentialSource(draftAt("credentials", {
      mode: "codex_subscription",
      source: "manual",
      apiKey: "codex-token",
      chatgptAccountId: "acct_1"
    }), "local_auth");
    expect(next.apiKey).toBe("");
    expect(next.chatgptAccountId).toBe("");
  });

  it("clears pasted Codex state when switching to OpenAI sign-in", () => {
    const next = withCredentialSource(draftAt("credentials", {
      mode: "codex_subscription",
      source: "manual",
      apiKey: "codex-token",
      chatgptAccountId: "acct_1"
    }), "openai_oauth");
    expect(next.apiKey).toBe("");
    expect(next.chatgptAccountId).toBe("");
  });
});

describe("stepBlockerMessage", () => {
  it("blocks Claude subscription mode while subscription auth is disabled", () => {
    const draft = draftAt("type", { mode: "claude_subscription", provider: "anthropic" });
    expect(stepBlockerMessage(draft, false)).toBe("Enable subscription auth before creating Claude subscription credentials.");
    expect(stepBlockerMessage(draft, true)).toBeNull();
  });

  it("allows Codex subscription mode while subscription auth is disabled", () => {
    const draft = draftAt("type", { mode: "codex_subscription", provider: "openai" });
    expect(stepBlockerMessage(draft, false)).toBeNull();
  });

  it("validates credential fields only on the credentials step", () => {
    expect(stepBlockerMessage(draftAt("type", { name: "", apiKey: "" }), true)).toBeNull();
    expect(stepBlockerMessage(draftAt("credentials", { name: "" }), true)).toBe("Enter a credential label.");
    expect(stepBlockerMessage(draftAt("credentials", { apiKey: "" }), true)).toBe("API key is required.");
  });
});

describe("credentialBlockerMessage", () => {
  it("blocks Claude subscription credentials while subscription auth is disabled", () => {
    const draft = draftAt("credentials", {
      mode: "claude_subscription",
      provider: "anthropic",
      apiKey: "sk-ant-oat01-secret"
    });
    expect(credentialBlockerMessage(draft, false)).toBe("Claude subscription auth has been disabled for this proxy.");
  });

  it("allows Codex subscription credentials while subscription auth is disabled", () => {
    const draft = draftAt("credentials", {
      mode: "codex_subscription",
      provider: "openai",
      source: "manual",
      apiKey: "codex-token",
      chatgptAccountId: "acct_1"
    });
    expect(credentialBlockerMessage(draft, false)).toBeNull();
  });

  it("does not require pasted tokens for local auth subscriptions", () => {
    const draft = draftAt("credentials", {
      mode: "codex_subscription",
      provider: "openai",
      source: "local_auth",
      apiKey: "",
      chatgptAccountId: ""
    });
    expect(credentialBlockerMessage(draft, true)).toBeNull();
  });

  it("does not require pasted tokens for OpenAI sign-in", () => {
    const draft = draftAt("credentials", {
      mode: "codex_subscription",
      provider: "openai",
      source: "openai_oauth",
      apiKey: "",
      chatgptAccountId: ""
    });
    expect(credentialBlockerMessage(draft, true)).toBeNull();
  });

  it("requires Claude setup-token prefixes", () => {
    const draft = draftAt("credentials", {
      mode: "claude_subscription",
      provider: "anthropic",
      source: "manual",
      apiKey: "sk-ant-api03-not-a-subscription"
    });
    expect(credentialBlockerMessage(draft, true)).toBe("Claude setup tokens start with sk-ant-oat01-");
  });

  it("allows Codex auth JSON to carry the ChatGPT account ID", () => {
    const draft = draftAt("credentials", {
      mode: "codex_subscription",
      provider: "openai",
      source: "manual",
      apiKey: JSON.stringify({ access_token: "token", chatgpt_account_id: "acct_1" }),
      chatgptAccountId: ""
    });
    expect(credentialBlockerMessage(draft, true)).toBeNull();
  });

  it("allows Codex auth JSON to carry the ChatGPT account ID under tokens", () => {
    const draft = draftAt("credentials", {
      mode: "codex_subscription",
      provider: "openai",
      source: "manual",
      apiKey: JSON.stringify({ tokens: { access_token: "token", account_id: "acct_1" } }),
      chatgptAccountId: ""
    });
    expect(credentialBlockerMessage(draft, true)).toBeNull();
  });

  it("allows Codex auth JSON to carry the ChatGPT account ID inside an id token", () => {
    const draft = draftAt("credentials", {
      mode: "codex_subscription",
      provider: "openai",
      source: "manual",
      apiKey: JSON.stringify({
        tokens: { access_token: "token", id_token: fakeJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" }
        }) }
      }),
      chatgptAccountId: ""
    });
    expect(credentialBlockerMessage(draft, true)).toBeNull();
  });

  it("requires a ChatGPT account ID for raw Codex access tokens", () => {
    const draft = draftAt("credentials", {
      mode: "codex_subscription",
      provider: "openai",
      source: "manual",
      apiKey: "codex-token",
      chatgptAccountId: ""
    });
    expect(credentialBlockerMessage(draft, true)).toBe("ChatGPT account ID is required unless the auth JSON includes one.");
  });

  it("rejects invalid Codex auth JSON before submit", () => {
    const draft = draftAt("credentials", {
      mode: "codex_subscription",
      provider: "openai",
      source: "manual",
      apiKey: "{",
      chatgptAccountId: "acct_1"
    });
    expect(credentialBlockerMessage(draft, true)).toBe("Paste valid Codex auth JSON or a raw access token.");
  });

  it("requires Codex auth JSON to include an access token", () => {
    const draft = draftAt("credentials", {
      mode: "codex_subscription",
      provider: "openai",
      source: "manual",
      apiKey: JSON.stringify({ chatgpt_account_id: "acct_1" }),
      chatgptAccountId: ""
    });
    expect(credentialBlockerMessage(draft, true)).toBe("Codex auth JSON must include an access token.");
  });
});

function fakeJwt(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("step navigation", () => {
  it("walks forward and backward through the provider credential steps", () => {
    expect(nextStepId("type")).toBe("credentials");
    expect(nextStepId("credentials")).toBe("review");
    expect(nextStepId("review")).toBe("bind");
    expect(nextStepId("bind")).toBeNull();
    expect(prevStepId("bind")).toBe("review");
    expect(prevStepId("type")).toBeNull();
  });

  it("locks the wizard to bind after creation", () => {
    const draft = draftAt("bind");
    expect(canVisitStep("credentials", draft, true)).toBe(false);
    expect(canVisitStep("bind", draft, true)).toBe(true);
    expect(stepRailState("credentials", "bind", true)).toBe("complete");
  });
});
