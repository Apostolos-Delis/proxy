import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PromptCachePlans } from "./cachingAnatomyPanels";
import type { PromptCachePlanReport } from "./cachingData";

describe("PromptCachePlans", () => {
  it("renders applied and skipped control rows", () => {
    const html = renderToStaticMarkup(<PromptCachePlans report={{
      totalPlans: 3,
      sampled: true,
      plans: [
        { provider: "openai", model: "gpt-5.5", mode: "implicit", count: 2, appliedControls: 3, skippedControls: 1 }
      ],
      controls: [
        { provider: "openai", model: "gpt-5.5", mode: "implicit", control: "implicit_prefix_caching", status: "applied", reason: "none", count: 2 },
        { provider: "openai", model: "gpt-5.5", mode: "implicit", control: "cross_dialect_cache_fields", status: "skipped", reason: "translated_request", count: 1 }
      ]
    } satisfies PromptCachePlanReport} />);

    expect(html).toContain("Prompt-cache plans");
    expect(html).toContain("implicit prefix");
    expect(html).toContain("cross-dialect fields");
    expect(html).toContain("skipped");
    expect(html).toContain("translated");
    expect(html).toContain("window truncated");
  });

  it("renders an empty state", () => {
    const html = renderToStaticMarkup(<PromptCachePlans report={{
      totalPlans: 0,
      sampled: false,
      plans: [],
      controls: []
    }} />);

    expect(html).toContain("No prompt-cache plans in this window.");
  });
});
