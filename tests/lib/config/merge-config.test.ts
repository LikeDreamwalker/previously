import { describe, it, expect } from "vitest";
import { mergeConfigOverrides } from "@/lib/config/defaults";
import type { UserConfig } from "@/lib/config/types";

const current: UserConfig = {
  slicing: { maxSliceMinutes: 30, maxTurnsPerSlice: 50 },
  model: {
    provider: "deepseek-v4-flash",
    thinking: true,
    reasoningEffort: "low",
  },
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
    // The existing model/slicing must survive untouched.
    expect(result.model.provider).toBe("deepseek-v4-flash");
    expect(result.model.reasoningEffort).toBe("low");
    expect(result.slicing.maxSliceMinutes).toBe(30);
    expect(result.slicing.maxTurnsPerSlice).toBe(50);
  });

  it("deep-merges nested overrides while keeping untouched siblings", () => {
    const result = mergeConfigOverrides(current, {
      model: { provider: "deepseek-v4-pro" },
    });
    expect(result.model.provider).toBe("deepseek-v4-pro");
    expect(result.model.thinking).toBe(true); // sibling survives
    expect(result.onboarded).toBe(false); // untouched top-level stays
  });
});
