import { describe, it, expect } from "vitest";
import { classifySeam } from "@/lib/chat/seam";

describe("classifySeam (design §1.4)", () => {
  it("time_cap / capacity closes are checkpoint seams (autosave, conversation continues)", () => {
    expect(classifySeam("time_cap")).toBe("checkpoint");
    expect(classifySeam("capacity")).toBe("checkpoint");
  });

  it("idle_gap / context_lost closes are genuine boundaries", () => {
    expect(classifySeam("idle_gap")).toBe("boundary");
    expect(classifySeam("context_lost")).toBe("boundary");
  });

  it("legacy and unknown close reasons fall back to boundary", () => {
    expect(classifySeam("time_silence")).toBe("boundary");
    expect(classifySeam("user_explicit")).toBe("boundary");
    expect(classifySeam("something-new")).toBe("boundary");
  });

  it("a missing closed_by (oldest slice / migrated data) is a boundary", () => {
    expect(classifySeam(undefined)).toBe("boundary");
    expect(classifySeam(null)).toBe("boundary");
  });
});
