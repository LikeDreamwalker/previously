import { describe, it, expect, afterEach } from "vitest";
import { demoModelLock, DEMO_LOCK_DEFAULT_MODEL } from "@/lib/demo/model-lock";

const SAVED_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...SAVED_ENV };
});

describe("demoModelLock", () => {
  it("returns null outside demo mode", () => {
    process.env.STORAGE = "github";
    process.env.DEMO_LOCK = "1";
    expect(demoModelLock()).toBeNull();
    process.env.STORAGE = "local";
    expect(demoModelLock()).toBeNull();
  });

  it("returns null in demo mode without DEMO_LOCK (self-hosted deployments stay unlocked)", () => {
    process.env.STORAGE = "demo";
    delete process.env.DEMO_LOCK;
    expect(demoModelLock()).toBeNull();
  });

  it("locks to the cheapest vision-capable DeepSeek tier when DEMO_LOCK=1", () => {
    process.env.STORAGE = "demo";
    process.env.DEMO_LOCK = "1";
    delete process.env.DEMO_MODEL;
    delete process.env.DEMO_EFFORT;
    expect(demoModelLock()).toEqual({
      model: DEMO_LOCK_DEFAULT_MODEL,
      thinking: true,
      effort: "low",
    });
  });

  it("honors DEMO_MODEL / DEMO_EFFORT overrides", () => {
    process.env.STORAGE = "demo";
    process.env.DEMO_LOCK = "true";
    process.env.DEMO_MODEL = "deepseek-v4-flash";
    process.env.DEMO_EFFORT = "high";
    expect(demoModelLock()).toEqual({
      model: "deepseek-v4-flash",
      thinking: true,
      effort: "high",
    });
  });

  it("rejects an invalid DEMO_EFFORT back to low", () => {
    process.env.STORAGE = "demo";
    process.env.DEMO_LOCK = "1";
    delete process.env.DEMO_MODEL;
    process.env.DEMO_EFFORT = "extreme";
    expect(demoModelLock()?.effort).toBe("low");
  });
});
