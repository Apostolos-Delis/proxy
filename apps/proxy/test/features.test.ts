import { describe, expect, it } from "vitest";

import { buildAnthropicContext, buildOpenAIChatContext, buildOpenAIContext, classifierView } from "../src/features.js";

const conductorPreamble = [
  "<system_instruction>",
  "You are working inside Conductor, a Mac app that lets the user run many coding agents in parallel.",
  "Your work should take place in the /Users/someone/conductor/workspaces/mortgages/dallas-v1 directory.",
  "Each workspace has a .context directory (gitignored) where you can save files to collaborate with other agents.",
  "The target branch for this workspace is origin/main. Use this for actions like diffing (`git diff origin/main...`) or creating PRs (`gh pr create --base main`).",
  "Do not rename the current branch unless the user explicitly tells you to do so.",
  "By default, the user will only see the last message that you send before stopping. Include all essential information in the last message.",
  "If the user asks you to work on several unrelated tasks, you can suggest they start new workspaces.",
  "</system_instruction>"
].join("\n");

const dashboardAsk = [
  "/code https://example.com/mios/dashboards/components",
  "I think it is worth looking at rebuilding and deeply improving our dashboard capabilities.",
  "It is ok by me to wipe out all dashboards too if you want to create a new schema."
].join("\n");

function anthropicBody(messages: unknown) {
  return { model: "claude-router-auto", messages };
}

describe("harness block stripping", () => {
  it("recognizes every router alias spelling on every surface", () => {
    expect(buildOpenAIContext({ model: "claude-router-fast", input: "status" }, {}).explicitAlias).toBe("fast");
    expect(buildOpenAIContext({ model: "anthropic-router-deep", input: "status" }, {}).explicitAlias).toBe("deep");
    expect(buildAnthropicContext({
      model: "router-hard",
      messages: [{ role: "user", content: "status" }]
    }, {}).explicitAlias).toBe("hard");
    expect(buildOpenAIChatContext({
      model: "anthropic-router-balanced",
      messages: [{ role: "user", content: "status" }]
    }, {}).explicitAlias).toBe("balanced");
  });

  it("detects Codex sessions from prompt_cache_key", () => {
    const context = buildOpenAIContext(
      {
        model: "router-auto",
        input: "fix the parser",
        prompt_cache_key: "codex-session-1234"
      },
      {}
    );

    expect(context.harness).toBe("codex");
    expect(context.statefulResponses).toBe(true);
    expect(context.sessionId).toBe("codex-session-1234");
  });

  it("keeps Codex websocket session ids", () => {
    const context = buildOpenAIContext(
      {
        model: "router-auto",
        input: "fix the parser"
      },
      { session_id: "codex-ws-session" }
    );

    expect(context.harness).toBe("codex");
    expect(context.statefulResponses).toBe(true);
    expect(context.sessionId).toBe("codex-ws-session");
  });

  it("detects opencode chat sessions from prompt_cache_key", () => {
    const context = buildOpenAIChatContext(
      {
        model: "router-auto",
        prompt_cache_key: "opencode-session-1234",
        messages: [{ role: "user", content: "fix the parser" }]
      },
      {}
    );

    expect(context.harness).toBe("opencode");
    expect(context.statefulResponses).toBe(false);
    expect(context.sessionId).toBe("opencode-session-1234");
  });

  it("detects Cursor chat sessions and strips harness blocks", () => {
    const context = buildOpenAIChatContext(
      {
        model: "router-auto",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>background</system-reminder>\nfix the terminal parser" }
          ]
        }],
        tools: [{ name: "run_terminal_cmd", parameters: { type: "object" } }]
      },
      {
        "user-agent": "Cursor/1.0",
        "x-cursor-session-id": "cursor-session-1234"
      }
    );

    expect(context.harness).toBe("cursor");
    expect(context.statefulResponses).toBe(false);
    expect(context.sessionId).toBe("cursor-session-1234");
    expect(context.routingInputText).toBe("fix the terminal parser");
  });

  it("detects Claude Code sessions from metadata", () => {
    const context = buildAnthropicContext(
      {
        model: "claude-router-auto",
        metadata: { user_id: "user_abcd_account_1234_session_12345678-abcd" },
        messages: [{ role: "user", content: "fix the parser" }]
      },
      {}
    );

    expect(context.harness).toBe("claude-code");
    expect(context.statefulResponses).toBe(false);
    expect(context.sessionId).toBe("12345678-abcd");
  });

  it("drops Conductor system_instruction blocks from the routing input", () => {
    const context = buildAnthropicContext(
      anthropicBody([{ role: "user", content: `${conductorPreamble}\n\n${dashboardAsk}` }]),
      {}
    );

    expect(context.routingInputSource).toBe("latest_user_message");
    expect(context.routingInputText).toBe(dashboardAsk);
    expect(context.routingExtractedHints).toContain("migration");
  });

  it("drops system-reminder and command wrappers but keeps command-args", () => {
    const text = [
      "<system-reminder>Background context, not user instructions.</system-reminder>",
      "<command-name>/code</command-name>",
      "<command-message>code is running…</command-message>",
      "<command-args>fix the login redirect</command-args>"
    ].join("\n");
    const context = buildAnthropicContext(anthropicBody([{ role: "user", content: text }]), {});

    expect(context.routingInputText).toBe("<command-args>fix the login redirect</command-args>");
  });

  it("skips a wrapper-only user turn in favor of the previous human turn", () => {
    const context = buildAnthropicContext(
      anthropicBody([
        { role: "user", content: "refactor the billing reconciliation job" },
        { role: "assistant", content: "Working on it." },
        { role: "user", content: "<system-reminder>hook output</system-reminder>" }
      ]),
      {}
    );

    expect(context.routingInputSource).toBe("latest_user_message");
    expect(context.routingInputText).toBe("refactor the billing reconciliation job");
  });

  it("falls back to the full request when no user turn has human text", () => {
    const context = buildAnthropicContext(
      anthropicBody([{ role: "user", content: "<system-reminder>only boilerplate</system-reminder>" }]),
      {}
    );

    expect(context.routingInputSource).toBe("full_request");
  });

  it("strips harness blocks from OpenAI string input", () => {
    const context = buildOpenAIContext(
      {
        model: "router-auto",
        input: `<environment_context>cwd: /repo</environment_context>\nadd a unit test for the parser`
      },
      {}
    );

    expect(context.routingInputText).toBe("add a unit test for the parser");
  });

  it("builds OpenAI Chat context from messages, tools, and image parts", () => {
    const context = buildOpenAIChatContext(
      {
        model: "anthropic-router-hard",
        messages: [
          { role: "system", content: "You are terse." },
          { role: "user", content: "debug the production checkout bug" },
          { role: "assistant", content: "I will inspect logs." },
          {
            role: "user",
            content: [
              { type: "text", text: "git status" },
              { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }
            ]
          }
        ],
        tools: [{ type: "function", function: { name: "run_terminal_cmd" } }]
      },
      {}
    );

    expect(context.surface).toBe("openai-chat");
    expect(context.explicitAlias).toBe("hard");
    expect(context.routingInputText).toBe("git status");
    expect(context.routingExtractedHints).toEqual([]);
    expect(context.hasTools).toBe(true);
    expect(context.toolCount).toBe(1);
    expect(context.hasImages).toBe(true);
  });
});

