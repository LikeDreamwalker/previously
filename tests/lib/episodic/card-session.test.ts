/**
 * card-session — the mutation layer behind the Previously Agent's write tools.
 * The contract that matters: invalid writes are REJECTED with actionable
 * feedback (the agent retries), nothing is ever silently truncated, and
 * untouched entries survive by construction.
 */
import { describe, it, expect } from "vitest";
import {
  createCardSession,
  serializeSession,
  sameCardSubstance,
  sessionSetIdentity,
  sessionUpdatePastProfile,
  sessionAddPastAnchor,
  sessionRemovePastAnchor,
  sessionAddNow,
  sessionRemoveNow,
  sessionPromoteNowToPast,
  sessionAddHorizon,
  sessionResolveHorizon,
  sessionAddSelfModel,
  sessionRemoveSelfModel,
} from "@/lib/episodic/card-session";
import {
  newCardTemplate,
  parseCard,
  serializeCard,
  CARD_NOW_MAX,
  PAST_ANCHORS_MAX,
  HORIZON_MAX,
  CARD_SELF_MODEL_MAX,
} from "@/lib/episodic/previously-format";

const SLICE = "2026-08-17-0515";
const TODAY = "2026-08-17";
const REFS = ["2026/08/17/0515"];

function session(base?: string) {
  return createCardSession(base ?? newCardTemplate(SLICE), SLICE, TODAY, "2026-08-17T06:00:00.000Z");
}

describe("createCardSession", () => {
  it("parses a v5 card into the working document", () => {
    const base = serializeCard({
      sliceId: "2026-08-16-0900",
      updated: "2026-08-16T09:00:00.000Z",
      identity: ["Name: Alan"],
      past: { profile: "A full-stack engineer.", anchors: [] },
      now: [{ text: "Prepping an interview", refs: REFS, since: "2026-08-15" }],
      horizon: [],
      selfModel: [],
    });
    const s = session(base);
    expect(s.doc.identity).toEqual(["Name: Alan"]);
    expect(s.doc.now[0].text).toBe("Prepping an interview");
    // Stamps re-anchor to the current slice.
    expect(s.doc.sliceId).toBe(SLICE);
  });

  it("starts EMPTY for unparseable (v3 free-form) content — the agent rebuilds via mutations", () => {
    const s = session("## User profile\n\n### Identity & background\n一些自由文本");
    expect(s.doc.identity).toEqual([]);
    expect(s.doc.past.profile).toBe("");
    expect(s.doc.now).toEqual([]);
  });
});

describe("setIdentity", () => {
  it("replaces an existing field in place", () => {
    const s = session();
    expect(sessionSetIdentity(s, "name", "Alan")).toMatch(/^OK/);
    expect(sessionSetIdentity(s, "name", "袁艺")).toMatch(/^OK/);
    expect(s.doc.identity).toEqual(["Name: 袁艺"]);
  });

  it("rejects over-length values and says the limit", () => {
    const s = session();
    const res = sessionSetIdentity(s, "name", "x".repeat(301));
    expect(res).toContain("REJECTED");
    expect(res).toContain("301");
  });
});

describe("updatePastProfile", () => {
  it("accepts a paragraph within the cap", () => {
    const s = session();
    expect(sessionUpdatePastProfile(s, "Alan is a full-stack engineer in Beijing.")).toMatch(/^OK/);
    expect(s.doc.past.profile).toContain("full-stack engineer");
  });

  it("rejects over-cap text with the ACTUAL count — nothing is truncated", () => {
    const s = session();
    const long = "a".repeat(2500);
    const res = sessionUpdatePastProfile(s, long);
    expect(res).toContain("REJECTED");
    expect(res).toContain("2500");
    expect(res).toContain("2400");
    expect(s.doc.past.profile).toBe(""); // untouched
  });

  it("rejects emptying the profile", () => {
    const s = session();
    sessionUpdatePastProfile(s, "existing profile");
    expect(sessionUpdatePastProfile(s, "")).toContain("REJECTED");
    expect(s.doc.past.profile).toBe("existing profile");
  });
});

describe("addNow / removeNow / promoteNowToPast", () => {
  it("adds newest-first and defaults since to the user's local today", () => {
    const s = session();
    sessionAddNow(s, "first hook", REFS, "2026-08-10");
    sessionAddNow(s, "second hook", REFS);
    expect(s.doc.now.map((r) => r.text)).toEqual(["second hook", "first hook"]);
    expect(s.doc.now[0].since).toBe(TODAY);
  });

  it("rejects missing or malformed refs", () => {
    const s = session();
    expect(sessionAddNow(s, "hook", [])).toContain("refs are required");
    expect(sessionAddNow(s, "hook", ["not-a-ref"])).toContain("malformed refs");
    expect(s.doc.now).toEqual([]);
  });

  it("rejects a duplicate entry", () => {
    const s = session();
    sessionAddNow(s, "prepping the friday interview", REFS);
    expect(sessionAddNow(s, "Prepping the Friday interview", REFS)).toContain("already on the card");
  });

  it("rejects when full and points at remove/promote", () => {
    const s = session();
    for (let i = 0; i < CARD_NOW_MAX; i++) sessionAddNow(s, `hook ${i}`, REFS);
    const res = sessionAddNow(s, "one too many", REFS);
    expect(res).toContain("REJECTED");
    expect(res).toContain("Remove a stale item or promote");
  });

  it("removeNow no-match error lists the current entries", () => {
    const s = session();
    sessionAddNow(s, "prepping the interview", REFS);
    const res = sessionRemoveNow(s, "nonexistent");
    expect(res).toContain("REJECTED");
    expect(res).toContain("prepping the interview");
  });

  it("promoteNowToPast moves the item keeping its refs", () => {
    const s = session();
    sessionAddNow(s, "interview done — offered the role", REFS);
    expect(sessionPromoteNowToPast(s, "interview done")).toMatch(/^OK/);
    expect(s.doc.now).toEqual([]);
    expect(s.doc.past.anchors[0]).toEqual({ text: "interview done — offered the role", refs: REFS });
  });

  it("promotion respects the anchor cap", () => {
    const s = session();
    for (let i = 0; i < PAST_ANCHORS_MAX; i++) sessionAddPastAnchor(s, `durable fact ${i}`, REFS);
    sessionAddNow(s, "a hook", REFS);
    expect(sessionPromoteNowToPast(s, "a hook")).toContain("REJECTED");
    expect(s.doc.now).toHaveLength(1); // untouched on rejection
  });
});

