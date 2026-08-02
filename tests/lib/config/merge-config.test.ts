import { describe, it, expect } from "vitest";
import { mergeConfigOverrides } from "@/lib/config/defaults";
import type { UserConfig } from "@/lib/config/types";

const current: UserConfig = {
  slicing: { maxTurnsPerSlice: 20, timeSilenceMinutes: 15 },
  context: { recentTurnsLimit: 20 },
  model: {
    provider: "deepseek-v4-flash",
    thinking: true,
    reasoningEffort: "low",
  },
  worker: { mode: "manual", provider: "deepseek-v4-flash" },
  onboarded: false,
  datasource: "demo",
};

describe("mergeConfigOverrides", () => {
  it("persists top-level fields without clobbering nested config", () => {
    const result = mergeConfigOverrides(current, {
      onboarded: true,
      datasource: "own",
    });
    expect(result.onboarded).toBe(true);
    expect(result.datasource).toBe("own");
    // The existing model/worker/slicing/context must survive untouched.
    expect(result.model.provider).toBe("deepseek-v4-flash");
    expect(result.model.reasoningEffort).toBe("low");
    expect(result.worker.mode).toBe("manual");
    expect(result.slicing.maxTurnsPerSlice).toBe(20);
    expect(result.context.recentTurnsLimit).toBe(20);
  });

  it("deep-merges nested overrides while keeping untouched siblings", () => {
    const result = mergeConfigOverrides(current, {
      model: { provider: "deepseek-v4-pro" },
      worker: { mode: "auto" },
    });
    expect(result.model.provider).toBe("deepseek-v4-pro");
    expect(result.model.thinking).toBe(true); // sibling survives
    expect(result.worker.mode).toBe("auto");
    expect(result.worker.provider).toBe("deepseek-v4-flash"); // sibling survives
    expect(result.onboarded).toBe(false); // untouched top-level stays
  });
});