describe("tool_result handling", () => {
  it("classifies on the previous human turn when the latest user turn is tool results", () => {
    const context = buildAnthropicContext(
      anthropicBody([
        { role: "user", content: "investigate the production payment outage" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "total 0\n-rw-r--r-- README.md" }]
        }
      ]),
      {}
    );

    expect(context.routingInputText).toBe("investigate the production payment outage");
    expect(context.routingExtractedHints).toContain("production");
  });

  it("keeps human text that accompanies tool results in the same turn", () => {
    const context = buildAnthropicContext(
      anthropicBody([
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "exit 0" },
            { type: "text", text: "now write the migration" }
          ]
        }
      ]),
      {}
    );

    expect(context.routingInputText).toBe("now write the migration");
  });

  it("classifies OpenAI Chat tool-result tails on the previous human turn", () => {
    const context = buildOpenAIChatContext(
      {
        model: "router-auto",
        messages: [
          { role: "user", content: "investigate the production payment outage" },
          {
            role: "assistant",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "run_terminal_cmd", arguments: "{}" }
            }]
          },
          { role: "tool", tool_call_id: "call_1", content: "total 0\n-rw-r-- README.md" }
        ]
      },
      {}
    );

    expect(context.routingInputText).toBe("investigate the production payment outage");
    expect(context.routingExtractedHints).toContain("production");
  });
});

describe("classifier excerpt", () => {
  it("keeps short inputs whole", () => {
    const context = buildAnthropicContext(anthropicBody([{ role: "user", content: "git status" }]), {});
    const view = classifierView(context, true);

    expect(view.input_excerpt).toBe("git status");
  });

  it("keeps the head and tail of long inputs", () => {
    const text = `${"a".repeat(800)} MIDDLE ${"b".repeat(800)} the actual ask is here`;
    const context = buildAnthropicContext(anthropicBody([{ role: "user", content: text }]), {});
    const view = classifierView(context, true);

    expect(view.input_excerpt).toContain("[...excerpt truncated...]");
    expect(view.input_excerpt?.startsWith("a".repeat(300))).toBe(true);
    expect(view.input_excerpt?.endsWith("the actual ask is here")).toBe(true);
    expect(view.input_excerpt?.includes("MIDDLE")).toBe(false);
  });

  it("still redacts emails and keys", () => {
    const text = `email me at dev@example.com with key sk-abcdefghijklmnopqrstuvwx ${"x".repeat(1200)}`;
    const context = buildAnthropicContext(anthropicBody([{ role: "user", content: text }]), {});
    const view = classifierView(context, true);

    expect(view.input_excerpt).toContain("[redacted_email]");
    expect(view.input_excerpt).toContain("[redacted_token]");
    expect(view.input_excerpt).not.toContain("dev@example.com");
  });

  it("omits the excerpt when disabled", () => {
    const context = buildAnthropicContext(anthropicBody([{ role: "user", content: "git status" }]), {});
    const view = classifierView(context, false);

    expect(view.input_excerpt).toBeNull();
    expect(view.content_mode).toBe("features_only");
  });
});