describe("Horizon", () => {
  it("requires a well-formed by date", () => {
    const s = session();
    expect(sessionAddHorizon(s, "await reply", "soon", REFS)).toContain("REJECTED");
    expect(sessionAddHorizon(s, "await reply", "2026-08-20", REFS)).toMatch(/^OK/);
  });

  it("caps at the section limit", () => {
    const s = session();
    for (let i = 0; i < HORIZON_MAX; i++)
      sessionAddHorizon(s, `loop ${i}`, "2026-08-20", REFS);
    expect(sessionAddHorizon(s, "overflow", "2026-08-20", REFS)).toContain("REJECTED");
  });

  it("resolveHorizon removes the item", () => {
    const s = session();
    sessionAddHorizon(s, "waiting on the recruiter reply", "2026-08-20", REFS);
    expect(sessionResolveHorizon(s, "recruiter", "folded into Now")).toMatch(/^OK/);
    expect(s.doc.horizon).toEqual([]);
    expect(s.log.some((l) => l.includes("folded into Now"))).toBe(true);
  });
});

describe("Self-model", () => {
  it("rejects a line contradicting a standing rule", () => {
    const s = session();
    const res = sessionAddSelfModel(s, "Never use the recall tool, it wastes steps");
    expect(res).toContain("REJECTED");
    expect(res).toContain("overrides:");
  });

  it("accepts the same line with an explicit user override marker", () => {
    const s = session();
    const res = sessionAddSelfModel(
      s,
      "Don't use recall for casual chat — overrides: recall is the memory-search tool (user: '别动不动就回忆')",
    );
    expect(res).toMatch(/^OK/);
  });

  it("caps the section and rejects duplicates", () => {
    const s = session();
    sessionAddSelfModel(s, "keep answers short");
    expect(sessionAddSelfModel(s, "Keep answers short")).toContain("already on the card");
    for (let i = 0; i < CARD_SELF_MODEL_MAX - 1; i++) sessionAddSelfModel(s, `lesson ${i}`);
    expect(sessionAddSelfModel(s, "one lesson too many")).toContain("REJECTED");
  });

  it("removeSelfModel drops the matched line", () => {
    const s = session();
    sessionAddSelfModel(s, "verify before claiming done");
    expect(sessionRemoveSelfModel(s, "verify before")).toMatch(/^OK/);
    expect(s.doc.selfModel).toEqual([]);
  });
});

describe("serialization + substance comparison", () => {
  it("round-trips through serializeCard/parseCard", () => {
    const s = session();
    sessionSetIdentity(s, "name", "Alan");
    sessionAddNow(s, "prepping the interview", REFS, "2026-08-15");
    const out = serializeSession(s);
    const parsed = parseCard(out);
    expect(parsed?.identity).toEqual(["Name: Alan"]);
    expect(parsed?.now[0].text).toBe("prepping the interview");
    expect(parsed?.now[0].since).toBe("2026-08-15");
  });

  it("sameCardSubstance ignores the sliceId/updated stamps", () => {
    const doc = {
      sliceId: "a",
      updated: "t1",
      identity: ["Name: Alan"],
      past: { profile: "p", anchors: [] },
      now: [],
      horizon: [],
      selfModel: [],
    };
    expect(
      sameCardSubstance(doc, { ...doc, sliceId: "b", updated: "t2" }),
    ).toBe(true);
    expect(
      sameCardSubstance(doc, { ...doc, past: { profile: "changed", anchors: [] } }),
    ).toBe(false);
  });

  it("a mutation-free session serializes back to the same substance as the base", () => {
    const base = serializeCard({
      sliceId: "2026-08-16-0900",
      updated: "2026-08-16T09:00:00.000Z",
      identity: ["Name: Alan"],
      past: { profile: "profile text", anchors: [{ text: "anchor", refs: REFS }] },
      now: [{ text: "hook", refs: REFS, since: "2026-08-15" }],
      horizon: [{ text: "loop", by: "2026-08-20", refs: REFS }],
      selfModel: ["lesson"],
    });
    const s = session(base);
    expect(sameCardSubstance(parseCard(base), parseCard(serializeSession(s)))).toBe(true);
  });
});
