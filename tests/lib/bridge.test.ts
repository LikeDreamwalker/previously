/**
 * runBridge protocol handling — the shared spawn helper behind delegateTask
 * and the bridge main model. Uses fixture node scripts as fake bridge CLIs
 * (same pattern as tests/app/api/agent/delegate-task.test.ts):
 *   - protocol 2 NDJSON: live {"event": ...} lines + final envelope
 *   - protocol 2 batch: a single envelope line (events flushed at completion)
 *   - legacy plain-text fallback (old CLIs) incl. the 30k cap
 *   - the raised 512k cap for protocol-2 envelope results
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  runBridge,
  splitBridgeCommand,
  BRIDGE_MAX_OUTPUT_CHARS,
  BRIDGE_MAX_RESULT_CHARS_V2,
  type BridgeEvent,
} from "@/lib/bridge";

const FIXTURES = fileURLToPath(
  new URL("../app/api/agent/fixtures", import.meta.url),
);

function bridgeArgv(fixture: string): string[] {
  return splitBridgeCommand(`"${process.execPath}" "${join(FIXTURES, fixture)}"`);
}

const PAYLOAD = JSON.stringify({ task: "t", context: null, protocol: 2 });

describe("runBridge protocol 2", () => {
  it("streams live event lines to onEvent and settles on the final envelope", async () => {
    const live: BridgeEvent[] = [];
    const result = await runBridge(
      bridgeArgv("bridge-proto2.mjs"),
      PAYLOAD,
      10_000,
      undefined,
      (e) => live.push(e),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.result).toBe("the final answer");
    // Two events streamed live; the envelope echoes the SAME events — the
    // already-streamed prefix is skipped, not double-reported.
    expect(live).toEqual([
      { name: "Read", summary: "Read memory/2026-08-22-0340.md", status: "start" },
      { name: "Read", summary: "Read memory/2026-08-22-0340.md", status: "ok" },
    ]);
    expect(result.events).toEqual(live);
  });

  it("accepts a batch envelope (no live lines) and flushes its events at completion", async () => {
    const live: BridgeEvent[] = [];
    const result = await runBridge(
      bridgeArgv("bridge-proto2-batch.mjs"),
      PAYLOAD,
      10_000,
      undefined,
      (e) => live.push(e),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.result).toBe("batched result");
    expect(result.events).toEqual([
      { name: "Bash", summary: "Bash pnpm test", status: "ok" },
      { name: "Read", summary: "Read output.log", status: "error" },
    ]);
    // Batch fallback: envelope events are flushed to onEvent at completion.
    expect(live).toEqual(result.events);
  });

  it("applies the raised 512k cap to protocol-2 envelope results", async () => {
    const result = await runBridge(
      bridgeArgv("bridge-proto2-big.mjs"),
      PAYLOAD,
      10_000,
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.result.length).toBeGreaterThan(BRIDGE_MAX_RESULT_CHARS_V2);
    expect(result.result.startsWith("x".repeat(100))).toBe(true);
    expect(result.result).toContain(
      `(Truncated at ${BRIDGE_MAX_RESULT_CHARS_V2} characters)`,
    );
  });
});

describe("runBridge legacy protocol 1", () => {
  it("treats plain-text stdout as the result (old CLIs, no events)", async () => {
    const live: BridgeEvent[] = [];
    const result = await runBridge(
      bridgeArgv("bridge-ok.mjs"),
      PAYLOAD,
      10_000,
      undefined,
      (e) => live.push(e),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.result).toBe("ok:t|ctx:null");
    expect(result.events).toBeUndefined();
    expect(live).toEqual([]);
  });

  it("keeps the 30k cap for legacy plain-text output", async () => {
    const result = await runBridge(
      bridgeArgv("bridge-legacy-big.mjs"),
      PAYLOAD,
      10_000,
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.result).toContain(
      `(Truncated at ${BRIDGE_MAX_OUTPUT_CHARS} characters)`,
    );
    expect(result.result.length).toBeLessThan(31_000);
  });

  it("does not mistake an echoed payload (protocol field, no result) for an envelope", async () => {
    const result = await runBridge(
      bridgeArgv("bridge-echo-payload.mjs"),
      PAYLOAD,
      10_000,
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const echoed = JSON.parse(result.result);
    expect(echoed).toEqual({ task: "t", context: null, protocol: 2 });
  });
});
