import { describe, it, expect } from "vitest";
import {
  modeFromPathname,
  parseAtParam,
  stripAtParam,
  timelineHref,
} from "@/lib/chat/mode-switch";

describe("modeFromPathname", () => {
  it("maps /timeline to timeline mode, everything else to chat", () => {
    expect(modeFromPathname("/timeline")).toBe("timeline");
    expect(modeFromPathname("/timeline/")).toBe("timeline");
    expect(modeFromPathname("/")).toBe("chat");
    expect(modeFromPathname("/settings")).toBe("chat");
    // A same-prefix sibling route must not match.
    expect(modeFromPathname("/timeline-x")).toBe("chat");
  });
});

describe("parseAtParam", () => {
  it("extracts the slice id", () => {
    expect(parseAtParam("?at=2026-08-01-1000")).toBe("2026-08-01-1000");
    expect(parseAtParam("at=2026-08-01-1000")).toBe("2026-08-01-1000");
    expect(parseAtParam("?persona=user&at=abc")).toBe("abc");
  });

  it("treats missing / blank / 'now' as no anchor", () => {
    expect(parseAtParam("")).toBeNull();
    expect(parseAtParam("?at=")).toBeNull();
    expect(parseAtParam("?at=now")).toBeNull();
    expect(parseAtParam("?at=%20")).toBeNull();
  });

  it("decodes encoded ids", () => {
    expect(parseAtParam("?at=a%20b")).toBe("a b");
  });
});

describe("stripAtParam", () => {
  it("removes only at and keeps the rest", () => {
    expect(stripAtParam("?at=x&persona=user")).toBe("?persona=user");
    expect(stripAtParam("?persona=user&at=x")).toBe("?persona=user");
    expect(stripAtParam("?at=x")).toBe("");
    expect(stripAtParam("")).toBe("");
  });
});

describe("timelineHref", () => {
  it("carries the anchor when present", () => {
    expect(timelineHref("2026-08-01-1000")).toBe("/timeline?at=2026-08-01-1000");
    expect(timelineHref("a b")).toBe("/timeline?at=a%20b");
  });

  it("falls back to the bare route without an anchor", () => {
    expect(timelineHref(null)).toBe("/timeline");
  });
});
